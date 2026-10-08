import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { EmploymentType, Job } from "../types.js";
import { appendGolden, goldenId, goldenStats, isBalanced, loadGolden, GOLDEN_PATH } from "./golden.js";

const POOL = process.argv[2] ?? "output/latest.json";
const LABELLER = process.env.LABELLER ?? "unknown";

const EMPLOYMENT_KEYS: Record<string, EmploymentType> = {
  b: "b2b",
  e: "eor",
  p: "payroll",
  u: "unknown",
};

function preview(job: Job): string {
  const body = (job.description ?? "").split("\n").filter(Boolean).slice(0, 12).join("\n");
  return [
    "",
    "─".repeat(72),
    `${job.company} — ${job.title}`,
    `${job.source} · ${job.location || "(no location)"} · ${job.postedAt.slice(0, 10) || "(no date)"}`,
    job.url,
    "",
    body || "(no description published)",
    "─".repeat(72),
  ].join("\n");
}

async function main() {
  if (!existsSync(POOL)) {
    console.error(`No pool at ${POOL}. Run \`npm run scrape\` first, or pass a path.`);
    process.exit(1);
  }

  const pool: Job[] = JSON.parse(readFileSync(POOL, "utf8"));
  const already = new Set(loadGolden().map((r) => r.id));
  const queue = pool.filter((j) => !already.has(goldenId(j)));

  if (queue.length === 0) {
    console.log("Everything in the pool is already labelled.");
    return;
  }

  console.log(
    `${queue.length} unlabelled postings. ${already.size} already in ${GOLDEN_PATH}.\n` +
      `y = eligible, n = not eligible, s = skip, q = save and quit.`
  );

  const rl = createInterface({ input: stdin, output: stdout });
  let labelled = 0;

  try {
    for (const job of queue) {
      console.log(preview(job));

      const verdict = (await rl.question("eligible? [y/n/s/q] ")).trim().toLowerCase();
      if (verdict === "q") break;
      if (verdict === "s" || !["y", "n"].includes(verdict)) continue;

      const typeKey = (
        await rl.question("employment type? [b]2b [e]or [p]ayroll [u]nknown ")
      )
        .trim()
        .toLowerCase();
      const note = (await rl.question("note (optional): ")).trim();

      appendGolden({
        id: goldenId(job),
        job,
        label: {
          eligible: verdict === "y",
          employmentType: EMPLOYMENT_KEYS[typeKey] ?? "unknown",
          note: note || undefined,
        },
        labelledAt: new Date().toISOString(),
        labelledBy: LABELLER,
      });

      labelled++;
    }
  } finally {
    rl.close();
  }

  const stats = goldenStats(loadGolden());
  console.log(
    `\nLabelled ${labelled} this session. Golden set: ${stats.total} ` +
      `(${stats.eligible} eligible, ${stats.ineligible} not).`
  );

  if (stats.total < 100) {
    console.log(`Aim for at least 100 before quoting a score. ${100 - stats.total} to go.`);
  }
  if (stats.total >= 20 && !isBalanced(stats)) {
    console.log(
      "Warning: the set is lopsided. Label more of the minority class or the " +
        "precision and recall numbers will not mean much."
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
