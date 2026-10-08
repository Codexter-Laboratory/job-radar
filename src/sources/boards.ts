import { Job } from "../types.js";
import { fetchJson } from "../http.js";
import { joinParts, pickDescription, pickString, toIsoDate } from "./util.js";

/**
 * Aggregators return one payload for the whole board, so unlike the ATS
 * adapters there is no per-company partial failure to record. A failure here is
 * total and is reported by the runner.
 */
export const mappers = {
  remotive: (raw: any): Job => ({
    source: "remotive",
    company: pickString(raw, ["company_name"]),
    title: pickString(raw, ["title"]),
    location: pickString(raw, ["candidate_required_location"]),
    url: pickString(raw, ["url"]),
    postedAt: toIsoDate(raw?.publication_date),
    salary: pickString(raw, ["salary"]) || undefined,
    tags: Array.isArray(raw?.tags) ? raw.tags : undefined,
    description: pickDescription(raw, ["description"]),
  }),

  remoteok: (raw: any): Job => ({
    source: "remoteok",
    company: pickString(raw, ["company"]),
    title: pickString(raw, ["position"]),
    location: pickString(raw, ["location"]) || "Worldwide",
    url: pickString(raw, ["url", "apply_url"]),
    postedAt: toIsoDate(raw?.date),
    salary:
      raw?.salary_min && raw?.salary_max
        ? `$${raw.salary_min}-$${raw.salary_max}`
        : undefined,
    tags: Array.isArray(raw?.tags) ? raw.tags : undefined,
    description: pickDescription(raw, ["description"]),
  }),

  arbeitnow: (raw: any): Job => ({
    source: "arbeitnow",
    company: pickString(raw, ["company_name"]),
    title: pickString(raw, ["title"]),
    location: joinParts([raw?.location, raw?.remote ? "Remote" : ""]),
    url: pickString(raw, ["url"]),
    postedAt: toIsoDate(raw?.created_at),
    tags: Array.isArray(raw?.tags) ? raw.tags : undefined,
    description: pickDescription(raw, ["description"]),
  }),

  himalayas: (raw: any): Job => ({
    source: "himalayas",
    company: pickString(raw, ["companyName"]),
    title: pickString(raw, ["title"]),
    location:
      (Array.isArray(raw?.locationRestrictions)
        ? raw.locationRestrictions.join(", ")
        : "") || "Worldwide",
    url: pickString(raw, ["applicationLink", "guid"]),
    postedAt: toIsoDate(raw?.pubDate),
    salary:
      raw?.minSalary && raw?.maxSalary
        ? `${raw.minSalary}-${raw.maxSalary} ${raw.salaryCurrency ?? ""}`.trim()
        : undefined,
    tags: Array.isArray(raw?.categories) ? raw.categories : undefined,
    description: pickDescription(raw, ["description", "excerpt"]),
  }),

  jobicy: (raw: any): Job => ({
    source: "jobicy",
    company: pickString(raw, ["companyName"]),
    title: pickDescription(raw, ["jobTitle"]),
    location: pickString(raw, ["jobGeo"]),
    url: pickString(raw, ["url"]),
    postedAt: toIsoDate(raw?.pubDate),
    salary:
      raw?.annualSalaryMin && raw?.annualSalaryMax
        ? `${raw.annualSalaryMin}-${raw.annualSalaryMax} ${raw.salaryCurrency ?? ""}`.trim()
        : undefined,
    tags: Array.isArray(raw?.jobIndustry) ? raw.jobIndustry : undefined,
    description: pickDescription(raw, ["jobDescription", "jobExcerpt"]),
  }),
};

export async function remotive(): Promise<Job[]> {
  const data = await fetchJson<any>(
    "https://remotive.com/api/remote-jobs?category=software-dev&limit=200"
  );
  return (data?.jobs ?? []).map(mappers.remotive);
}

export async function remoteok(): Promise<Job[]> {
  const data = await fetchJson<any[]>("https://remoteok.com/api");
  // The first element of RemoteOK's feed is a legal notice, not a posting.
  return (data ?? []).filter((j) => j && j.id && j.position).map(mappers.remoteok);
}

export async function arbeitnow(pages = 3): Promise<Job[]> {
  const jobs: Job[] = [];
  for (let p = 1; p <= pages; p++) {
    const data = await fetchJson<any>(
      `https://www.arbeitnow.com/api/job-board-api?page=${p}`
    );
    for (const raw of data?.data ?? []) jobs.push(mappers.arbeitnow(raw));
  }
  return jobs;
}

export async function himalayas(): Promise<Job[]> {
  const data = await fetchJson<any>("https://himalayas.app/jobs/api?limit=100");
  return (data?.jobs ?? []).map(mappers.himalayas);
}

export async function jobicy(): Promise<Job[]> {
  const data = await fetchJson<any>(
    "https://jobicy.com/api/v2/remote-jobs?count=100&industry=dev"
  );
  return (data?.jobs ?? []).map(mappers.jobicy);
}
