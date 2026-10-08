import { Job } from "../types.js";

export interface PrefilterConfig {
  keywords: string[];
  excludeKeywords: string[];
  locationAllow: string[];
  locationBlock: string[];
  maxAgeDays: number;
}

export type DropReason =
  | "no-keyword"
  | "excluded-keyword"
  | "blocked-location"
  | "location-not-allowed"
  | "stale";

export interface PrefilterResult {
  kept: Job[];
  dropped: { job: Job; reason: DropReason }[];
  /** How many postings each rule removed. Used to tune for recall. */
  dropCounts: Record<DropReason, number>;
}

/**
 * Stage one exists to cut volume cheaply before the classifier runs, so it is
 * deliberately tuned for recall: it is much cheaper to pay for one extra
 * classification than to never see a role that would have been a fit. Anything
 * requiring judgement (does this company hire contractors abroad?) is left to
 * stage two.
 */
export function prefilter(
  jobs: Job[],
  cfg: PrefilterConfig,
  now: number = Date.now()
): PrefilterResult {
  const maxAgeMs = cfg.maxAgeDays * 24 * 60 * 60 * 1000;
  const kept: Job[] = [];
  const dropped: { job: Job; reason: DropReason }[] = [];
  const dropCounts: Record<DropReason, number> = {
    "no-keyword": 0,
    "excluded-keyword": 0,
    "blocked-location": 0,
    "location-not-allowed": 0,
    stale: 0,
  };

  const drop = (job: Job, reason: DropReason) => {
    dropped.push({ job, reason });
    dropCounts[reason]++;
  };

  const lower = (s: string) => (s ?? "").toLowerCase();
  const kw = cfg.keywords.map(lower);
  const exclude = cfg.excludeKeywords.map(lower);
  const allow = cfg.locationAllow.map(lower);
  const block = cfg.locationBlock.map(lower);

  for (const job of jobs) {
    const title = lower(job.title);
    const loc = lower(job.location);
    const tags = lower((job.tags ?? []).join(" "));
    const haystack = `${title} ${tags}`;

    if (!kw.some((k) => haystack.includes(k))) {
      drop(job, "no-keyword");
      continue;
    }
    if (exclude.some((k) => title.includes(k))) {
      drop(job, "excluded-keyword");
      continue;
    }
    // Hard block: postings that rule out a contractor outside the named region.
    if (block.some((k) => loc.includes(k))) {
      drop(job, "blocked-location");
      continue;
    }
    // An empty location is kept on purpose: unknown is not the same as no.
    if (loc && !allow.some((k) => loc.includes(k))) {
      drop(job, "location-not-allowed");
      continue;
    }
    if (job.postedAt) {
      const t = Date.parse(job.postedAt);
      if (!Number.isNaN(t) && now - t > maxAgeMs) {
        drop(job, "stale");
        continue;
      }
    }

    kept.push(job);
  }

  return { kept, dropped, dropCounts };
}
