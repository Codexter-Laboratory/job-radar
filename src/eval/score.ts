import { Classification, ConfusionMatrix, EvalMetrics, GoldenRecord } from "../types.js";

export interface Prediction {
  id: string;
  classification: Classification;
}

export interface Disagreement {
  id: string;
  title: string;
  company: string;
  url: string;
  expected: boolean;
  predicted: boolean;
  confidence: number;
  reason: string;
  note?: string;
}

export interface EvalResult {
  promptVersion: string;
  provider: string;
  model: string;
  metrics: EvalMetrics;
  /** Every case the classifier got wrong, for reading rather than counting. */
  disagreements: Disagreement[];
  cost: {
    calls: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    costPerThousandPostingsUsd: number;
  };
}

export function confusion(
  golden: GoldenRecord[],
  predictions: Map<string, Classification>
): ConfusionMatrix {
  const m: ConfusionMatrix = {
    truePositives: 0,
    falsePositives: 0,
    trueNegatives: 0,
    falseNegatives: 0,
  };

  for (const record of golden) {
    const predicted = predictions.get(record.id);
    // A missing prediction counts as "not eligible", which is what the pipeline
    // would actually do with it. Silently skipping would flatter the score.
    const p = predicted?.eligible ?? false;
    const expected = record.label.eligible;

    if (expected && p) m.truePositives++;
    else if (!expected && p) m.falsePositives++;
    else if (!expected && !p) m.trueNegatives++;
    else m.falseNegatives++;
  }

  return m;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function metricsFrom(
  golden: GoldenRecord[],
  predictions: Map<string, Classification>
): EvalMetrics {
  const m = confusion(golden, predictions);
  const precision = ratio(m.truePositives, m.truePositives + m.falsePositives);
  const recall = ratio(m.truePositives, m.truePositives + m.falseNegatives);

  let employmentMatches = 0;
  for (const record of golden) {
    const p = predictions.get(record.id);
    if (p && p.employmentType === record.label.employmentType) employmentMatches++;
  }

  return {
    ...m,
    total: golden.length,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    accuracy: ratio(m.truePositives + m.trueNegatives, golden.length),
    employmentTypeAccuracy: ratio(employmentMatches, golden.length),
  };
}

export function disagreements(
  golden: GoldenRecord[],
  predictions: Map<string, Classification>
): Disagreement[] {
  const out: Disagreement[] = [];

  for (const record of golden) {
    const p = predictions.get(record.id);
    const predicted = p?.eligible ?? false;
    if (predicted === record.label.eligible) continue;

    out.push({
      id: record.id,
      title: record.job.title,
      company: record.job.company,
      url: record.job.url,
      expected: record.label.eligible,
      predicted,
      confidence: p?.confidence ?? 0,
      reason: p?.reason ?? "no prediction",
      note: record.label.note,
    });
  }

  return out;
}

export function formatMetrics(r: EvalResult): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const m = r.metrics;

  return [
    `prompt ${r.promptVersion} on ${r.provider}/${r.model}`,
    `  n=${m.total}  precision=${pct(m.precision)}  recall=${pct(m.recall)}  F1=${pct(m.f1)}`,
    `  accuracy=${pct(m.accuracy)}  employment-type accuracy=${pct(m.employmentTypeAccuracy)}`,
    `  TP=${m.truePositives} FP=${m.falsePositives} TN=${m.trueNegatives} FN=${m.falseNegatives}`,
    `  ${r.cost.failures} call failures, $${r.cost.estimatedCostUsd.toFixed(4)} spent, ` +
      `$${r.cost.costPerThousandPostingsUsd.toFixed(2)} per 1000 postings`,
  ].join("\n");
}

/** A markdown row so results can be pasted straight into the README. */
export function markdownRow(r: EvalResult): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const m = r.metrics;
  return `| ${r.promptVersion} | ${r.model} | ${m.total} | ${pct(m.precision)} | ${pct(
    m.recall
  )} | ${pct(m.f1)} | $${r.cost.costPerThousandPostingsUsd.toFixed(2)} |`;
}

export const MARKDOWN_HEADER = [
  "| Prompt | Model | n | Precision | Recall | F1 | Cost / 1k |",
  "| --- | --- | --- | --- | --- | --- | --- |",
].join("\n");
