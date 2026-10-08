import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GoldenRecord, Job } from "../types.js";

export const GOLDEN_PATH = "eval/golden.jsonl";

/**
 * Stable id from the posting URL, so relabelling the same posting overwrites
 * the old record instead of adding a duplicate.
 */
export function goldenId(job: Job): string {
  return createHash("sha1").update(job.url || `${job.company}|${job.title}`).digest("hex").slice(0, 12);
}

/** JSONL rather than one JSON array: appending a label never rewrites the file. */
export function loadGolden(path: string = GOLDEN_PATH): GoldenRecord[] {
  if (!existsSync(path)) return [];

  const byId = new Map<string, GoldenRecord>();
  const lines = readFileSync(path, "utf8").split("\n");

  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as GoldenRecord;
      // Later lines win, which makes a correction a plain append.
      byId.set(record.id, record);
    } catch {
      throw new Error(`${path}:${i + 1} is not valid JSON`);
    }
  }

  return [...byId.values()];
}

export function appendGolden(record: GoldenRecord, path: string = GOLDEN_PATH): void {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, existing + sep + JSON.stringify(record) + "\n");
}

export interface GoldenStats {
  total: number;
  eligible: number;
  ineligible: number;
  byEmploymentType: Record<string, number>;
}

export function goldenStats(records: GoldenRecord[]): GoldenStats {
  const byEmploymentType: Record<string, number> = {};
  let eligible = 0;

  for (const r of records) {
    if (r.label.eligible) eligible++;
    byEmploymentType[r.label.employmentType] =
      (byEmploymentType[r.label.employmentType] ?? 0) + 1;
  }

  return {
    total: records.length,
    eligible,
    ineligible: records.length - eligible,
    byEmploymentType,
  };
}

/**
 * A golden set that is 90% one class makes precision and recall meaningless,
 * so the labelling tool warns when the split drifts.
 */
export function isBalanced(stats: GoldenStats, tolerance = 0.25): boolean {
  if (stats.total === 0) return false;
  const share = stats.eligible / stats.total;
  return Math.abs(share - 0.5) <= tolerance;
}
