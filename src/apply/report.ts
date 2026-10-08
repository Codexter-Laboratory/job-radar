import { ApplicationRecord, Ledger } from "./types.js";

function line(r: ApplicationRecord): string {
  return `- **${r.company}**, ${r.title}  \n  ${r.applyUrl ?? r.url}${r.email ? ` (email ${r.email})` : ""}`;
}

/** Today's results plus every open review item, newest first. */
export function renderRun(today: ApplicationRecord[], ledger: Ledger, dryRun: boolean): string {
  const applied = today.filter((r) => r.status === "applied");
  const dry = today.filter((r) => r.status === "dry-run");
  const failed = today.filter((r) => r.status === "failed");
  const review = Object.values(ledger)
    .filter((r) => r.status === "review")
    .sort((a, b) => b.at.localeCompare(a.at));

  const out: string[] = [`# Applications ${new Date().toISOString().slice(0, 10)}${dryRun ? " (dry run)" : ""}`, ""];

  out.push(`## Submitted today (${applied.length})`, "");
  out.push(...(applied.length ? applied.map(line) : ["None."]), "");

  if (dry.length) {
    out.push(`## Filled but not submitted, dry run (${dry.length})`, "");
    out.push(...dry.map((r) => `${line(r)}  \n  screenshot: ${r.screenshot}`), "");
  }

  out.push(`## Needs you (${review.length})`, "");
  if (!review.length) out.push("Nothing.", "");
  for (const r of review) {
    out.push(line(r), `  why: ${r.reason ?? "manual site"}`);
    if (r.screenshot) out.push(`  screenshot: ${r.screenshot}`);
    if (r.answers && Object.keys(r.answers).length) {
      out.push("  prepared answers:");
      for (const [q, a] of Object.entries(r.answers)) out.push(`    - ${q}: ${a.replace(/\n/g, " ")}`);
    }
    if (r.coverNote) out.push("", "  cover note:", "", ...r.coverNote.split("\n").map((l) => `  > ${l}`));
    out.push("");
  }

  if (failed.length) {
    out.push(`## Errors (${failed.length}), retried automatically later`, "");
    out.push(...failed.map((r) => `${line(r)}  \n  ${r.reason}`), "");
  }

  out.push("Mark a review item done by setting its status to \"applied\" in output/applications.json, or run `npm run done -- <url>`.");
  return out.join("\n");
}
