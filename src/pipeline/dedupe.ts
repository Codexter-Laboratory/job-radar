import { Job } from "../types.js";

const NOISE_PHRASES = [
  "remote",
  "fully remote",
  "work from home",
  "wfh",
  "contract",
  "contractor",
  "freelance",
  "b2b",
  "full time",
  "full-time",
  "part time",
  "m/f/d",
  "m/w/d",
  "f/m/d",
  "h/f",
  "all genders",
];

/**
 * The same role is routinely cross-posted with cosmetic differences:
 * "Senior Frontend Engineer (Remote)" on one board, "Senior Frontend Engineer
 * - Remote, EMEA (m/f/d)" on another. Exact string matching misses all of it,
 * so titles are reduced to a comparable core first.
 */
export function normaliseTitle(title: string): string {
  let t = (title ?? "").toLowerCase();

  t = t.replace(/\([^)]*\)/g, " "); // drop parentheticals
  t = t.replace(/\[[^\]]*\]/g, " ");
  // Gender markers (m/w/d, m/f/d, h/f) must go before separators are collapsed,
  // otherwise they become ordinary words and survive the noise pass.
  t = t.replace(/\b[mfhw](\s*\/\s*[mfhwdx])+\b/g, " ");
  t = t.replace(/[–—|/,:]+/g, " "); // separators used before location suffixes
  t = t.replace(/[^a-z0-9+#. ]/g, " ");

  for (const phrase of NOISE_PHRASES) {
    t = t.replace(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  }

  return t.replace(/\s+/g, " ").trim();
}

export function normaliseCompany(company: string): string {
  return (company ?? "")
    .toLowerCase()
    .replace(/\b(gmbh|ltd|limited|inc|llc|b\.?v\.?|s\.?a\.?|ag|oy|ab)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Two postings for the same URL are the same posting, whatever they are called. */
function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return `${u.host}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return (url ?? "").toLowerCase();
  }
}

export interface DedupeResult {
  jobs: Job[];
  removed: number;
}

/**
 * Keeps the first occurrence. Sources are scraped in a fixed order with the
 * ATS boards first, so the surviving record is the one closest to the employer
 * rather than an aggregator's copy of it.
 */
export function dedupe(jobs: Job[]): DedupeResult {
  const seen = new Set<string>();
  const out: Job[] = [];

  for (const job of jobs) {
    const urlKey = `u:${canonicalUrl(job.url)}`;
    const titleKey = `t:${normaliseCompany(job.company)}|${normaliseTitle(job.title)}`;

    if (seen.has(urlKey) || seen.has(titleKey)) continue;

    seen.add(urlKey);
    seen.add(titleKey);
    out.push(job);
  }

  return { jobs: out, removed: jobs.length - out.length };
}
