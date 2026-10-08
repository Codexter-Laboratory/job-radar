import { describe, expect, it } from "vitest";
import { prefilter, PrefilterConfig } from "../src/pipeline/prefilter.js";
import { Job } from "../src/types.js";

const NOW = Date.parse("2026-03-01T00:00:00Z");

const cfg: PrefilterConfig = {
  keywords: ["react", "frontend", "typescript"],
  excludeKeywords: ["intern", "junior"],
  locationAllow: ["remote", "emea", "europe", "worldwide"],
  locationBlock: ["us only", "canada only"],
  maxAgeDays: 14,
};

function job(overrides: Partial<Job> = {}): Job {
  return {
    source: "test",
    company: "Acme",
    title: "Senior React Engineer",
    location: "Remote",
    url: "https://example.com/1",
    postedAt: "2026-02-25T00:00:00Z",
    ...overrides,
  };
}

describe("prefilter", () => {
  it("keeps a posting that matches a keyword and an allowed location", () => {
    const result = prefilter([job()], cfg, NOW);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops postings with no matching keyword", () => {
    const result = prefilter([job({ title: "Kubernetes Platform Engineer" })], cfg, NOW);
    expect(result.kept).toHaveLength(0);
    expect(result.dropCounts["no-keyword"]).toBe(1);
  });

  it("matches keywords in tags as well as the title", () => {
    const result = prefilter(
      [job({ title: "Software Engineer", tags: ["React", "GraphQL"] })],
      cfg,
      NOW
    );
    expect(result.kept).toHaveLength(1);
  });

  it("drops excluded titles even when a keyword matches", () => {
    const result = prefilter([job({ title: "Junior React Developer" })], cfg, NOW);
    expect(result.dropCounts["excluded-keyword"]).toBe(1);
  });

  it("does not apply exclusions to tags, only to the title", () => {
    const result = prefilter(
      [job({ title: "Senior React Engineer", tags: ["intern-friendly"] })],
      cfg,
      NOW
    );
    expect(result.kept).toHaveLength(1);
  });

  it("drops blocked locations", () => {
    const result = prefilter([job({ location: "Remote (US only)" })], cfg, NOW);
    expect(result.dropCounts["blocked-location"]).toBe(1);
  });

  it("checks the block list before the allow list", () => {
    // "Remote, US only" contains an allowed token and a blocked one. Blocked wins.
    const result = prefilter([job({ location: "Remote, US only" })], cfg, NOW);
    expect(result.dropCounts["blocked-location"]).toBe(1);
    expect(result.dropCounts["location-not-allowed"]).toBe(0);
  });

  it("keeps postings with an empty location, because unknown is not no", () => {
    const result = prefilter([job({ location: "" })], cfg, NOW);
    expect(result.kept).toHaveLength(1);
  });

  it("drops locations that are stated but not on the allow list", () => {
    const result = prefilter([job({ location: "Tokyo, Japan" })], cfg, NOW);
    expect(result.dropCounts["location-not-allowed"]).toBe(1);
  });

  it("drops postings older than maxAgeDays", () => {
    const result = prefilter([job({ postedAt: "2026-01-01T00:00:00Z" })], cfg, NOW);
    expect(result.dropCounts.stale).toBe(1);
  });

  it("keeps postings with no date rather than guessing they are stale", () => {
    const result = prefilter([job({ postedAt: "" })], cfg, NOW);
    expect(result.kept).toHaveLength(1);
  });

  it("keeps postings whose date is unparseable", () => {
    const result = prefilter([job({ postedAt: "last tuesday" })], cfg, NOW);
    expect(result.kept).toHaveLength(1);
  });

  it("is case insensitive on every rule", () => {
    const result = prefilter(
      [job({ title: "SENIOR REACT ENGINEER", location: "REMOTE / EMEA" })],
      cfg,
      NOW
    );
    expect(result.kept).toHaveLength(1);
  });

  it("accounts for every dropped posting exactly once", () => {
    const jobs = [
      job(),
      job({ title: "DevOps Engineer", url: "u2" }),
      job({ title: "Junior React Developer", url: "u3" }),
      job({ location: "US only", url: "u4" }),
      job({ location: "Tokyo", url: "u5" }),
      job({ postedAt: "2020-01-01T00:00:00Z", url: "u6" }),
    ];
    const result = prefilter(jobs, cfg, NOW);

    const counted = Object.values(result.dropCounts).reduce((a, b) => a + b, 0);
    expect(result.kept.length + counted).toBe(jobs.length);
    expect(result.dropped).toHaveLength(counted);
  });
});
