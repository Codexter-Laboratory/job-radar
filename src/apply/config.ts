import { readFileSync } from "node:fs";
import { ApplyConfig } from "./types.js";

export const DEFAULTS: ApplyConfig = {
  enabled: true,
  dryRun: true,
  dailyCap: 8,
  minConfidence: 0.8,
  employmentTypes: ["b2b", "unknown"],
  companyCooldownDays: 60,
  maxAgeDays: 10,
  retryFailedAfterDays: 2,
  reviewPrepLimit: 10,
  excludeCompanies: [],
  tryUnknownSites: true,
  headless: true,
  pauseSeconds: [25, 70],
};

export function loadApplyConfig(path = new URL("../../config.json", import.meta.url)): ApplyConfig {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const merged = { ...DEFAULTS, ...(cfg.apply ?? {}) } as ApplyConfig;
  if (process.env.APPLY_DRY_RUN) merged.dryRun = process.env.APPLY_DRY_RUN !== "false";
  if (process.env.HEADLESS) merged.headless = process.env.HEADLESS !== "false";
  return merged;
}
