import { Job } from "../types.js";
import { XMLParser } from "fast-xml-parser";
import { fetchJson, fetchText, sleep } from "../http.js";
import { joinParts, pickDescription, pickString, toIsoDate } from "./util.js";

/**
 * Per-company boards fail independently: a slug gets renamed, a company drops
 * the ATS, a board goes private. Those are recorded rather than swallowed, so a
 * config that has quietly rotted shows up in the run report instead of looking
 * like "no matching jobs today".
 */
export interface BoardOutcome {
  jobs: Job[];
  failedCompanies: { company: string; error: string }[];
}

export type Mapper = (raw: any, company: string) => Job;

/**
 * Mapping is kept separate from fetching so the normalisation of each vendor's
 * payload can be tested against a fixture without touching the network.
 */
export const mappers = {
  greenhouse: (raw: any, company: string): Job => ({
    source: "greenhouse",
    company,
    title: pickString(raw, ["title"]),
    location: pickString(raw?.location, ["name"]),
    url: pickString(raw, ["absolute_url"]),
    postedAt: toIsoDate(raw?.updated_at ?? raw?.first_published),
    description: pickDescription(raw, ["content"]),
  }),

  lever: (raw: any, company: string): Job => ({
    source: "lever",
    company,
    title: pickString(raw, ["text"]),
    location: joinParts([raw?.categories?.location, raw?.workplaceType]),
    url: pickString(raw, ["hostedUrl", "applyUrl"]),
    postedAt: toIsoDate(raw?.createdAt),
    description: pickDescription(raw, ["descriptionPlain", "description"]),
  }),

  ashby: (raw: any, company: string): Job => ({
    source: "ashby",
    company,
    title: pickString(raw, ["title"]),
    location: joinParts([raw?.location, raw?.isRemote ? "Remote" : ""]),
    url: pickString(raw, ["jobUrl", "applyUrl"]),
    postedAt: toIsoDate(raw?.publishedAt),
    salary: pickString(raw?.compensation, ["compensationTierSummary"]) || undefined,
    description: pickDescription(raw, ["descriptionPlain", "descriptionHtml"]),
  }),

  workable: (raw: any, company: string): Job => ({
    source: "workable",
    company,
    title: pickString(raw, ["title"]),
    location: joinParts([raw?.city, raw?.country, raw?.telecommuting ? "Remote" : ""], ", "),
    url: pickString(raw, ["url", "shortlink", "application_url"]),
    postedAt: toIsoDate(raw?.published_on ?? raw?.created_at),
    description: pickDescription(raw, ["description", "requirements"]),
  }),

  recruitee: (raw: any, company: string): Job => ({
    source: "recruitee",
    company,
    title: pickString(raw, ["title"]),
    location: joinParts([raw?.location, raw?.remote ? "Remote" : ""]),
    url: pickString(raw, ["careers_url", "careers_apply_url"]),
    postedAt: toIsoDate(raw?.created_at),
    description: pickDescription(raw, ["description", "requirements"]),
  }),
} satisfies Record<string, Mapper>;

async function scrapeBoards(
  companies: string[],
  urlFor: (company: string) => string,
  listFrom: (payload: any) => unknown[],
  map: Mapper,
  delayMs = 200
): Promise<BoardOutcome> {
  const jobs: Job[] = [];
  const failedCompanies: { company: string; error: string }[] = [];

  for (const company of companies) {
    try {
      const payload = await fetchJson<any>(urlFor(company));
      for (const raw of listFrom(payload) ?? []) {
        const job = map(raw, company);
        if (job.title && job.url) jobs.push(job);
      }
    } catch (e) {
      failedCompanies.push({ company, error: (e as Error).message });
    }
    await sleep(delayMs);
  }

  return { jobs, failedCompanies };
}

// ---------- Greenhouse (official public board API) ----------
export const greenhouse = (companies: string[]): Promise<BoardOutcome> =>
  scrapeBoards(
    companies,
    (c) => `https://boards-api.greenhouse.io/v1/boards/${c}/jobs?content=true`,
    (p) => p?.jobs ?? [],
    mappers.greenhouse
  );

// ---------- Lever (official public postings API) ----------
export const lever = (companies: string[]): Promise<BoardOutcome> =>
  scrapeBoards(
    companies,
    (c) => `https://api.lever.co/v0/postings/${c}?mode=json`,
    (p) => (Array.isArray(p) ? p : []),
    mappers.lever
  );

// ---------- Ashby (public job-board API) ----------
export const ashby = (companies: string[]): Promise<BoardOutcome> =>
  scrapeBoards(
    companies,
    (c) => `https://api.ashbyhq.com/posting-api/job-board/${c}?includeCompensation=true`,
    (p) => p?.jobs ?? [],
    mappers.ashby
  );

// ---------- Workable (public widget API) ----------
export const workable = (companies: string[]): Promise<BoardOutcome> =>
  scrapeBoards(
    companies,
    (c) => `https://apply.workable.com/api/v1/widget/accounts/${c}?details=true`,
    (p) => p?.jobs ?? [],
    mappers.workable
  );

// ---------- Recruitee (public offers API) ----------
export const recruitee = (companies: string[]): Promise<BoardOutcome> =>
  scrapeBoards(
    companies,
    (c) => `https://${c}.recruitee.com/api/offers/`,
    (p) => p?.offers ?? [],
    mappers.recruitee
  );

// ---------- SmartRecruiters (official public postings API) ----------
const SR_RELEVANT = /front|react|full.?stack|javascript|typescript|web|next/i;

export const smartrecruitersMapper = (raw: any, company: string, description = ""): Job => ({
  source: "smartrecruiters",
  company: pickString(raw?.company, ["name"]) || company,
  title: pickString(raw, ["name"]),
  location: joinParts([raw?.location?.city, raw?.location?.country?.toUpperCase?.(), raw?.location?.remote ? "Remote" : ""], ", "),
  url: raw?.id ? `https://jobs.smartrecruiters.com/${company}/${raw.id}` : "",
  postedAt: toIsoDate(raw?.releasedDate),
  description,
});

/** Section texts of a posting's job ad, joined. */
export function smartrecruitersDescription(detail: any): string {
  const sections = detail?.jobAd?.sections ?? {};
  const html = Object.values(sections)
    .map((s: any) => `${s?.title ?? ""}\n${s?.text ?? ""}`)
    .join("\n");
  return pickDescription({ html }, ["html"]);
}

export async function smartrecruiters(companies: string[]): Promise<BoardOutcome> {
  const jobs: Job[] = [];
  const failedCompanies: { company: string; error: string }[] = [];
  for (const company of companies) {
    try {
      const list = await fetchJson<any>(`https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100`);
      for (const raw of list?.content ?? []) {
        // The list has no descriptions; fetch them only for plausible titles.
        let description = "";
        if (SR_RELEVANT.test(raw?.name ?? "")) {
          const detail = await fetchJson<any>(`https://api.smartrecruiters.com/v1/companies/${company}/postings/${raw.id}`).catch(() => null);
          description = smartrecruitersDescription(detail);
          await sleep(150);
        }
        const job = smartrecruitersMapper(raw, company, description);
        if (job.title && job.url) jobs.push(job);
      }
    } catch (e) {
      failedCompanies.push({ company, error: (e as Error).message });
    }
    await sleep(200);
  }
  return { jobs, failedCompanies };
}

// ---------- Personio (public XML feed, common with German companies) ----------
export function mapPersonioXml(xml: string, company: string): Job[] {
  const parsed = new XMLParser({ ignoreAttributes: true, cdataPropName: false, parseTagValue: false }).parse(xml);
  const positions = parsed?.["workzag-jobs"]?.position ?? [];
  const list = Array.isArray(positions) ? positions : [positions];
  return list
    .map((p: any): Job => {
      const descs = p?.jobDescriptions?.jobDescription ?? [];
      const html = (Array.isArray(descs) ? descs : [descs]).map((d: any) => `${d?.name ?? ""}\n${d?.value ?? ""}`).join("\n");
      const office = [p?.office, ...(Array.isArray(p?.additionalOffices?.office) ? p.additionalOffices.office : [p?.additionalOffices?.office])]
        .filter(Boolean)
        .join(", ");
      return {
        source: "personio",
        company: String(p?.subcompany || company),
        title: String(p?.name ?? "").trim(),
        location: office,
        url: p?.id ? `https://${company}.jobs.personio.de/job/${p.id}` : "",
        postedAt: toIsoDate(p?.createdAt),
        description: [p?.employmentType ? `Employment type: ${p.employmentType}` : "", pickDescription({ html }, ["html"])]
          .filter(Boolean)
          .join("\n"),
      };
    })
    .filter((j) => j.title && j.url);
}

export async function personio(companies: string[]): Promise<BoardOutcome> {
  const jobs: Job[] = [];
  const failedCompanies: { company: string; error: string }[] = [];
  for (const company of companies) {
    try {
      jobs.push(...mapPersonioXml(await fetchText(`https://${company}.jobs.personio.de/xml?language=en`), company));
    } catch (e) {
      failedCompanies.push({ company, error: (e as Error).message });
    }
    await sleep(200);
  }
  return { jobs, failedCompanies };
}
