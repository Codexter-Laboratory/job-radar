import "./env.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ClassifiedJob, Job, RunReport, SourceReport } from "./types.js";
import { greenhouse, lever, ashby, workable, recruitee, smartrecruiters, personio } from "./sources/ats.js";
import { crawlBoards, crawlCompanies, CrawlOptions } from "./sources/web.js";
import { remotive, remoteok, arbeitnow, himalayas, jobicy } from "./sources/boards.js";
import { weworkremotely, linkedin } from "./sources/misc.js";
import { prefilter } from "./pipeline/prefilter.js";
import { dedupe } from "./pipeline/dedupe.js";
import { classify, UNCLASSIFIED } from "./pipeline/classify.js";
import { clientFromEnv, estimateCostUsd } from "./pipeline/llm.js";
import { isRunHealthy, runSource, summarise } from "./pipeline/report.js";
import { applyHistory, loadHistory, saveHistory } from "./store/history.js";
import { toCsv, toDigest } from "./output/render.js";

const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const OUT = "output";

/** Skip stage two when no key is configured, so the pipeline still runs. */
const classifierEnabled =
  cfg.classifier?.enabled !== false &&
  Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_BASE_URL);

async function collect(): Promise<{ jobs: Job[]; reports: SourceReport[] }> {
  const jobs: Job[] = [];
  const reports: SourceReport[] = [];

  const crawl: CrawlOptions = { maxJobsPerSite: 30, delayMs: 800, render: true, ...(cfg.crawl ?? {}) };
  const unique = (...lists: (string[] | undefined)[]) => [...new Set(lists.flat().filter(Boolean) as string[])];

  // Company websites first: any ATS they embed is added to the board lists below.
  const sites = await runSource(
    "company-sites",
    () => crawlCompanies(cfg.companySites ?? [], crawl),
    (r) => r.jobs.length
  );
  const found = sites.result?.discovered;
  if (sites.result) {
    jobs.push(...sites.result.jobs);
    const total = (cfg.companySites ?? []).length;
    const failed = sites.result.failedCompanies;
    if (failed.length) sites.report.error = `${failed.length}/${total} site(s) gave nothing: ${failed.map((f) => f.company).join(", ")}`;
    if (total && failed.length === total) sites.report.ok = false;
    const extra = Object.entries(found ?? {}).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(", ")}`);
    if (extra.length) console.log(`Discovered on company sites -> ${extra.join("; ")}`);
  }
  reports.push(sites.report);

  // ATS boards next so their records win dedupe over aggregator copies.
  const boardSources = [
    ["greenhouse", () => greenhouse(unique(cfg.greenhouseCompanies, found?.greenhouse))],
    ["lever", () => lever(unique(cfg.leverCompanies, found?.lever))],
    ["ashby", () => ashby(unique(cfg.ashbyCompanies, found?.ashby))],
    ["workable", () => workable(unique(cfg.workableCompanies, found?.workable))],
    ["recruitee", () => recruitee(unique(cfg.recruiteeCompanies, found?.recruitee))],
    ["smartrecruiters", () => smartrecruiters(unique(cfg.smartrecruitersCompanies, found?.smartrecruiters))],
    ["personio", () => personio(unique(cfg.personioCompanies, found?.personio))],
  ] as const;

  for (const [name, fn] of boardSources) {
    const { report, result } = await runSource(name, fn, (r) => r.jobs.length);
    if (result) {
      jobs.push(...result.jobs);
      if (result.failedCompanies.length) {
        // A board that is up but whose slugs have rotted is still a problem.
        report.error = `${result.failedCompanies.length} company slug(s) failed: ${result.failedCompanies
          .map((f) => f.company)
          .join(", ")}`;
        // Every slug failing means the adapter or the API is broken, not that
        // these companies are all quiet today.
        if (result.jobs.length === 0) report.ok = false;
      }
    }
    reports.push(report);
  }

  const feedSources = [
    ["remotive", remotive],
    ["remoteok", remoteok],
    ["arbeitnow", () => arbeitnow(3)],
    ["himalayas", himalayas],
    ["jobicy", jobicy],
    ["weworkremotely", weworkremotely],
    ["linkedin", () => linkedin(cfg.linkedinQueries ?? [])],
    ["job-boards", () => crawlBoards(cfg.jobBoards ?? [], crawl)],
  ] as const;

  for (const [name, fn] of feedSources) {
    const { report, result } = await runSource(name, fn, (r) => r.length);
    if (result) jobs.push(...result);
    reports.push(report);
  }

  return { jobs, reports };
}

async function main() {
  const startedAt = new Date().toISOString();

  const { jobs: raw, reports } = await collect();

  const pre = prefilter(raw, cfg, Date.now());
  const deduped = dedupe(pre.kept);
  deduped.jobs.sort((a, b) => (b.postedAt || "").localeCompare(a.postedAt || ""));

  let classified: ClassifiedJob[];
  let classifierReport: RunReport["classifier"];

  if (classifierEnabled && deduped.jobs.length) {
    const client = clientFromEnv();
    const { jobs, stats } = await classify(deduped.jobs, {
      client,
      profile: cfg.profile,
      promptVersion: cfg.promptVersion,
      concurrency: cfg.classifierConcurrency ?? 4,
    });
    classified = jobs;
    classifierReport = {
      provider: client.provider,
      model: client.model,
      calls: stats.calls,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      estimatedCostUsd: estimateCostUsd(stats.inputTokens, stats.outputTokens, cfg.pricing),
    };
  } else {
    // Without a key the prefilter output is still useful; it is just unjudged.
    classified = deduped.jobs.map((j) => ({
      ...j,
      classification: { ...UNCLASSIFIED, eligible: true, reason: "classifier disabled" },
    }));
  }

  const history = loadHistory();
  const update = applyHistory(classified, history);

  const report: RunReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    sources: reports,
    totals: {
      fetched: raw.length,
      afterPrefilter: pre.kept.length,
      afterDedupe: deduped.jobs.length,
      classified: classified.length,
      eligible: classified.filter((j) => j.classification.eligible).length,
      newSinceLastRun: update.newCount,
    },
    classifier: classifierReport,
  };

  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const eligible = classified.filter((j) => j.classification.eligible);

  writeFileSync(`${OUT}/latest.json`, JSON.stringify(classified, null, 2));
  writeFileSync(`${OUT}/latest.csv`, toCsv(classified));
  writeFileSync(`${OUT}/jobs-${stamp}.json`, JSON.stringify(eligible, null, 2));
  writeFileSync(`${OUT}/run-report.json`, JSON.stringify(report, null, 2));
  writeFileSync(
    `${OUT}/digest.md`,
    toDigest(classified, report, {
      history: update.history,
      isNew: update.isNew,
      reviewBelow: cfg.reviewBelowConfidence ?? 0.6,
    })
  );
  saveHistory(update.history);

  console.log(summarise(report));
  console.log(`\nDropped by the prefilter:`, pre.dropCounts);
  console.log(`Deduped away: ${deduped.removed}`);

  if (!isRunHealthy(report)) {
    console.error("\nMore than half the sources failed. Treating this run as broken.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
