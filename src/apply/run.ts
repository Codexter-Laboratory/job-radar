import "../env.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chromium, Browser } from "playwright";
import { ClassifiedJob } from "../types.js";
import { clientFromEnv, LlmClient } from "../pipeline/llm.js";
import { loadHistory } from "../store/history.js";
import { loadApplicant } from "./applicant.js";
import { loadApplyConfig } from "./config.js";
import { loadLedgerWithPrepared, record, saveLedger, submittedOn } from "./ledger.js";
import { selectCandidates } from "./select.js";
import { routeJob } from "./route.js";
import { resolveAggregator } from "./resolve.js";
import { applyViaForm } from "./form.js";
import { mailerFromEnv, Mailer } from "./mailer.js";
import { usage, writeCoverNote } from "./writer.js";
import { renderRun } from "./report.js";
import { Applicant, ApplicationRecord, ApplyConfig, Ledger, Route } from "./types.js";

const LATEST = "output/latest.json";

function pause(cfg: ApplyConfig): Promise<void> {
  const [lo, hi] = cfg.pauseSeconds;
  const ms = (lo + Math.random() * (hi - lo)) * 1000;
  return new Promise((r) => setTimeout(r, ms));
}

async function withPage<T>(browser: Browser, fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: "Asia/Beirut",
    viewport: { width: 1366, height: 900 },
  });
  try {
    return await fn(await context.newPage());
  } finally {
    await context.close().catch(() => undefined);
  }
}

interface Ctx {
  cfg: ApplyConfig;
  a: Applicant;
  client: LlmClient;
  mailer: Mailer | null;
  browser: Browser;
  ledger: Ledger;
  today: ApplicationRecord[];
}

function save(ctx: Ctx, rec: ApplicationRecord) {
  record(ctx.ledger, rec);
  ctx.today.push(rec);
  saveLedger(ctx.ledger);
  const tag = rec.status.toUpperCase().padEnd(8);
  console.log(`${tag} ${rec.company} | ${rec.title}${rec.reason ? `  (${rec.reason})` : ""}`);
}

async function attempt(ctx: Ctx, job: ClassifiedJob, prepReview: boolean): Promise<ApplicationRecord> {
  const base = { url: job.url, company: job.company, title: job.title, at: new Date().toISOString() };

  let route: Route = routeJob(job, { tryUnknownSites: ctx.cfg.tryUnknownSites });
  if (route.lane === "resolve") {
    route = await withPage(ctx.browser, (p) => resolveAggregator(p, job)).catch(
      (e): Route => ({ lane: "review", reason: `could not open aggregator: ${(e as Error).message.split("\n")[0]}` })
    );
  }

  const needsNote = route.lane !== "review" || prepReview;
  const note = needsNote ? await writeCoverNote(ctx.client, job, ctx.a).catch(() => null) : null;

  if (route.lane === "review") {
    return { ...base, lane: "review", status: "review", reason: route.reason, coverNote: note?.coverNote };
  }
  if (!note) {
    return { ...base, lane: route.lane, ats: route.ats, status: "failed", reason: "could not write a cover note" };
  }

  if (route.lane === "email") {
    const rec = { ...base, lane: "email" as const, email: route.email, coverNote: note.coverNote };
    if (ctx.cfg.dryRun) return { ...rec, status: "dry-run" };
    if (!ctx.mailer) return { ...rec, status: "review", reason: "SMTP not configured; send this one yourself" };
    await ctx.mailer.sendApplication(ctx.a, route.email!, note.emailSubject, note.coverNote);
    return { ...rec, status: "applied" };
  }

  const out = await withPage(ctx.browser, (page) =>
    applyViaForm(page, { job, ats: route.ats!, applyUrl: route.applyUrl!, coverNote: note.coverNote }, ctx.a, ctx.client, ctx.cfg.dryRun)
  );
  return {
    ...base,
    lane: "ats",
    ats: route.ats,
    applyUrl: route.applyUrl,
    status: out.status,
    reason: out.reason,
    screenshot: out.screenshot,
    answers: out.answers,
    coverNote: note.coverNote,
  };
}

async function main() {
  const cfg = loadApplyConfig();
  if (!cfg.enabled) {
    console.log("apply.enabled is false; nothing to do.");
    return;
  }
  if (!existsSync(LATEST)) throw new Error(`${LATEST} not found; run npm run scrape first`);

  const a = loadApplicant();
  const client = clientFromEnv();
  const mailer = mailerFromEnv();
  const jobs = JSON.parse(readFileSync(LATEST, "utf8")) as ClassifiedJob[];
  const ledger = loadLedgerWithPrepared();

  const candidates = selectCandidates(jobs, ledger, cfg, loadHistory());
  const budget = Math.max(0, cfg.dailyCap - submittedOn(ledger, new Date()));
  console.log(`${candidates.length} candidates, ${budget} submissions left today${cfg.dryRun ? ", DRY RUN" : ""}`);

  const browser = await chromium.launch({ headless: cfg.headless });
  const ctx: Ctx = { cfg, a, client, mailer, browser, ledger, today: [] };
  let submitted = 0;
  let prepared = 0;

  try {
    for (const job of candidates) {
      if (submitted >= budget) break;
      let rec: ApplicationRecord;
      try {
        rec = await attempt(ctx, job, prepared < cfg.reviewPrepLimit);
      } catch (e) {
        rec = {
          url: job.url,
          company: job.company,
          title: job.title,
          lane: "ats",
          at: new Date().toISOString(),
          status: "failed",
          reason: (e as Error).message.split("\n")[0].slice(0, 300),
        };
      }
      save(ctx, rec);
      if (rec.status === "review" && rec.coverNote) prepared++;
      if (rec.status === "applied" || rec.status === "dry-run") {
        submitted++;
        if (submitted < budget) await pause(cfg);
      }
    }
  } finally {
    await browser.close();
  }

  const report = renderRun(ctx.today, ledger, cfg.dryRun);
  writeFileSync("output/applications.md", report);
  console.log(`\nModel usage: ${usage.inputTokens} in / ${usage.outputTokens} out tokens`);
  console.log("Report: output/applications.md");

  const notifyTo = process.env.NOTIFY_EMAIL ?? a.email;
  if (mailer && ctx.today.length) {
    const sent = ctx.today.filter((r) => r.status === "applied").length;
    const review = Object.values(ledger).filter((r) => r.status === "review").length;
    await mailer
      .sendReport(notifyTo, `Job Radar: ${sent} sent, ${review} need you`, report)
      .catch((e) => console.error("report email failed:", (e as Error).message));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
