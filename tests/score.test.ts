import { describe, expect, it } from "vitest";
import { confusion, disagreements, metricsFrom } from "../src/eval/score.js";
import { goldenId, goldenStats, isBalanced } from "../src/eval/golden.js";
import { Classification, EmploymentType, GoldenRecord, Job } from "../src/types.js";

function job(url: string): Job {
  return {
    source: "test",
    company: "Acme",
    title: "Senior Frontend Engineer",
    location: "Remote",
    url,
    postedAt: "2026-02-25T00:00:00Z",
  };
}

function golden(
  id: string,
  eligible: boolean,
  employmentType: EmploymentType = "b2b"
): GoldenRecord {
  return {
    id,
    job: job(`https://example.com/${id}`),
    label: { eligible, employmentType },
    labelledAt: "2026-03-01T00:00:00Z",
    labelledBy: "test",
  };
}

function prediction(
  eligible: boolean,
  employmentType: EmploymentType = "b2b",
  confidence = 0.9
): Classification {
  return { eligible, employmentType, regionConstraint: "", confidence, reason: "" };
}

describe("confusion", () => {
  it("counts each quadrant", () => {
    const records = [golden("a", true), golden("b", true), golden("c", false), golden("d", false)];
    const preds = new Map([
      ["a", prediction(true)], // TP
      ["b", prediction(false)], // FN
      ["c", prediction(true)], // FP
      ["d", prediction(false)], // TN
    ]);

    expect(confusion(records, preds)).toEqual({
      truePositives: 1,
      falsePositives: 1,
      trueNegatives: 1,
      falseNegatives: 1,
    });
  });

  it("counts a missing prediction as not eligible, matching pipeline behaviour", () => {
    const records = [golden("a", true), golden("b", false)];
    const m = confusion(records, new Map());
    expect(m.falseNegatives).toBe(1);
    expect(m.trueNegatives).toBe(1);
  });
});

describe("metricsFrom", () => {
  it("computes precision, recall and F1", () => {
    // 2 TP, 1 FP, 1 FN → precision 2/3, recall 2/3, F1 2/3
    const records = [golden("a", true), golden("b", true), golden("c", true), golden("d", false)];
    const preds = new Map([
      ["a", prediction(true)],
      ["b", prediction(true)],
      ["c", prediction(false)],
      ["d", prediction(true)],
    ]);

    const m = metricsFrom(records, preds);
    expect(m.precision).toBeCloseTo(2 / 3, 6);
    expect(m.recall).toBeCloseTo(2 / 3, 6);
    expect(m.f1).toBeCloseTo(2 / 3, 6);
    expect(m.accuracy).toBeCloseTo(0.5, 6);
  });

  it("returns zero rather than NaN when nothing was predicted eligible", () => {
    const records = [golden("a", false), golden("b", false)];
    const preds = new Map([
      ["a", prediction(false)],
      ["b", prediction(false)],
    ]);

    const m = metricsFrom(records, preds);
    expect(m.precision).toBe(0);
    expect(m.recall).toBe(0);
    expect(m.f1).toBe(0);
    expect(m.accuracy).toBe(1);
  });

  it("scores employment type separately from the eligibility verdict", () => {
    const records = [golden("a", true, "b2b"), golden("b", true, "payroll")];
    const preds = new Map([
      ["a", prediction(true, "b2b")],
      ["b", prediction(true, "eor")],
    ]);

    const m = metricsFrom(records, preds);
    expect(m.recall).toBe(1);
    expect(m.employmentTypeAccuracy).toBe(0.5);
  });

  it("handles an empty golden set without dividing by zero", () => {
    const m = metricsFrom([], new Map());
    expect(m.total).toBe(0);
    expect(m.f1).toBe(0);
  });
});

describe("disagreements", () => {
  it("lists only the cases the classifier got wrong", () => {
    const records = [golden("a", true), golden("b", false)];
    const preds = new Map([
      ["a", prediction(false, "b2b", 0.4)],
      ["b", prediction(false)],
    ]);

    const d = disagreements(records, preds);
    expect(d).toHaveLength(1);
    expect(d[0].id).toBe("a");
    expect(d[0].expected).toBe(true);
    expect(d[0].predicted).toBe(false);
    expect(d[0].confidence).toBe(0.4);
  });
});

describe("golden set bookkeeping", () => {
  it("gives the same posting the same id across runs", () => {
    expect(goldenId(job("https://example.com/1"))).toBe(goldenId(job("https://example.com/1")));
  });

  it("gives different postings different ids", () => {
    expect(goldenId(job("https://example.com/1"))).not.toBe(
      goldenId(job("https://example.com/2"))
    );
  });

  it("summarises the class split", () => {
    const stats = goldenStats([golden("a", true), golden("b", false), golden("c", false)]);
    expect(stats.total).toBe(3);
    expect(stats.eligible).toBe(1);
    expect(stats.ineligible).toBe(2);
  });

  it("flags a lopsided set, because precision on one is meaningless", () => {
    const lopsided = goldenStats([
      golden("a", true),
      golden("b", true),
      golden("c", true),
      golden("d", true),
      golden("e", false),
    ]);
    expect(isBalanced(lopsided)).toBe(false);

    const even = goldenStats([golden("a", true), golden("b", false)]);
    expect(isBalanced(even)).toBe(true);
  });

  it("treats an empty set as unbalanced rather than perfect", () => {
    expect(isBalanced(goldenStats([]))).toBe(false);
  });
});
