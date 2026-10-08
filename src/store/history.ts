import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Job } from "../types.js";

export const HISTORY_PATH = "output/seen.json";

/**
 * URL to the date it was first seen. Deliberately a flat JSON file rather than
 * SQLite: it survives being committed by CI, diffs readably in a pull request,
 * and stays well under a megabyte at this volume. Revisit if the corpus passes
 * a few tens of thousands of postings.
 */
export type History = Record<string, string>;

export function loadHistory(path: string = HISTORY_PATH): History {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as History;
  } catch {
    // A corrupt history costs one day of "new" flags, not the run.
    return {};
  }
}

export function saveHistory(history: History, path: string = HISTORY_PATH): void {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(history, null, 2));
}

export interface HistoryUpdate {
  history: History;
  isNew: (job: Job) => boolean;
  newCount: number;
}

export function applyHistory(
  jobs: Job[],
  history: History,
  now: Date = new Date()
): HistoryUpdate {
  const stamp = now.toISOString().slice(0, 10);
  const updated: History = { ...history };
  const fresh = new Set<string>();

  for (const job of jobs) {
    if (!job.url) continue;
    if (!updated[job.url]) {
      updated[job.url] = stamp;
      fresh.add(job.url);
    }
  }

  return {
    history: updated,
    isNew: (job) => fresh.has(job.url),
    newCount: fresh.size,
  };
}

/** How long a posting has been in the corpus, in days. */
export function ageInDays(job: Job, history: History, now: Date = new Date()): number | null {
  const firstSeen = history[job.url];
  if (!firstSeen) return null;
  const ms = now.getTime() - Date.parse(firstSeen);
  return Number.isNaN(ms) ? null : Math.floor(ms / (24 * 60 * 60 * 1000));
}
