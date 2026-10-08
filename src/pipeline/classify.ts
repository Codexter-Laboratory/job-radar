import { Classification, ClassifiedJob, EmploymentType, Job } from "../types.js";
import { LlmClient } from "./llm.js";
import { CandidateProfile, DEFAULT_PROMPT, PROMPTS } from "./prompts.js";

const EMPLOYMENT_TYPES: EmploymentType[] = ["b2b", "eor", "payroll", "unknown"];

/** What a posting gets when the model fails on it. Never silently "not eligible". */
export const UNCLASSIFIED: Classification = {
  eligible: false,
  employmentType: "unknown",
  regionConstraint: "",
  confidence: 0,
  reason: "classification failed",
};

/**
 * Models occasionally wrap JSON in a fence or add a sentence before it despite
 * instructions, so the object is extracted rather than assumed to be the whole
 * response.
 */
export function extractJson(text: string): unknown {
  const trimmed = (text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("no JSON object in response");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

/**
 * A model that returns the wrong shape is a bug, not a data point. Coerce what
 * is safely coercible and reject the rest so it shows up as a failure.
 */
export function parseClassification(text: string): Classification {
  const raw = extractJson(text) as Record<string, unknown>;

  if (typeof raw?.eligible !== "boolean") {
    throw new Error("missing or non-boolean 'eligible'");
  }

  const employmentType = String(raw.employmentType ?? "unknown").toLowerCase();
  const confidence = Number(raw.confidence);

  return {
    eligible: raw.eligible,
    employmentType: EMPLOYMENT_TYPES.includes(employmentType as EmploymentType)
      ? (employmentType as EmploymentType)
      : "unknown",
    regionConstraint: String(raw.regionConstraint ?? ""),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    reason: String(raw.reason ?? ""),
  };
}

export interface ClassifyOptions {
  client: LlmClient;
  profile: CandidateProfile;
  promptVersion?: string;
  /** Parallel requests. Kept low by default to stay inside free-tier limits. */
  concurrency?: number;
  maxRetries?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ClassifyStats {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ClassifyOutcome {
  jobs: ClassifiedJob[];
  stats: ClassifyStats;
}

export async function classifyOne(
  job: Job,
  opts: ClassifyOptions
): Promise<{ classification: Classification; inputTokens: number; outputTokens: number }> {
  const prompt = PROMPTS[opts.promptVersion ?? DEFAULT_PROMPT];
  if (!prompt) throw new Error(`unknown prompt version: ${opts.promptVersion}`);

  const maxRetries = opts.maxRetries ?? 2;
  let lastError: Error | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await opts.client.complete(
        prompt.system,
        prompt.user(job, opts.profile)
      );
      inputTokens += res.inputTokens;
      outputTokens += res.outputTokens;
      return {
        classification: parseClassification(res.text),
        inputTokens,
        outputTokens,
      };
    } catch (e) {
      lastError = e as Error;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
  }

  throw Object.assign(lastError ?? new Error("classification failed"), {
    inputTokens,
    outputTokens,
  });
}

export async function classify(
  jobs: Job[],
  opts: ClassifyOptions
): Promise<ClassifyOutcome> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: ClassifiedJob[] = new Array(jobs.length);
  const stats: ClassifyStats = {
    calls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  let cursor = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= jobs.length) return;

      stats.calls++;
      try {
        const out = await classifyOne(jobs[i], opts);
        stats.inputTokens += out.inputTokens;
        stats.outputTokens += out.outputTokens;
        results[i] = { ...jobs[i], classification: out.classification };
      } catch (e) {
        stats.failures++;
        stats.inputTokens += (e as any).inputTokens ?? 0;
        stats.outputTokens += (e as any).outputTokens ?? 0;
        results[i] = {
          ...jobs[i],
          classification: { ...UNCLASSIFIED, reason: `classification failed: ${(e as Error).message}` },
        };
      }
      opts.onProgress?.(++done, jobs.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, worker)
  );

  return { jobs: results, stats };
}
