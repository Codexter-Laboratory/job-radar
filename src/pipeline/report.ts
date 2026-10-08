import { RunReport, SourceReport } from "../types.js";

/**
 * Wraps a source so a failure is recorded and named rather than swallowed. The
 * old version caught everything silently, which meant a broken adapter and a
 * quiet job market looked identical from the outside.
 */
export async function runSource<T>(
  source: string,
  fn: () => Promise<T>,
  count: (result: T) => number
): Promise<{ report: SourceReport; result: T | null }> {
  const startedAt = Date.now();

  try {
    const result = await fn();
    const fetched = count(result);
    return {
      report: { source, ok: true, fetched, durationMs: Date.now() - startedAt },
      result,
    };
  } catch (e) {
    return {
      report: {
        source,
        ok: false,
        fetched: 0,
        durationMs: Date.now() - startedAt,
        error: (e as Error).message,
      },
      result: null,
    };
  }
}

export function summarise(report: RunReport): string {
  const lines: string[] = [];
  const failed = report.sources.filter((s) => !s.ok);

  lines.push("Sources:");
  for (const s of report.sources) {
    const status = s.ok ? `${s.fetched}` : `FAILED (${s.error})`;
    lines.push(`  ${s.source.padEnd(16)} ${status}  ${s.durationMs}ms`);
  }

  lines.push(
    "",
    `Fetched ${report.totals.fetched}, ` +
      `${report.totals.afterPrefilter} past the prefilter, ` +
      `${report.totals.afterDedupe} after dedupe, ` +
      `${report.totals.eligible} eligible, ` +
      `${report.totals.newSinceLastRun} new since the last run.`
  );

  if (report.classifier) {
    lines.push(
      `Classifier: ${report.classifier.calls} calls to ` +
        `${report.classifier.provider}/${report.classifier.model}, ` +
        `$${report.classifier.estimatedCostUsd.toFixed(4)}.`
    );
  }

  if (failed.length) {
    lines.push("", `${failed.length} source(s) failed: ${failed.map((s) => s.source).join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * CI should go red when the pipeline is broken, but not when the job market is
 * quiet. More than half the sources down means broken.
 */
export function isRunHealthy(report: RunReport): boolean {
  if (report.sources.length === 0) return false;
  const ok = report.sources.filter((s) => s.ok).length;
  return ok / report.sources.length > 0.5;
}
