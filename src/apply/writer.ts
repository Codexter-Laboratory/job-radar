import { ClassifiedJob } from "../types.js";
import { LlmClient } from "../pipeline/llm.js";
import { extractJson } from "../pipeline/classify.js";
import { truncate } from "../http.js";
import { Applicant } from "./types.js";
import { FieldInfo, pickOption } from "./fields.js";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export const usage: Usage = { inputTokens: 0, outputTokens: 0 };

async function ask(client: LlmClient, system: string, user: string, maxTokens: number): Promise<any> {
  let last: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await client.complete(system, user, { maxTokens });
      usage.inputTokens += res.inputTokens;
      usage.outputTokens += res.outputTokens;
      return extractJson(res.text);
    } catch (e) {
      last = e as Error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw last ?? new Error("model call failed");
}

function facts(a: Applicant): string {
  return [
    `Name: ${a.firstName} ${a.lastName}`,
    `Location: ${a.location} (${a.timezone})`,
    `Current: ${a.currentTitle}${a.currentCompany ? ` at ${a.currentCompany}` : ""}, ${a.yearsExperience} years of experience`,
    `How they engage: ${a.engagement}`,
    `Work authorisation: ${a.workAuthorisation}`,
    `Notice period / start: ${a.noticePeriod}`,
    `Rate expectation: ${a.rate}`,
    `Languages: ${a.languages}`,
    `Links: LinkedIn ${a.linkedin}; GitHub ${a.github}; Portfolio ${a.portfolio}`,
    `Background: ${a.pitch}`,
    ...a.answers.map((x) => `Q: ${x.q}\nA: ${x.a}`),
  ].join("\n");
}

function jobBlock(job: ClassifiedJob): string {
  return `Company: ${job.company}\nRole: ${job.title}\nLocation: ${job.location}\n\n${truncate(job.description ?? "", 6000)}`;
}

const STYLE = `Write like a working engineer, plain and specific. No buzzwords (leverage, passionate, seamless, robust, spearheaded, results-driven, thrilled, excited to), no em dashes, no "I hope", no flattery. Refer to concrete things from the posting.`;

export async function writeCoverNote(
  client: LlmClient,
  job: ClassifiedJob,
  a: Applicant
): Promise<{ coverNote: string; emailSubject: string }> {
  const system = `You write short job application notes for a contractor. Use only the facts given about the candidate; never invent employers, projects, numbers or skills. ${STYLE}
Reply with a JSON object only: {"coverNote": string, "emailSubject": string}.
coverNote: 90 to 150 words, first person, starts with "Hi" and the team or company name, mentions B2B engagement in one clause, ends with the candidate's first name.
emailSubject: under 70 characters, names the role.`;
  const out = await ask(client, system, `CANDIDATE\n${facts(a)}\n\nJOB\n${jobBlock(job)}`, 700);
  const coverNote = String(out?.coverNote ?? "").trim();
  if (coverNote.length < 60) throw new Error("cover note came back empty");
  return { coverNote, emailSubject: String(out?.emailSubject ?? `Application: ${job.title}`).trim() };
}

export interface AnswerSet {
  /** field id to the value(s) to enter. */
  answers: Record<string, string[]>;
  /** Labels the model could not ground in the candidate's facts. */
  unanswered: string[];
}

/**
 * One call for every non-standard question on the form. The model must return
 * null when the facts do not cover a question, and choice answers must match
 * an offered option, so nothing made up reaches the employer.
 */
export async function answerQuestions(
  client: LlmClient,
  job: ClassifiedJob,
  a: Applicant,
  fields: FieldInfo[]
): Promise<AnswerSet> {
  if (!fields.length) return { answers: {}, unanswered: [] };

  const qs = fields.map((f) => ({
    id: f.id,
    question: f.label || f.name,
    type: f.kind,
    required: f.required,
    ...(f.options.length ? { options: f.options } : {}),
    ...(f.maxLength ? { maxLength: f.maxLength } : {}),
  }));

  const system = `You fill in screening questions on a job application for the candidate described. ${STYLE}
Rules:
- Answer only from the candidate facts. If they do not cover a question, answer null. Never guess dates, numbers, legal status or personal details.
- Questions about motivation or fit ("why this company", "tell us about a project") may be answered in 2 to 4 sentences built from the facts and the job description.
- For questions with options, answer with the exact option text. For multi-select (checkbox-group) answer an array of exact option texts.
- Sponsorship or visa questions: the candidate works as a B2B contractor through their own company and does not need sponsorship for contract work; if the question is about employment on local payroll and the facts do not settle it, answer null.
- Salary or rate questions: use the rate from the facts.
- Respect maxLength.
Reply with a JSON object only: {"answers": [{"id": string, "answer": string | string[] | null}]}`;

  const out = await ask(
    client,
    system,
    `CANDIDATE\n${facts(a)}\n\nJOB\n${jobBlock(job)}\n\nQUESTIONS\n${JSON.stringify(qs, null, 1)}`,
    1800
  );

  const byId = new Map<string, unknown>();
  for (const item of Array.isArray(out?.answers) ? out.answers : []) byId.set(String(item?.id), item?.answer);

  const result: AnswerSet = { answers: {}, unanswered: [] };
  for (const f of fields) {
    const raw = byId.get(f.id);
    const values = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map((v) => String(v).trim()).filter(Boolean);

    let accepted: string[] = values;
    if (f.options.length) {
      accepted = values.map((v) => pickOption(f.options, v)).filter((v): v is string => !!v);
    }
    if (f.maxLength) accepted = accepted.map((v) => v.slice(0, f.maxLength));

    if (accepted.length) result.answers[f.id] = accepted;
    else if (f.required) result.unanswered.push(f.label || f.name);
  }
  return result;
}
