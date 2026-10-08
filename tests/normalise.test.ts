import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { mappers as ats } from "../src/sources/ats.js";
import { mappers as boards } from "../src/sources/boards.js";
import { mapWwrItem, parseWwrTitle, parseLinkedinCards } from "../src/sources/misc.js";
import { toIsoDate, pickString } from "../src/sources/util.js";
import { stripHtml } from "../src/http.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

describe("toIsoDate", () => {
  it("passes an ISO string through", () => {
    expect(toIsoDate("2026-02-20T09:14:00Z")).toBe("2026-02-20T09:14:00.000Z");
  });

  it("reads epoch seconds, which Arbeitnow and Himalayas use", () => {
    expect(toIsoDate(1771286400)).toBe("2026-02-17T00:00:00.000Z");
  });

  it("reads epoch milliseconds, which Lever uses", () => {
    expect(toIsoDate(1771286400000)).toBe("2026-02-17T00:00:00.000Z");
  });

  it("returns empty for missing or unparseable values rather than the epoch", () => {
    expect(toIsoDate(undefined)).toBe("");
    expect(toIsoDate("")).toBe("");
    expect(toIsoDate("whenever")).toBe("");
  });
});

describe("stripHtml", () => {
  it("removes tags and decodes the entities that appear in job descriptions", () => {
    expect(stripHtml("<p>R&amp;D team</p>")).toBe("R&D team");
  });

  it("turns block elements into line breaks so the text stays readable", () => {
    expect(stripHtml("<li>One</li><li>Two</li>")).toBe("One\nTwo");
  });

  it("collapses runs of whitespace", () => {
    expect(stripHtml("a    b\n\n\n\nc")).toBe("a b\n\nc");
  });
});

describe("pickString", () => {
  it("returns the first non-empty candidate", () => {
    expect(pickString({ a: "", b: "x" }, ["a", "b"])).toBe("x");
  });

  it("returns empty when nothing matches, instead of throwing", () => {
    expect(pickString({}, ["a"])).toBe("");
    expect(pickString(null, ["a"])).toBe("");
  });
});

describe("adapters normalise into a single schema", () => {
  it("greenhouse", () => {
    const [job] = fixture("greenhouse.json").jobs.map((r: unknown) =>
      ats.greenhouse(r, "acme")
    );
    expect(job).toMatchObject({
      source: "greenhouse",
      company: "acme",
      title: "Senior Frontend Engineer",
      location: "Berlin, Germany (Remote)",
      url: "https://boards.greenhouse.io/acme/jobs/4012345",
    });
    expect(job.postedAt).toBe("2026-02-20T14:14:00.000Z");
    // Greenhouse double-escapes its HTML; the description must still read as prose.
    expect(job.description).toContain("EU work authorisation");
    expect(job.description).not.toContain("&lt;");
  });

  it("lever", () => {
    const [job] = fixture("lever.json").map((r: unknown) => ats.lever(r, "acme"));
    expect(job.title).toBe("Frontend Engineer");
    expect(job.location).toBe("Warsaw / remote");
    expect(job.postedAt).toBe("2026-02-17T00:00:00.000Z");
    expect(job.description).toContain("B2B");
  });

  it("ashby", () => {
    const [job] = fixture("ashby.json").jobs.map((r: unknown) => ats.ashby(r, "acme"));
    expect(job.location).toBe("Remote - Worldwide / Remote");
    expect(job.salary).toBe("$120K - $160K");
  });

  it("workable", () => {
    const [job] = fixture("workable.json").jobs.map((r: unknown) =>
      ats.workable(r, "acme")
    );
    expect(job.location).toBe("Amsterdam, Netherlands, Remote");
    expect(job.url).toBe("https://apply.workable.com/acme/j/ABC123/");
  });

  it("remoteok, skipping the legal notice in the first element", () => {
    const raw = fixture("remoteok.json").filter((j: any) => j && j.id && j.position);
    expect(raw).toHaveLength(1);
    const job = boards.remoteok(raw[0]);
    expect(job.company).toBe("Globex");
    expect(job.salary).toBe("$70000-$95000");
    expect(job.tags).toEqual(["react", "typescript"]);
  });

  it("every adapter produces the same required fields", () => {
    const jobs = [
      ats.greenhouse(fixture("greenhouse.json").jobs[0], "acme"),
      ats.lever(fixture("lever.json")[0], "acme"),
      ats.ashby(fixture("ashby.json").jobs[0], "acme"),
      ats.workable(fixture("workable.json").jobs[0], "acme"),
      boards.remoteok(fixture("remoteok.json")[1]),
    ];

    for (const job of jobs) {
      expect(job.source).toBeTruthy();
      expect(job.title).toBeTruthy();
      expect(job.url).toMatch(/^https?:\/\//);
      expect(typeof job.location).toBe("string");
      expect(job.postedAt).toMatch(/^(\d{4}-\d{2}-\d{2}T|$)/);
    }
  });

  it("survives a payload missing every optional field", () => {
    const job = ats.greenhouse({ title: "X", absolute_url: "https://e.com/1" }, "acme");
    expect(job.location).toBe("");
    expect(job.postedAt).toBe("");
    expect(job.description).toBe("");
  });
});

describe("we work remotely", () => {
  it("splits company from title on the first colon only", () => {
    expect(parseWwrTitle("Initech: Senior Engineer: React")).toEqual({
      company: "Initech",
      title: "Senior Engineer: React",
    });
  });

  it("handles a title with no colon at all", () => {
    expect(parseWwrTitle("Senior Engineer")).toEqual({
      company: "",
      title: "Senior Engineer",
    });
  });

  it("maps a feed item", () => {
    const xml = readFileSync(new URL("../fixtures/wwr.xml", import.meta.url), "utf8");
    const parsed = new XMLParser().parse(xml);
    const job = mapWwrItem(parsed.rss.channel.item);
    expect(job.company).toBe("Initech");
    expect(job.title).toBe("Senior Frontend Engineer: React");
    expect(job.location).toBe("Anywhere in the World");
    expect(job.postedAt).toBe("2026-02-20T12:00:00.000Z");
  });
});

describe("linkedin card parser", () => {
  it("returns nothing when the markup has changed, rather than throwing", () => {
    expect(parseLinkedinCards("<html><body>redesigned</body></html>")).toEqual([]);
  });

  it("strips tracking parameters from card links", () => {
    const html = `
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/123?trk=abc">
        <span class="sr-only"> Frontend Engineer </span>
      </a>
      <h4 class="base-search-card__subtitle"><a href="#">Globex</a></h4>
      <span class="job-search-card__location">Berlin, Germany</span>`;
    const [job] = parseLinkedinCards(html);
    expect(job.url).toBe("https://www.linkedin.com/jobs/view/123");
    expect(job.title).toBe("Frontend Engineer");
    expect(job.company).toBe("Globex");
    expect(job.location).toBe("Berlin, Germany");
  });
});
