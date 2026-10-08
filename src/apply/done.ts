import { loadLedgerWithPrepared, saveLedger } from "./ledger.js";

/** Mark review items you handled yourself: npm run done -- <url> [<url> ...] */
const urls = process.argv.slice(2);
if (!urls.length) {
  console.error("usage: npm run done -- <posting or apply url> ...");
  process.exit(1);
}
const ledger = loadLedgerWithPrepared();
for (const u of urls) {
  const rec = ledger[u] ?? Object.values(ledger).find((r) => r.applyUrl === u);
  if (!rec) {
    console.error(`not in ledger: ${u}`);
    continue;
  }
  rec.status = "applied";
  rec.reason = "applied manually";
  rec.at = new Date().toISOString();
  console.log(`marked applied: ${rec.company} | ${rec.title}`);
}
saveLedger(ledger);
