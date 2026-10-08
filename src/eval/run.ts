import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Classification } from "../types.js";
import { classify } from "../pipeline/classify.js";
import { clientFromEnv, estimateCostUsd, Pricing } from "../pipeline/llm.js";
import { CandidateProfile, PROMPTS } from "../pipeline/prompts.js";
import { loadGolden, goldenStats, isBalanced } from "./golden.js";
import {
  disagreements,
  EvalResult,
  formatMetrics,
  markdownRow,
  MARKDOWN_HEADER,
  metricsFrom,
} from "./score.js";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../../config.json", import.meta.url), "utf8"));
const profile: CandidateProfile = cfg.profile;
const pricing: Pricing = cfg.pricing ?? { inputPerMillion: 0.15, outputPerMillion: 0.6 };

/**
 * Usage:
 *   npm run eval              scores the default prompt
 *   npm run eval -- v1 v2 v3  scores each version against the same set
 */
async function main() {
  const versions = process.argv.slice(2).filter((v) => !v.startsWith("-"));
  const toRun = versions.length ? versions : [cfg.promptVersion ?? "v3"];

  for (const v of toRun) {
    if (!PROMPTS[v]) {
      console.error(`Unknown prompt version "${v}". Known: ${Object.keys(PROMPTS).join(", ")}`);
      process.exit(1);
    }
  }

  const golden = loadGolden();
  const stats = goldenStats(golden);

  if (stats.total === 0) {
    console.error("Golden set is empty. Run `npm run label` first.");
    process.exit(1);
  }
  if (stats.total < 30) {
    console.warn(
      `Only ${stats.total} labelled records. Scores below 100 are indicative, not reportable.\n`
    );
  }
  if (!isBalanced(stats)) {
    console.warn(
      `Class split is ${stats.eligible}/${stats.ineligible}. Interpret precision and recall with that in mind.\n`
    );
  }

  const client = clientFromEnv();
  const results: EvalResult[] = [];

  for (const version of toRun) {
    process.stdout.write(`Running ${version} over ${stats.total} records`);

    const { jobs, stats: callStats } = await classify(
      golden.map((r) => r.job),
      {
        client,
        profile,
        promptVersion: version,
        concurrency: cfg.classifierConcurrency ?? 4,
        onProgress: (done, total) => {
          if (done % 10 === 0 || done === total) process.stdout.write(".");
        },
      }
    );
    process.stdout.write("\n");

    const predictions = new Map<string, Classification>();
    golden.forEach((record, i) => predictions.set(record.id, jobs[i].classification));

    const estimatedCostUsd = estimateCostUsd(
      callStats.inputTokens,
      callStats.outputTokens,
      pricing
    );

    results.push({
      promptVersion: version,
      provider: client.provider,
      model: client.model,
      metrics: metricsFrom(golden, predictions),
      disagreements: disagreements(golden, predictions),
      cost: {
        calls: callStats.calls,
        failures: callStats.failures,
        inputTokens: callStats.inputTokens,
        outputTokens: callStats.outputTokens,
        estimatedCostUsd,
        costPerThousandPostingsUsd:
          stats.total === 0 ? 0 : (estimatedCostUsd / stats.total) * 1000,
      },
    });
  }

  console.log("");
  for (const r of results) {
    console.log(formatMetrics(r));
    console.log("");
  }

  console.log("Paste into the README:\n");
  console.log(MARKDOWN_HEADER);
  for (const r of results) console.log(markdownRow(r));

  const worst = results[results.length - 1];
  if (worst.disagreements.length) {
    console.log(`\n${worst.disagreements.length} disagreements on ${worst.promptVersion}:`);
    for (const d of worst.disagreements.slice(0, 15)) {
      console.log(
        `  [${d.expected ? "should be eligible" : "should be rejected"}] ` +
          `${d.company} — ${d.title}\n    model said: ${d.reason} (confidence ${d.confidence})` +
          (d.note ? `\n    my note: ${d.note}` : "")
      );
    }
  }

  if (!existsSync("eval/results")) mkdirSync("eval/results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = `eval/results/${stamp}.json`;
  writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
