import { ClassifiedJob } from "../types.js";
import { ApplyConfig, Ledger } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;

export function companyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Jobs worth attempting today, newest first. A job already in the ledger is
 * skipped unless it failed long enough ago to retry; review items wait for a person.
 */
export function selectCandidates(
  jobs: ClassifiedJob[],
  ledger: Ledger,
  cfg: ApplyConfig,
  firstSeen: Record<string, string>,
  now: Date = new Date()
): ClassifiedJob[] {
  const excluded = new Set(cfg.excludeCompanies.map(companyKey));
  const recentCompanies = new Set(
    Object.values(ledger)
      .filter((r) => r.status === "applied" && now.getTime() - Date.parse(r.at) < cfg.companyCooldownDays * DAY)
      .map((r) => companyKey(r.company))
  );

  const picked: ClassifiedJob[] = [];
  const pickedCompanies = new Set<string>();

  const sorted = [...jobs].sort((a, b) => (b.postedAt || "").localeCompare(a.postedAt || ""));
  for (const job of sorted) {
    const c = job.classification;
    if (!c?.eligible || c.confidence < cfg.minConfidence) continue;
    if (!cfg.employmentTypes.includes(c.employmentType)) continue;

    const key = companyKey(job.company);
    if (excluded.has(key) || recentCompanies.has(key) || pickedCompanies.has(key)) continue;

    const seen = firstSeen[job.url];
    if (seen && now.getTime() - Date.parse(seen) > cfg.maxAgeDays * DAY) continue;

    const prev = ledger[job.url];
    if (prev) {
      const retry = prev.status === "failed" && now.getTime() - Date.parse(prev.at) > cfg.retryFailedAfterDays * DAY;
      if (!retry) continue;
    }

    picked.push(job);
    pickedCompanies.add(key);
  }
  return picked;
}
