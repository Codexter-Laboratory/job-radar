import { XMLParser } from "fast-xml-parser";
import { Job } from "../types.js";
import { fetchText, sleep, stripHtml } from "../http.js";
import { pickDescription, toIsoDate } from "./util.js";

const WWR_FEEDS = [
  "https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
];

/**
 * We Work Remotely puts "Company: Title" in a single RSS title field. Split on
 * the first colon only, because titles routinely contain their own.
 */
export function parseWwrTitle(raw: string): { company: string; title: string } {
  const idx = raw.indexOf(":");
  if (idx === -1) return { company: "", title: raw.trim() };
  return {
    company: raw.slice(0, idx).trim(),
    title: raw.slice(idx + 1).trim(),
  };
}

export function mapWwrItem(item: any): Job {
  const { company, title } = parseWwrTitle(String(item?.title ?? ""));
  return {
    source: "weworkremotely",
    company,
    title,
    location: stripHtml(String(item?.region ?? "")) || "Remote",
    url: String(item?.link ?? ""),
    postedAt: toIsoDate(item?.pubDate),
    description: pickDescription(item, ["description"]),
  };
}

export async function weworkremotely(): Promise<Job[]> {
  const parser = new XMLParser();
  const jobs: Job[] = [];
  const errors: string[] = [];

  for (const feed of WWR_FEEDS) {
    try {
      const parsed = parser.parse(await fetchText(feed));
      const items = parsed?.rss?.channel?.item ?? [];
      for (const item of Array.isArray(items) ? items : [items]) {
        jobs.push(mapWwrItem(item));
      }
    } catch (e) {
      errors.push((e as Error).message);
    }
    await sleep(300);
  }

  // Both feeds down means the source is broken, not empty. Say so.
  if (jobs.length === 0 && errors.length === WWR_FEEDS.length) {
    throw new Error(`all WWR feeds failed: ${errors.join("; ")}`);
  }
  return jobs;
}

/**
 * LinkedIn's guest search endpoint works without a login but rate-limits
 * aggressively and changes its markup without notice. Treated as bonus
 * coverage: a failure here is reported but never fails the run.
 */
export async function linkedin(queries: string[]): Promise<Job[]> {
  const jobs: Job[] = [];

  for (const q of queries) {
    const url =
      "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search" +
      `?keywords=${encodeURIComponent(q)}&location=Worldwide&f_WT=2&f_TPR=r604800&start=0`;
    const html = await fetchText(url, {
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
    });
    jobs.push(...parseLinkedinCards(html));
    await sleep(1500);
  }

  return jobs;
}

/**
 * Parsed positionally: LinkedIn emits one link, one subtitle and one location
 * block per card in document order. Fragile by nature, which is why the parser
 * is isolated here and covered by a fixture test.
 */
export function parseLinkedinCards(html: string): Job[] {
  const cardRe =
    /<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<span class="sr-only">\s*([\s\S]*?)\s*<\/span>/g;
  const companyRe =
    /<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?>([\s\S]*?)<\/a>/g;
  const locRe =
    /<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/g;

  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html))) {
    links.push({ url: m[1].split("?")[0], title: stripHtml(m[2]) });
  }

  const companies: string[] = [];
  while ((m = companyRe.exec(html))) companies.push(stripHtml(m[1]));

  const locations: string[] = [];
  while ((m = locRe.exec(html))) locations.push(stripHtml(m[1]));

  return links.map((l, i) => ({
    source: "linkedin",
    company: companies[i] ?? "",
    title: l.title,
    location: locations[i] ?? "Remote",
    url: l.url,
    postedAt: "",
  }));
}

/**
 * Indeed is deliberately not implemented.
 *
 * It sits behind Cloudflare bot protection and blocks datacenter IPs within
 * minutes. Scraping it reliably needs residential proxies plus a headless
 * browser, which costs money and breaks their terms of service. The same is
 * true of Bayt and GulfTalent for Gulf coverage.
 *
 * The supported route is Indeed's own email alerts, or a paid API such as
 * SerpAPI if the cost and the terms are acceptable. Left here as a record of
 * the decision so nobody re-litigates it in six months.
 */
export const NOT_IMPLEMENTED = ["indeed", "bayt", "gulftalent"] as const;
