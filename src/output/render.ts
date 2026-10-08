import { ClassifiedJob, RunReport } from "../types.js";
import { History, ageInDays } from "../store/history.js";

const CSV_COLUMNS = [
  "source",
  "company",
  "title",
  "location",
  "salary",
  "postedAt",
  "eligible",
  "employmentType",
  "confidence",
  "regionConstraint",
  "reason",
  "url",
] as const;

function csvEscape(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function toCsv(jobs: ClassifiedJob[]): string {
  const rows = jobs.map((j) =>
    [
      j.source,
      j.company,
      j.title,
      j.location,
      j.salary ?? "",
      j.postedAt,
      j.classification.eligible,
      j.classification.employmentType,
      j.classification.confidence,
      j.classification.regionConstraint,
      j.classification.reason,
      j.url,
    ]
      .map(csvEscape)
      .join(",")
  );

  return [CSV_COLUMNS.join(","), ...rows].join("\n");
}

export interface DigestOptions {
  history: History;
  isNew: (job: ClassifiedJob) => boolean;
  /** Postings below this confidence go to a review list rather than the main one. */
  reviewBelow: number;
  now?: Date;
}

/**
 * The digest is the part a person actually reads, so it leads with what changed
 * since yesterday and puts anything the model was unsure about in a separate
 * pile instead of hiding it.
 */
export function toDigest(
  jobs: ClassifiedJob[],
  report: RunReport,
  opts: DigestOptions
): string {
  const now = opts.now ?? new Date();
  const eligible = jobs.filter((j) => j.classification.eligible);
  const confident = eligible.filter((j) => j.classification.confidence >= opts.reviewBelow);
  const review = eligible.filter((j) => j.classification.confidence < opts.reviewBelow);
  const fresh = confident.filter(opts.isNew);
  const ongoing = confident.filter((j) => !opts.isNew(j));

  const line = (j: ClassifiedJob) => {
    const age = ageInDays(j, opts.history, now);
    const seen = age === null || age === 0 ? "" : ` · seen ${age}d`;
    const salary = j.salary ? ` · ${j.salary}` : "";
    return [
      `- **[${j.title}](${j.url})** — ${j.company}`,
      `  ${j.location || "location not stated"} · ${j.classification.employmentType}${salary}${seen}`,
      `  ${j.classification.reason}`,
    ].join("\n");
  };

  const out: string[] = [
    `# Job radar — ${now.toISOString().slice(0, 10)}`,
    "",
    `${fresh.length} new, ${ongoing.length} still open, ${review.length} needing a look.`,
    "",
  ];

  if (fresh.length) {
    out.push("## New today", "", ...fresh.map(line), "");
  }
  if (ongoing.length) {
    out.push("## Still open", "", ...ongoing.map(line), "");
  }
  if (review.length) {
    out.push(
      "## Low confidence, worth a glance",
      "",
      ...review.map(
        (j) =>
          `- [${j.title}](${j.url}) — ${j.company} · confidence ${j.classification.confidence}\n  ${j.classification.reason}`
      ),
      ""
    );
  }
  if (!fresh.length && !ongoing.length && !review.length) {
    out.push("Nothing matched today.", "");
  }

  const failed = report.sources.filter((s) => !s.ok);
  if (failed.length) {
    out.push(
      "## Sources that failed",
      "",
      ...failed.map((s) => `- ${s.source}: ${s.error}`),
      ""
    );
  }

  return out.join("\n");
}
