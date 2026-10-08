import type { Browser } from "playwright";
import { Job } from "../types.js";
import { fetchText, sleep, stripHtml, truncate } from "../http.js";
import { MAX_DESCRIPTION_CHARS, toIsoDate } from "./util.js";

/**
 * Crawls two kinds of site that have no API:
 *  - job boards (justjoin.it, nofluffjobs...) given a listing URL and a pattern for offer links
 *  - company websites given only a domain; the careers page is found automatically
 *
 * Postings are read from schema.org JobPosting JSON-LD, which most boards and
 * career pages publish so Google Jobs can index them. Company pages are also
 * scanned for ATS embeds (Greenhouse, Lever...), and those boards are then
 * fetched through their APIs like any configured company.
 */

export interface BoardSite {
  name: string;
  url: string;
  /** Substring or regex source matched against link paths to find offer pages. */
  linkPattern: string;
  maxJobs?: number;
}

export interface CrawlOptions {
  maxJobsPerSite: number;
  delayMs: number;
  /** Render with a headless browser when the static HTML has nothing usable. */
  render: boolean;
}

export type DiscoveredAts = Record<"greenhouse" | "lever" | "ashby" | "workable" | "recruitee" | "smartrecruiters" | "personio", string[]>;

export interface CompanyCrawl {
  jobs: Job[];
  discovered: DiscoveredAts;
  failedCompanies: { company: string; error: string }[];
}

// ---------- JSON-LD ----------

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

/** Every JSON-LD object on the page, flattening arrays and @graph. */
export function extractJsonLd(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim().replace(/^<!--|-->$/g, ""));
      const stack = asArray(data);
      while (stack.length) {
        const item = stack.shift();
        if (!item || typeof item !== "object") continue;
        out.push(item);
        stack.push(...asArray(item["@graph"]));
        if (item["@type"] === "ItemList") stack.push(...asArray(item.itemListElement).map((e: any) => e?.item ?? e));
      }
    } catch {
      // A broken block should not hide the others.
    }
  }
  return out;
}

const isJobPosting = (o: any) => asArray(o?.["@type"]).includes("JobPosting");

function placeName(p: any): string {
  const a = p?.address ?? p;
  if (typeof a === "string") return a;
  const country = typeof a?.addressCountry === "string" ? a.addressCountry : a?.addressCountry?.name;
  return [a?.addressLocality, country].filter(Boolean).join(", ") || (typeof p?.name === "string" ? p.name : "");
}

function salaryText(s: any): string | undefined {
  const v = s?.value;
  if (!v) return undefined;
  const amount = v.minValue && v.maxValue ? `${v.minValue}-${v.maxValue}` : v.value ?? v.minValue ?? v.maxValue;
  if (!amount) return undefined;
  return [amount, s.currency, v.unitText ? `per ${String(v.unitText).toLowerCase()}` : ""].filter(Boolean).join(" ");
}

export function jobFromJsonLd(o: any, pageUrl: string, source: string, fallbackCompany = ""): Job {
  const remote = asArray(o.jobLocationType).some((t: string) => /telecommute|remote/i.test(String(t)));
  const applicantRegions = asArray(o.applicantLocationRequirements).map(placeName).filter(Boolean);
  const places = asArray(o.jobLocation).map(placeName).filter(Boolean);
  const types = asArray(o.employmentType).map(String);
  const company =
    (typeof o.hiringOrganization === "string" ? o.hiringOrganization : o.hiringOrganization?.name) || fallbackCompany;

  const header = [
    types.length ? `Employment type: ${types.join(", ")}` : "",
    applicantRegions.length ? `Applicants must be located in: ${applicantRegions.join(", ")}` : "",
  ].filter(Boolean);

  return {
    source,
    company: String(company).trim(),
    title: String(o.title ?? "").trim(),
    location: [remote ? "Remote" : "", ...applicantRegions, ...places].filter(Boolean).join(" / "),
    url: (typeof o.url === "string" && o.url.startsWith("http") ? o.url : pageUrl).trim(),
    postedAt: toIsoDate(o.datePosted),
    salary: salaryText(o.baseSalary),
    tags: types.length ? types.map((t) => t.toLowerCase()) : undefined,
    description: truncate([...header, stripHtml(String(o.description ?? ""))].filter(Boolean).join("\n"), MAX_DESCRIPTION_CHARS),
  };
}

// ---------- ATS discovery ----------

const ATS_PATTERNS: [keyof DiscoveredAts, RegExp][] = [
  ["greenhouse", /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([a-z0-9_-]+)/gi],
  ["greenhouse", /greenhouse\.io\/embed\/job_(?:board|app)[^"'\s]*[?&]for=([a-z0-9_-]+)/gi],
  ["lever", /jobs(?:\.eu)?\.lever\.co\/([a-z0-9_.-]+)/gi],
  ["ashby", /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/gi],
  ["workable", /apply\.workable\.com\/([a-z0-9_-]+)/gi],
  ["recruitee", /\/\/([a-z0-9-]+)\.recruitee\.com/gi],
  ["smartrecruiters", /(?:careers|jobs)\.smartrecruiters\.com\/([a-z0-9_-]+)/gi],
  ["personio", /\/\/([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/gi],
];

const NOT_SLUGS = new Set(["embed", "api", "v1", "jobs", "j", "www", "static", "assets", "app", "widget", "careers", "js"]);

export function discoverAts(html: string): Partial<DiscoveredAts> {
  const found: Partial<DiscoveredAts> = {};
  for (const [ats, re] of ATS_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const slug = decodeURIComponent(m[1]).toLowerCase().replace(/\.$/, "");
      if (!slug || NOT_SLUGS.has(slug)) continue;
      const list = (found[ats] ??= []);
      if (!list.includes(slug)) list.push(slug);
    }
  }
  return found;
}

// ---------- robots.txt ----------

/** Disallowed path prefixes for user-agent * (simple, conservative). */
export function parseRobots(txt: string): string[] {
  const out: string[] = [];
  let applies = false;
  let inAgents = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const [k, ...rest] = line.split(":");
    const key = k?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (!inAgents) applies = false;
      inAgents = true;
      if (value === "*") applies = true;
    } else if (key) {
      inAgents = false;
      if (applies && key === "disallow" && value) out.push(value);
    }
  }
  return out;
}

export function robotsAllows(disallow: string[], path: string): boolean {
  return !disallow.some((rule) => {
    const pattern = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + pattern + (rule.endsWith("$") ? "" : "")).test(path);
  });
}

// ---------- fetching ----------

export class Fetcher {
  private robots = new Map<string, string[]>();
  private browser: Browser | null = null;

  constructor(private opts: CrawlOptions) {}

  private async allowed(url: URL): Promise<boolean> {
    if (!this.robots.has(url.host)) {
      const txt = await fetchText(`${url.origin}/robots.txt`).catch(() => "");
      this.robots.set(url.host, parseRobots(txt));
    }
    return robotsAllows(this.robots.get(url.host)!, url.pathname);
  }

  async html(url: string, render = false): Promise<string> {
    const u = new URL(url);
    if (!(await this.allowed(u))) throw new Error(`robots.txt disallows ${u.pathname} on ${u.host}`);
    await sleep(this.opts.delayMs);
    if (!render) return fetchText(url, { Accept: "text/html" });
    if (!this.browser) {
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch({ headless: true });
    }
    const page = await this.browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      return await page.content();
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}

export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  const re = /href=["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, "&"), base);
      if (u.protocol.startsWith("http")) out.add(u.toString());
    } catch {
      // ignore malformed href
    }
  }
  return [...out];
}

function toPattern(p: string): RegExp {
  try {
    return new RegExp(p, "i");
  } catch {
    return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

async function postingsFrom(fetcher: Fetcher, urls: string[], source: string, company = ""): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const url of urls) {
    const html = await fetcher.html(url).catch(() => "");
    for (const o of extractJsonLd(html).filter(isJobPosting)) {
      const job = jobFromJsonLd(o, url, source, company);
      if (job.title && job.url) jobs.push(job);
    }
  }
  return jobs;
}

// ---------- job boards ----------

export async function crawlBoards(boards: BoardSite[], opts: CrawlOptions): Promise<Job[]> {
  const fetcher = new Fetcher(opts);
  const jobs: Job[] = [];
  try {
    for (const b of boards) {
      const pattern = toPattern(b.linkPattern);
      const host = new URL(b.url).host;
      const pick = (html: string) =>
        extractLinks(html, b.url).filter((l) => new URL(l).host === host && pattern.test(new URL(l).pathname));

      let listing = await fetcher.html(b.url).catch(() => "");
      let links = pick(listing);
      if (!links.length && opts.render) {
        listing = await fetcher.html(b.url, true).catch(() => "");
        links = pick(listing);
      }
      // Some listings carry the postings inline.
      const inline = extractJsonLd(listing).filter(isJobPosting).map((o) => jobFromJsonLd(o, b.url, b.name));
      jobs.push(...inline.filter((j) => j.title));
      jobs.push(...(await postingsFrom(fetcher, links.slice(0, b.maxJobs ?? opts.maxJobsPerSite), b.name)));
    }
  } finally {
    await fetcher.close();
  }
  return jobs;
}

// ---------- company websites ----------

const CAREER_LINK = /career|jobs?\b|join|work-with-us|hiring|vacanc|openings|positions|team\/?$/i;
const CAREER_PATHS = ["/careers", "/career", "/jobs", "/join-us", "/careers/jobs"];
const JOB_LINK = /\/(jobs?|careers?|positions?|openings?|vacanc(y|ies)|offers?|o)\/[^/?#]{3,}/i;

function companyNameFromDomain(domain: string): string {
  const base = domain.replace(/^www\./, "").split(".")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

async function crawlOneCompany(fetcher: Fetcher, domain: string, opts: CrawlOptions) {
  const origin = domain.startsWith("http") ? new URL(domain).origin : `https://${domain.replace(/\/+$/, "")}`;
  const company = companyNameFromDomain(new URL(origin).hostname);
  const discovered: Partial<DiscoveredAts> = {};
  const merge = (d: Partial<DiscoveredAts>) => {
    for (const [k, v] of Object.entries(d) as [keyof DiscoveredAts, string[]][]) {
      const list = (discovered[k] ??= []);
      for (const s of v) if (!list.includes(s)) list.push(s);
    }
  };

  const home = await fetcher.html(origin);
  merge(discoverAts(home));
  const host = new URL(origin).host.replace(/^www\./, "");
  const sameSite = (l: string) => new URL(l).host.replace(/^www\./, "") === host;

  const careerPages = [
    ...extractLinks(home, origin).filter((l) => sameSite(l) && CAREER_LINK.test(new URL(l).pathname)),
    ...CAREER_PATHS.map((p) => origin + p),
  ];
  const visited = new Set<string>();
  const jobLinks = new Set<string>();
  const jobs: Job[] = [];

  for (const page of careerPages) {
    if (visited.size >= 3) break;
    const key = page.replace(/\/+$/, "");
    if (visited.has(key)) continue;
    let html = await fetcher.html(page).catch(() => "");
    if (!html) continue;
    visited.add(key);
    if (opts.render && !Object.keys(discoverAts(html)).length && !extractJsonLd(html).some(isJobPosting)) {
      // Career pages are often client-rendered widgets.
      html = (await fetcher.html(page, true).catch(() => "")) || html;
    }
    merge(discoverAts(html));
    for (const o of extractJsonLd(html).filter(isJobPosting)) jobs.push(jobFromJsonLd(o, page, "company-site", company));
    for (const l of extractLinks(html, page)) {
      if (sameSite(l) && JOB_LINK.test(new URL(l).pathname) && l.replace(/\/+$/, "") !== key) jobLinks.add(l);
    }
  }

  jobs.push(...(await postingsFrom(fetcher, [...jobLinks].slice(0, opts.maxJobsPerSite), "company-site", company)));
  return { jobs: jobs.filter((j) => j.title), discovered, visited: visited.size };
}

export async function crawlCompanies(domains: string[], opts: CrawlOptions): Promise<CompanyCrawl> {
  const fetcher = new Fetcher(opts);
  const result: CompanyCrawl = {
    jobs: [],
    discovered: { greenhouse: [], lever: [], ashby: [], workable: [], recruitee: [], smartrecruiters: [], personio: [] },
    failedCompanies: [],
  };
  try {
    for (const domain of domains) {
      try {
        const r = await crawlOneCompany(fetcher, domain, opts);
        result.jobs.push(...r.jobs);
        for (const [k, v] of Object.entries(r.discovered) as [keyof DiscoveredAts, string[]][]) {
          for (const s of v) if (!result.discovered[k].includes(s)) result.discovered[k].push(s);
        }
        const found = r.jobs.length + Object.values(r.discovered).flat().length;
        if (!found) result.failedCompanies.push({ company: domain, error: r.visited ? "no postings or ATS found" : "no careers page found" });
      } catch (e) {
        result.failedCompanies.push({ company: domain, error: (e as Error).message.split("\n")[0] });
      }
    }
  } finally {
    await fetcher.close();
  }
  return result;
}
