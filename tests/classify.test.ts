import { describe, expect, it, vi } from "vitest";
import {
  classify,
  classifyOne,
  extractJson,
  parseClassification,
} from "../src/pipeline/classify.js";
import { LlmClient, LlmResponse, estimateCostUsd } from "../src/pipeline/llm.js";
import { CandidateProfile } from "../src/pipeline/prompts.js";
import { Job } from "../src/types.js";

const profile: CandidateProfile = {
  basedIn: "Beirut, Lebanon",
  invoicesFrom: "a Georgian company",
  timezone: "UTC+3",
  workAuthorisation: "no EU authorisation",
};

function job(overrides: Partial<Job> = {}): Job {
  return {
    source: "test",
    company: "Acme",
    title: "Senior Frontend Engineer",
    location: "Remote",
    url: "https://example.com/1",
    postedAt: "2026-02-25T00:00:00Z",
    ...overrides,
  };
}

const VALID = JSON.stringify({
  eligible: true,
  employmentType: "b2b",
  regionConstraint: "",
  confidence: 0.8,
  reason: "The posting places no location restriction.",
});

/** A client whose responses are scripted, so the pipeline is testable offline. */
function fakeClient(responses: (string | Error)[]): LlmClient & { calls: number } {
  let i = 0;
  return {
    provider: "fake",
    model: "fake-1",
    calls: 0,
    async complete(): Promise<LlmResponse> {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      (this as any).calls++;
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return { text: next, inputTokens: 100, outputTokens: 20 };
    },
  };
}

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses an object inside a markdown fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses an object preceded by prose the model added anyway", () => {
    expect(extractJson('Here you go:\n{"a":1}')).toEqual({ a: 1 });
  });

  it("throws when there is no object at all", () => {
    expect(() => extractJson("I cannot answer that")).toThrow();
  });
});

describe("parseClassification", () => {
  it("parses a well-formed response", () => {
    const c = parseClassification(VALID);
    expect(c.eligible).toBe(true);
    expect(c.employmentType).toBe("b2b");
    expect(c.confidence).toBe(0.8);
  });

  it("rejects a response with no boolean verdict, instead of coercing it", () => {
    expect(() => parseClassification('{"eligible":"yes"}')).toThrow(/eligible/);
  });

  it("falls back to unknown for an employment type it does not recognise", () => {
    const c = parseClassification(
      '{"eligible":true,"employmentType":"freelance-ish","confidence":0.5}'
    );
    expect(c.employmentType).toBe("unknown");
  });

  it("clamps confidence into range", () => {
    expect(parseClassification('{"eligible":true,"confidence":5}').confidence).toBe(1);
    expect(parseClassification('{"eligible":true,"confidence":-2}').confidence).toBe(0);
    expect(parseClassification('{"eligible":true,"confidence":"high"}').confidence).toBe(0);
  });

  it("defaults the free-text fields rather than failing on them", () => {
    const c = parseClassification('{"eligible":false}');
    expect(c.regionConstraint).toBe("");
    expect(c.reason).toBe("");
  });
});

describe("classifyOne", () => {
  it("retries a malformed response and succeeds on the retry", async () => {
    const client = fakeClient(["not json at all", VALID]);
    const out = await classifyOne(job(), { client, profile, maxRetries: 2 });
    expect(out.classification.eligible).toBe(true);
    expect(client.calls).toBe(2);
  });

  it("accumulates tokens across retries so cost is not undercounted", async () => {
    const client = fakeClient(["not json", VALID]);
    const out = await classifyOne(job(), { client, profile, maxRetries: 2 });
    expect(out.inputTokens).toBe(200);
  });

  it("gives up after the retry budget", async () => {
    const client = fakeClient(["nope"]);
    await expect(classifyOne(job(), { client, profile, maxRetries: 1 })).rejects.toThrow();
    expect(client.calls).toBe(2);
  });

  it("rejects an unknown prompt version rather than falling back silently", async () => {
    const client = fakeClient([VALID]);
    await expect(
      classifyOne(job(), { client, profile, promptVersion: "v99" })
    ).rejects.toThrow(/unknown prompt version/);
  });

  it("sends the description to the model on v2 and above", async () => {
    const spy = vi.fn(
      async (_system: string, _user: string): Promise<LlmResponse> => ({
        text: VALID,
        inputTokens: 1,
        outputTokens: 1,
      })
    );
    const client: LlmClient = { provider: "fake", model: "f", complete: spy };

    await classifyOne(job({ description: "EU authorisation required" }), {
      client,
      profile,
      promptVersion: "v2",
    });
    expect(spy.mock.calls[0][1]).toContain("EU authorisation required");

    await classifyOne(job({ description: "EU authorisation required" }), {
      client,
      profile,
      promptVersion: "v1",
    });
    expect(spy.mock.calls[1][1]).not.toContain("EU authorisation required");
  });
});

describe("classify", () => {
  it("classifies every job and preserves input order", async () => {
    const client = fakeClient([VALID]);
    const jobs = [job({ url: "a" }), job({ url: "b" }), job({ url: "c" })];
    const { jobs: out, stats } = await classify(jobs, { client, profile, concurrency: 2 });

    expect(out.map((j) => j.url)).toEqual(["a", "b", "c"]);
    expect(stats.calls).toBe(3);
  });

  it("marks a failed posting as unclassified instead of dropping it", async () => {
    const client = fakeClient([new Error("rate limited")]);
    const { jobs, stats } = await classify([job()], {
      client,
      profile,
      maxRetries: 0,
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0].classification.eligible).toBe(false);
    expect(jobs[0].classification.reason).toMatch(/classification failed/);
    expect(stats.failures).toBe(1);
  });

  it("reports progress once per job", async () => {
    const client = fakeClient([VALID]);
    const seen: number[] = [];
    await classify([job({ url: "a" }), job({ url: "b" })], {
      client,
      profile,
      concurrency: 1,
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([1, 2]);
  });

  it("handles an empty batch without hanging", async () => {
    const client = fakeClient([VALID]);
    const { jobs, stats } = await classify([], { client, profile });
    expect(jobs).toEqual([]);
    expect(stats.calls).toBe(0);
  });
});

describe("estimateCostUsd", () => {
  it("prices input and output separately", () => {
    const cost = estimateCostUsd(1_000_000, 1_000_000, {
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
    });
    expect(cost).toBeCloseTo(0.75, 6);
  });

  it("is zero for a run that made no calls", () => {
    expect(estimateCostUsd(0, 0, { inputPerMillion: 5, outputPerMillion: 15 })).toBe(0);
  });
});
