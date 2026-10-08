import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ApplicationRecord, Ledger } from "./types.js";

export const LEDGER_PATH = "output/applications.json";

export function loadLedger(path: string = LEDGER_PATH): Ledger {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Ledger;
  } catch {
    // Unlike seen.json, losing this would mean applying twice. Refuse to run.
    throw new Error(`${path} is corrupt; fix or restore it before applying`);
  }
}

/**
 * Cover notes and form answers include personal details (rate, phone), so they
 * live in a gitignored file. The ledger itself is safe to commit from CI.
 */
export const PREPARED_PATH = "output/private/prepared.json";
export type Prepared = Record<string, Pick<ApplicationRecord, "coverNote" | "answers">>;

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

export function saveLedger(ledger: Ledger, path: string = LEDGER_PATH, preparedPath: string = PREPARED_PATH): void {
  const publicView: Ledger = {};
  const prepared = readJson<Prepared>(preparedPath, {});
  for (const [url, rec] of Object.entries(ledger)) {
    const { coverNote, answers, ...rest } = rec;
    publicView[url] = rest;
    if (coverNote || answers) prepared[url] = { coverNote, answers };
  }
  writeJson(path, publicView);
  writeJson(preparedPath, prepared);
}

/** Ledger with the private cover notes and answers merged back in. */
export function loadLedgerWithPrepared(path: string = LEDGER_PATH, preparedPath: string = PREPARED_PATH): Ledger {
  const ledger = loadLedger(path);
  let prepared: Prepared = {};
  try {
    prepared = readJson<Prepared>(preparedPath, {});
  } catch {
    // Losing prepared notes only costs convenience.
  }
  for (const [url, extra] of Object.entries(prepared)) if (ledger[url]) Object.assign(ledger[url], extra);
  return ledger;
}

export function record(ledger: Ledger, rec: ApplicationRecord): void {
  ledger[rec.url] = rec;
}

/** Submissions that count against today's cap. Dry runs do not. */
export function submittedOn(ledger: Ledger, day: Date): number {
  const stamp = day.toISOString().slice(0, 10);
  return Object.values(ledger).filter((r) => r.status === "applied" && r.at.startsWith(stamp)).length;
}
