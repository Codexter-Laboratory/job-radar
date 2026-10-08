import { describe, expect, it } from "vitest";
import { dedupe, normaliseCompany, normaliseTitle } from "../src/pipeline/dedupe.js";
import { Job } from "../src/types.js";

function job(overrides: Partial<Job> = {}): Job {
  return {
    source: "greenhouse",
    company: "Acme",
    title: "Senior Frontend Engineer",
    location: "Remote",
    url: "https://example.com/jobs/1",
    postedAt: "2026-02-25T00:00:00Z",
    ...overrides,
  };
}

describe("normaliseTitle", () => {
  it("strips parentheticals", () => {
    expect(normaliseTitle("Senior Frontend Engineer (Remote)")).toBe(
      "senior frontend engineer"
    );
  });

  it("strips gender markers used on German and French postings", () => {
    expect(normaliseTitle("Frontend Engineer (m/w/d)")).toBe("frontend engineer");
    expect(normaliseTitle("Développeur Frontend h/f")).toBe("d veloppeur frontend");
  });

  it("strips separators and trailing location suffixes", () => {
    expect(normaliseTitle("Senior Frontend Engineer - Remote, EMEA")).toBe(
      "senior frontend engineer emea"
    );
  });

  it("strips contract-type noise", () => {
    expect(normaliseTitle("React Developer | Contract | B2B")).toBe("react developer");
  });

  it("keeps characters that carry meaning in role names", () => {
    expect(normaliseTitle("C++ Engineer")).toBe("c++ engineer");
    expect(normaliseTitle("Node.js Developer")).toBe("node.js developer");
  });

  it("is stable under repeated application", () => {
    const once = normaliseTitle("Senior Frontend Engineer (Remote) - Contract");
    expect(normaliseTitle(once)).toBe(once);
  });
});

describe("normaliseCompany", () => {
  it("strips legal suffixes so the same employer matches across boards", () => {
    expect(normaliseCompany("Acme GmbH")).toBe("acme");
    expect(normaliseCompany("Acme Ltd.")).toBe("acme");
    expect(normaliseCompany("Acme B.V.")).toBe("acme");
  });

  it("leaves the core name alone", () => {
    expect(normaliseCompany("Trade Republic")).toBe("trade republic");
  });
});

describe("dedupe", () => {
  it("keeps a single posting", () => {
    expect(dedupe([job()]).jobs).toHaveLength(1);
  });

  it("removes the same posting cross-listed with a cosmetic title change", () => {
    const result = dedupe([
      job(),
      job({
        source: "remotive",
        title: "Senior Frontend Engineer (Remote)",
        url: "https://remotive.com/jobs/9",
      }),
    ]);
    expect(result.jobs).toHaveLength(1);
    expect(result.removed).toBe(1);
  });

  it("keeps the first occurrence, which is the ATS record", () => {
    const result = dedupe([
      job({ source: "greenhouse" }),
      job({ source: "remotive", url: "https://remotive.com/jobs/9" }),
    ]);
    expect(result.jobs[0].source).toBe("greenhouse");
  });

  it("treats the same URL with different tracking parameters as one posting", () => {
    const result = dedupe([
      job({ url: "https://example.com/jobs/1" }),
      job({ title: "Something Else Entirely", url: "https://example.com/jobs/1?src=rss" }),
    ]);
    expect(result.jobs).toHaveLength(1);
  });

  it("ignores a trailing slash on the URL", () => {
    const result = dedupe([
      job({ url: "https://example.com/jobs/1" }),
      job({ title: "Different", url: "https://example.com/jobs/1/" }),
    ]);
    expect(result.jobs).toHaveLength(1);
  });

  it("keeps genuinely different roles at the same company", () => {
    const result = dedupe([
      job({ title: "Senior Frontend Engineer", url: "https://example.com/jobs/1" }),
      job({ title: "Senior Backend Engineer", url: "https://example.com/jobs/2" }),
    ]);
    expect(result.jobs).toHaveLength(2);
  });

  it("keeps the same role title at different companies", () => {
    const result = dedupe([
      job({ company: "Acme", url: "https://example.com/jobs/1" }),
      job({ company: "Globex", url: "https://example.com/jobs/2" }),
    ]);
    expect(result.jobs).toHaveLength(2);
  });

  it("does not crash on a malformed URL", () => {
    const result = dedupe([job({ url: "not a url" }), job({ url: "not a url" })]);
    expect(result.jobs).toHaveLength(1);
  });
});
