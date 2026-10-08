import type { Page } from "playwright";
import { ClassifiedJob } from "../types.js";
import { routeJob } from "./route.js";
import { Route } from "./types.js";
import { dismissBanners } from "./form.js";

/**
 * Aggregator postings link out to the real application. Open the page, find
 * the outbound link, and route that instead.
 */
export async function resolveAggregator(page: Page, job: ClassifiedJob): Promise<Route> {
  await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await dismissBanners(page);

  const hrefs = await page.locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  for (const href of hrefs) {
    const r = routeJob({ ...job, url: href, description: "" });
    if ((r.lane === "ats" && r.ats !== "generic") || (r.lane === "email" && href.startsWith("mailto:"))) return r;
  }

  const apply = page.getByRole("link", { name: /apply/i }).or(page.getByRole("button", { name: /apply/i })).first();
  if (await apply.isVisible({ timeout: 2000 }).catch(() => false)) {
    const popup = page.context().waitForEvent("page", { timeout: 8000 }).catch(() => null);
    await apply.click({ timeout: 5000 }).catch(() => undefined);
    const newPage = await popup;
    const target = newPage ?? page;
    await target.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
    const url = target.url();
    if (newPage) await newPage.close().catch(() => undefined);
    const r = routeJob({ ...job, url, description: job.description });
    if (r.lane !== "resolve") return r;
  }

  return { lane: "review", reason: "could not find where the aggregator sends applications" };
}
