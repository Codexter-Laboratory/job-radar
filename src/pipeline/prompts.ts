import { Job } from "../types.js";

export interface PromptVersion {
  id: string;
  notes: string;
  system: string;
  user: (job: Job, profile: CandidateProfile) => string;
}

/** Who the eligibility question is being asked on behalf of. */
export interface CandidateProfile {
  basedIn: string;
  invoicesFrom: string;
  timezone: string;
  workAuthorisation: string;
}

const OUTPUT_CONTRACT = `Reply with a single JSON object and nothing else. No prose, no markdown fence.

{
  "eligible": boolean,
  "employmentType": "b2b" | "eor" | "payroll" | "unknown",
  "regionConstraint": string,
  "confidence": number,
  "reason": string
}

Field meanings:
- eligible: true only if the posting can plausibly be filled by the candidate described, given where they live and how they invoice.
- employmentType: "b2b" if the employer contracts with a company or an independent contractor; "eor" if they hire abroad through an employer of record such as Deel or Remote.com; "payroll" if the role must sit on a local payroll entity; "unknown" if the posting does not say.
- regionConstraint: the eligibility requirement quoted from the posting, or "" if it states none. Do not paraphrase.
- confidence: 0 to 1, your own certainty about the eligible field.
- reason: one sentence, grounded in the posting text.`;

/**
 * Prompts are versioned rather than edited in place. The eval harness scores
 * each version against the same golden set, so a change that reads better but
 * scores worse is visible instead of assumed.
 */
export const PROMPTS: Record<string, PromptVersion> = {
  v1: {
    id: "v1",
    notes: "Title and location only. Baseline for what the keyword filter already had.",
    system:
      "You screen job postings for a contractor. Answer only with the JSON object requested.",
    user: (job, profile) => `Candidate: based in ${profile.basedIn}, invoices from ${profile.invoicesFrom}, works ${profile.timezone}, ${profile.workAuthorisation}.

Posting:
Company: ${job.company}
Title: ${job.title}
Location field: ${job.location || "(not stated)"}

Can this candidate take this role?

${OUTPUT_CONTRACT}`,
  },

  v2: {
    id: "v2",
    notes: "Adds the description body, where eligibility constraints actually live.",
    system:
      "You screen job postings for a contractor. You read the posting carefully and you do not guess when the posting is silent. Answer only with the JSON object requested.",
    user: (job, profile) => `Candidate: based in ${profile.basedIn}, invoices from ${profile.invoicesFrom}, works ${profile.timezone}, ${profile.workAuthorisation}.

Posting:
Company: ${job.company}
Title: ${job.title}
Location field: ${job.location || "(not stated)"}
Description:
${job.description || "(none published)"}

Can this candidate take this role?

${OUTPUT_CONTRACT}`,
  },

  v3: {
    id: "v3",
    notes:
      "v2 plus decision rules for the cases that were misread: silent postings, timezone-only limits, and EOR coverage.",
    system: `You screen job postings for a contractor. You read the posting carefully and you do not guess when the posting is silent. Answer only with the JSON object requested.

Decision rules:
- "Remote" with no country named does not mean worldwide. If the posting names no restriction at all, set eligible true, employmentType "unknown", and confidence at or below 0.6.
- A timezone requirement is not a location requirement. A candidate who can work the stated hours is eligible even if they live outside the region.
- A requirement to hold work authorisation in a specific country makes the candidate ineligible, even when the role is remote.
- Hiring through an employer of record is usually open to candidates abroad. Treat it as eligible unless the posting limits the countries it covers.
- A posting that asks for a local tax entity, a local bank account, or on-site days makes the candidate ineligible.`,
    user: (job, profile) => `Candidate: based in ${profile.basedIn}, invoices from ${profile.invoicesFrom}, works ${profile.timezone}, ${profile.workAuthorisation}.

Posting:
Company: ${job.company}
Title: ${job.title}
Location field: ${job.location || "(not stated)"}
Description:
${job.description || "(none published)"}

Can this candidate take this role?

${OUTPUT_CONTRACT}`,
  },
};

export const DEFAULT_PROMPT = "v3";
