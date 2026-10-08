import { describe, expect, it } from "vitest";
import { isRunHealthy, runSource, summarise } from "../src/pipeline/report.js";
import { applyHistory, ageInDays } from "../src/store/history.js";
import { toCsv, toDigest } from "../src/output/render.js";
import { ClassifiedJob, Job, RunReport } from "../src/types.js";

function job(overrides: Partial<Job> = {}): Job {
  return {
    source: "greenhouse",
    company: "Acme",
    title: "Senior Frontend Engineer",
    location: "Remote",
    url: "https://example.com/1",
    postedAt: "2026-02-25T00:00:00Z",
    ...overrides,
  };
}

function classified(
  overrides: Partial<Job> = {},
  eligible = true,
  confidence = 0.9
): ClassifiedJob {
  return {
    ...job(overrides),
    classification: {
      eligible,
      employmentType: "b2b",
      regionConstraint: "",
      confidence,
      reason: "No location restriction stated.",
    },
  };
}

function report(sources: RunReport["sources"]): RunReport {
  return {
    startedAt: "2026-03-01T06:00:00Z",
    finishedAt: "2026-03-01T06:02:00Z",
    sources,
    totals: {
      fetched: 100,
      afterPrefilter: 40,
      afterDedupe: 35,
      classified: 35,
      eligible: 12,
      newSinceLastRun: 3,
    },
  };
}

describe("runSource", () => {
  it("records a successful source with its count", async () => {
    const { report: r, result } = await runSource("greenhouse", async () => [1, 2, 3], (x) => x.length);
    expect(r.ok).toBe(true);
    expect(r.fetched).toBe(3);
    expect(result).toEqual([1, 2, 3]);
  });

  it("records a failure with its message instead of swallowing it", async () => {
    const { report: r, result } = await runSource(
      "linkedin",
      async () => {
        throw new Error("429 Too Many Requests");
      },
      () => 0
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("429");
    expect(result).toBeNull();
  });

  it("never rejects, so one dead source cannot stop the run", async () => {
    await expect(
      runSource("x", async () => {
        throw new Error("boom");
      }, () => 0)
    ).resolves.toBeDefined();
  });
});

describe("isRunHealthy", () => {
  const ok = (source: string) => ({ source, ok: true, fetched: 5, durationMs: 10 });
  const bad = (source: string) => ({ source, ok: false, fetched: 0, durationMs: 10, error: "x" });

  it("is healthy when most sources worked", () => {
    expect(isRunHealthy(report([ok("a"), ok("b"), bad("c")]))).toBe(true);
  });

  it("is unhealthy when more than half failed", () => {
    expect(isRunHealthy(report([ok("a"), bad("b"), bad("c")]))).toBe(false);
  });

  it("treats an exact half as unhealthy", () => {
    expect(isRunHealthy(report([ok("a"), bad("b")]))).toBe(false);
  });

  it("is unhealthy with no sources at all", () => {
    expect(isRunHealthy(report([]))).toBe(false);
  });
});

describe("summarise", () => {
  it("names every failed source", () => {
    const text = summarise(
      report([
        { source: "greenhouse", ok: true, fetched: 20, durationMs: 800 },
        { source: "linkedin", ok: false, fetched: 0, durationMs: 50, error: "429" },
      ])
    );
    expect(text).toContain("linkedin");
    expect(text).toContain("429");
    expect(text).toContain("1 source(s) failed");
  });
});

describe("history", () => {
  it("marks a posting seen for the first time as new", () => {
    const update = applyHistory([job()], {}, new Date("2026-03-01T00:00:00Z"));
    expect(update.newCount).toBe(1);
    expect(update.isNew(job())).toBe(true);
    expect(update.history["https://example.com/1"]).toBe("2026-03-01");
  });

  it("does not mark a posting new on the second run", () => {
    const update = applyHistory(
      [job()],
      { "https://example.com/1": "2026-02-20" },
      new Date("2026-03-01T00:00:00Z")
    );
    expect(update.newCount).toBe(0);
    expect(update.isNew(job())).toBe(false);
  });

  it("keeps the original first-seen date rather than overwriting it", () => {
    const update = applyHistory([job()], { "https://example.com/1": "2026-02-20" });
    expect(update.history["https://example.com/1"]).toBe("2026-02-20");
  });

  it("computes how long a posting has been open", () => {
    const days = ageInDays(
      job(),
      { "https://example.com/1": "2026-02-20" },
      new Date("2026-03-01T00:00:00Z")
    );
    expect(days).toBe(9);
  });

  it("returns null for a posting it has never seen", () => {
    expect(ageInDays(job(), {})).toBeNull();
  });
});

describe("toCsv", () => {
  it("emits a header plus one row per posting", () => {
    const lines = toCsv([classified()]).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("employmentType");
  });

  it("escapes quotes and commas in free-text fields", () => {
    const row = toCsv([
      classified({ title: 'Engineer, "Senior"' }),
    ]).split("\n")[1];
    expect(row).toContain('"Engineer, ""Senior"""');
  });

  it("renders an empty list as just the header", () => {
    expect(toCsv([]).split("\n")).toHaveLength(1);
  });
});

describe("toDigest", () => {
  const opts = {
    history: {},
    isNew: (j: ClassifiedJob) => j.url === "https://example.com/new",
    reviewBelow: 0.6,
    now: new Date("2026-03-01T00:00:00Z"),
  };

  it("separates new postings from ones already seen", () => {
    const md = toDigest(
      [
        classified({ url: "https://example.com/new" }),
        classified({ url: "https://example.com/old" }),
      ],
      report([]),
      opts
    );
    expect(md).toContain("## New today");
    expect(md).toContain("## Still open");
    expect(md).toContain("1 new, 1 still open");
  });

  it("routes low-confidence matches to a review section", () => {
    const md = toDigest([classified({}, true, 0.3)], report([]), opts);
    expect(md).toContain("Low confidence");
  });

  it("leaves ineligible postings out entirely", () => {
    const md = toDigest([classified({}, false)], report([]), opts);
    expect(md).toContain("Nothing matched today");
  });

  it("surfaces failed sources so a quiet day is distinguishable from a broken one", () => {
    const md = toDigest(
      [classified()],
      report([{ source: "lever", ok: false, fetched: 0, durationMs: 5, error: "500" }]),
      opts
    );
    expect(md).toContain("## Sources that failed");
    expect(md).toContain("lever");
  });
});
