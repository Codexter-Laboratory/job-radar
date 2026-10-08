import { describe, expect, it } from "vitest";
import { discoverAts, extractJsonLd, extractLinks, jobFromJsonLd, parseRobots, robotsAllows } from "../src/sources/web.js";
import { mapPersonioXml, smartrecruitersMapper } from "../src/sources/ats.js";
import { routeJob } from "../src/apply/route.js";
import { atsFromUrl } from "../src/apply/ats.js";

const posting = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Senior Frontend Developer",
  datePosted: "2026-10-01",
  employmentType: ["CONTRACTOR"],
  jobLocationType: "TELECOMMUTE",
  applicantLocationRequirements: { "@type": "Country", name: "European Union" },
  hiringOrganization: { "@type": "Organization", name: "Acme Software House" },
  jobLocation: { "@type": "Place", address: { addressLocality: "Wrocław", addressCountry: "PL" } },
  baseSalary: { currency: "PLN", value: { minValue: 20000, maxValue: 28000, unitText: "MONTH" } },
  description: "<p>B2B contract. React and TypeScript.</p>",
};

const page = `<html><head>
<script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "Organization", name: "x" }, posting] })}</script>
<script type="application/ld+json">{ broken json </script>
</head><body>
<a href="/job-offer/acme-senior-frontend">one</a>
<a href="https://justjoin.it/job-offer/other?x=1&amp;y=2">two</a>
<iframe src="https://job-boards.greenhouse.io/embed/job_board?for=acmeco"></iframe>
<a href="https://jobs.lever.co/acme-labs/123">lever</a>
<script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeco"></script>
<a href="https://acme.jobs.personio.de/job/1">personio</a>
<a href="https://careers.smartrecruiters.com/AcmeGroup">sr</a>
</body></html>`;

describe("JSON-LD", () => {
  it("finds postings inside @graph and survives broken blocks", () => {
    const items = extractJsonLd(page);
    expect(items.filter((o) => o["@type"] === "JobPosting")).toHaveLength(1);
  });
  it("maps a posting and surfaces the contract type for the classifier", () => {
    const job = jobFromJsonLd(posting, "https://acme.dev/jobs/1", "company-site", "Acme");
    expect(job).toMatchObject({
      company: "Acme Software House",
      title: "Senior Frontend Developer",
      url: "https://acme.dev/jobs/1",
      postedAt: expect.stringMatching(/^2026-10-01/),
      salary: "20000-28000 PLN per month",
    });
    expect(job.location).toBe("Remote / European Union / Wrocław, PL");
    expect(job.description).toMatch(/^Employment type: CONTRACTOR\nApplicants must be located in: European Union\nB2B contract/);
  });
});

describe("discovery", () => {
  it("finds ATS boards embedded on a careers page", () => {
    const d = discoverAts(page);
    expect(d.greenhouse).toEqual(["acmeco"]);
    expect(d.lever).toEqual(["acme-labs"]);
    expect(d.personio).toEqual(["acme"]);
    expect(d.smartrecruiters).toEqual(["acmegroup"]);
  });
  it("resolves links", () => {
    const links = extractLinks(page, "https://justjoin.it/job-offers/all");
    expect(links).toContain("https://justjoin.it/job-offer/acme-senior-frontend");
    expect(links).toContain("https://justjoin.it/job-offer/other?x=1&y=2");
  });
});

describe("robots.txt", () => {
  const rules = parseRobots(`User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\nDisallow: /search*q=\n`);
  it("applies only the wildcard group", () => {
    expect(rules).toEqual(["/admin", "/search*q="]);
    expect(robotsAllows(rules, "/careers")).toBe(true);
    expect(robotsAllows(rules, "/admin/x")).toBe(false);
    expect(robotsAllows(rules, "/search?q=react")).toBe(false);
  });
});

describe("personio and smartrecruiters", () => {
  it("maps the Personio XML feed", () => {
    const xml = `<?xml version="1.0"?><workzag-jobs><position><id>42</id><name>Frontend Engineer (React)</name>
      <office>Berlin</office><employmentType>freelance</employmentType><createdAt>2026-09-30T10:00:00+00:00</createdAt>
      <jobDescriptions><jobDescription><name>Your role</name><value><![CDATA[<p>Build the web app</p>]]></value></jobDescription></jobDescriptions>
      </position></workzag-jobs>`;
    const [job] = mapPersonioXml(xml, "acme");
    expect(job).toMatchObject({ source: "personio", title: "Frontend Engineer (React)", location: "Berlin", url: "https://acme.jobs.personio.de/job/42" });
    expect(job.description).toMatch(/Employment type: freelance[\s\S]*Build the web app/);
  });
  it("maps a SmartRecruiters posting", () => {
    const job = smartrecruitersMapper({ id: "7", name: "React Developer", releasedDate: "2026-10-02T00:00:00Z", location: { city: "Dubai", country: "ae", remote: true }, company: { name: "Acme" } }, "acme");
    expect(job).toMatchObject({ url: "https://jobs.smartrecruiters.com/acme/7", location: "Dubai, AE, Remote", company: "Acme" });
  });
});

describe("routing new sites", () => {
  it("knows the new ATS hosts", () => {
    expect(atsFromUrl("https://jobs.smartrecruiters.com/acme/7")).toBe("smartrecruiters");
    expect(atsFromUrl("https://acme.jobs.personio.de/job/42")).toBe("personio");
  });
  it("tries unknown company sites only when allowed", () => {
    const job = { url: "https://acme.dev/careers/frontend", company: "Acme", source: "company-site", description: "" };
    expect(routeJob(job).lane).toBe("review");
    expect(routeJob(job, { tryUnknownSites: true })).toMatchObject({ lane: "ats", ats: "generic" });
    expect(routeJob({ ...job, url: "https://www.linkedin.com/jobs/view/1" }, { tryUnknownSites: true }).lane).toBe("review");
  });
});
