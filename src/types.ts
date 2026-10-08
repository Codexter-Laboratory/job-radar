/** A posting after normalisation, regardless of which source it came from. */
export interface Job {
  source: string;
  company: string;
  title: string;
  location: string;
  url: string;
  /** ISO 8601, or empty when the source does not publish a date. */
  postedAt: string;
  salary?: string;
  tags?: string[];
  /** Plain-text job description. Empty when the source only exposes a title. */
  description?: string;
}

/** How a posting relates to a contractor invoicing from another country. */
export type EmploymentType = "b2b" | "eor" | "payroll" | "unknown";

/** Stage two output for a single posting. */
export interface Classification {
  eligible: boolean;
  employmentType: EmploymentType;
  /** Verbatim constraint from the posting, e.g. "EU work authorisation required". */
  regionConstraint: string;
  /** Model's own confidence, 0 to 1. Used for the review queue, not for scoring. */
  confidence: number;
  /** One sentence, grounded in the posting text. */
  reason: string;
}

export interface ClassifiedJob extends Job {
  classification: Classification;
}

/** Per-source outcome for one run. Replaces silently swallowed errors. */
export interface SourceReport {
  source: string;
  ok: boolean;
  fetched: number;
  durationMs: number;
  error?: string;
}

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  sources: SourceReport[];
  totals: {
    fetched: number;
    afterPrefilter: number;
    afterDedupe: number;
    classified: number;
    eligible: number;
    newSinceLastRun: number;
  };
  classifier?: {
    provider: string;
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

/** One hand-labelled posting in the golden set. */
export interface GoldenRecord {
  id: string;
  job: Job;
  label: {
    eligible: boolean;
    employmentType: EmploymentType;
    /** Free-text note from whoever labelled it. Not scored. */
    note?: string;
  };
  labelledAt: string;
  labelledBy: string;
}

export interface ConfusionMatrix {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
}

export interface EvalMetrics extends ConfusionMatrix {
  total: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  /** Share of records where the predicted employment type matched the label. */
  employmentTypeAccuracy: number;
}
