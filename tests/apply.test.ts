import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUrlFor, atsFromUrl } from "../src/apply/ats.js";
import { extractApplyEmail, routeJob } from "../src/apply/route.js";
import { selectCandidates } from "../src/apply/select.js";
import { DEFAULTS } from "../src/apply/config.js";
import { FieldInfo, mapStandardField, pickOption } from "../src/apply/fields.js";
import { answerQuestions } from "../src/apply/writer.js";
import { loadLedger, loadLedgerWithPrepared, saveLedger, submittedOn } from "../src/apply/ledger.js";
import { Applicant, Ledger } from "../src/apply/types.js";
import { ClassifiedJob } from "../src/types.js";
import { LlmClient } from "../src/pipeline/llm.js";

const applicant: Applicant = {
  firstName: "Hassan", lastName: "T", email: "h@example.com", phone: "+961 1", location: "Beirut, Lebanon",
  city: "Beirut", country: "Lebanon", linkedin: "https://linkedin.com/in/h", github: "https://github.com/h",
  portfolio: "https://h.dev", cvPath: "private/cv.pdf", currentTitle: "Senior Frontend Engineer", currentCompany: "",
  yearsExperience: 6, noticePeriod: "2 weeks", engagement: "B2B", workAuthorisation: "none", timezone: "UTC+3",
  languages: "English", rate: "EUR 5k/month", pitch: "React", answers: [],
  consent: { privacyPolicy: true, futureOpportunities: false },
};

function job(over: Partial<ClassifiedJob> = {}): ClassifiedJob {
  return {
    source: "lever", company: "Acme", title: "Senior Frontend Engineer", location: "Remote",
    url: "https://jobs.lever.co/acme/123", postedAt: "2026-10-05", description: "",
    classification: { eligible: true, employmentType: "b2b", regionConstraint: "", confidence: 0.9, reason: "" },
    ...over,
  };
}

const field = (over: Partial<FieldInfo>): FieldInfo => ({ id: "jr0", kind: "text", label: "", name: "", required: false, options: [], ...over });

describe("ats", () => {
  it("detects vendors", () => {
    expect(atsFromUrl("https://job-boards.greenhouse.io/deel/jobs/1")).toBe("greenhouse");
    expect(atsFromUrl("https://careers.n26.com/jobs?gh_jid=55")).toBe("greenhouse");
    expect(atsFromUrl("https://jobs.eu.lever.co/x/abc")).toBe("lever");
    expect(atsFromUrl("https://jobs.ashbyhq.com/linear/u")).toBe("ashby");
    expect(atsFromUrl("https://apply.workable.com/tamara/j/ABC/")).toBe("workable");
    expect(atsFromUrl("https://mews.recruitee.com/o/frontend")).toBe("recruitee");
    expect(atsFromUrl("https://remoteok.com/x")).toBeNull();
  });

  it("builds form URLs", () => {
    expect(applyUrlFor("greenhouse", "https://careers.n26.com/jobs?gh_jid=55", "n26")).toBe(
      "https://job-boards.greenhouse.io/embed/job_app?for=n26&token=55"
    );
    expect(applyUrlFor("greenhouse", "https://boards.greenhouse.io/deel/jobs/9")).toBe(
      "https://job-boards.greenhouse.io/embed/job_app?for=deel&token=9"
    );
    expect(applyUrlFor("lever", "https://jobs.lever.co/a/1")).toBe("https://jobs.lever.co/a/1/apply");
    expect(applyUrlFor("lever", "https://jobs.lever.co/a/1/apply")).toBe("https://jobs.lever.co/a/1/apply");
    expect(applyUrlFor("ashby", "https://jobs.ashbyhq.com/l/u")).toBe("https://jobs.ashbyhq.com/l/u/application");
    expect(applyUrlFor("workable", "https://apply.workable.com/t/j/AB/")).toBe("https://apply.workable.com/t/j/AB/apply/");
    expect(applyUrlFor("recruitee", "https://m.recruitee.com/o/fe")).toBe("https://m.recruitee.com/o/fe/c/new");
  });
});

describe("routing", () => {
  it("sends LinkedIn to review", () => {
    expect(routeJob(job({ url: "https://www.linkedin.com/jobs/view/1" })).lane).toBe("review");
  });
  it("resolves aggregators", () => {
    expect(routeJob(job({ url: "https://remoteok.com/remote-jobs/1" })).lane).toBe("resolve");
  });
  it("uses an apply email from the description", () => {
    const r = routeJob(job({ url: "https://somestartup.io/careers", description: "Send your CV to jobs@somestartup.io" }));
    expect(r).toMatchObject({ lane: "email", email: "jobs@somestartup.io" });
  });
  it("ignores unrelated addresses", () => {
    expect(extractApplyEmail("Questions about privacy: privacy@x.com")).toBeNull();
    expect(extractApplyEmail("Our office is great. contact: hello@x.com for press")).toBeNull();
  });
});

describe("selection", () => {
  const now = new Date("2026-10-07T09:00:00Z");
  it("filters by confidence, type, cooldown and ledger", () => {
    const ledger: Ledger = {
      "https://jobs.lever.co/old/1": { url: "https://jobs.lever.co/old/1", company: "Old", title: "x", lane: "ats", status: "applied", at: "2026-10-01T00:00:00Z" },
    };
    const jobs = [
      job({ url: "https://jobs.lever.co/a/1", company: "A" }),
      job({ url: "https://jobs.lever.co/a/2", company: "A" }),
      job({ url: "https://jobs.lever.co/b/1", company: "B", classification: { ...job().classification, confidence: 0.5 } }),
      job({ url: "https://jobs.lever.co/c/1", company: "C", classification: { ...job().classification, employmentType: "payroll" } }),
      job({ url: "https://jobs.lever.co/old/2", company: "Old" }),
    ];
    const picked = selectCandidates(jobs, ledger, DEFAULTS, {}, now).map((j) => j.url);
    expect(picked).toEqual(["https://jobs.lever.co/a/1"]);
  });
  it("retries failures only after the wait", () => {
    const url = "https://jobs.lever.co/a/1";
    const failed = (at: string): Ledger => ({ [url]: { url, company: "A", title: "x", lane: "ats", status: "failed", at } });
    expect(selectCandidates([job({ url })], failed("2026-10-06T00:00:00Z"), DEFAULTS, {}, now)).toHaveLength(0);
    expect(selectCandidates([job({ url })], failed("2026-10-01T00:00:00Z"), DEFAULTS, {}, now)).toHaveLength(1);
  });
});

describe("standard fields", () => {
  it("maps common labels", () => {
    expect(mapStandardField(field({ label: "First Name *" }), applicant)).toEqual({ type: "value", value: "Hassan" });
    expect(mapStandardField(field({ label: "Email", kind: "email" }), applicant)).toEqual({ type: "value", value: "h@example.com" });
    expect(mapStandardField(field({ label: "LinkedIn Profile" }), applicant)).toMatchObject({ value: applicant.linkedin });
    expect(mapStandardField(field({ label: "Resume/CV", kind: "file" }), applicant)).toEqual({ type: "file", path: "private/cv.pdf" });
    expect(mapStandardField(field({ label: "Current company" }), { ...applicant, currentCompany: "Acme" })).toMatchObject({ value: "Acme" });
    // Blank in the profile means the model decides, rather than an empty answer.
    expect(mapStandardField(field({ label: "Current company" }), applicant)).toBeNull();
    expect(mapStandardField(field({ label: "Company name" }), applicant)).toBeNull();
  });
  it("declines EEO questions", () => {
    const f = field({ label: "Gender", kind: "select", options: ["Male", "Female", "Decline to self-identify"] });
    expect(mapStandardField(f, applicant)).toEqual({ type: "choice", values: ["Decline to self-identify"] });
  });
  it("leaves judgement calls to the model", () => {
    expect(mapStandardField(field({ label: "Why do you want to work here?", kind: "textarea" }), applicant)).toBeNull();
  });
  it("matches options loosely", () => {
    expect(pickOption(["Yes", "No"], "yes")).toBe("Yes");
    expect(pickOption(["Lebanon", "Libya"], "Lebanon")).toBe("Lebanon");
  });
});

describe("question answering", () => {
  const fake = (answers: unknown): LlmClient => ({
    provider: "fake", model: "fake",
    complete: async () => ({ text: JSON.stringify({ answers }), inputTokens: 1, outputTokens: 1 }),
  });
  it("rejects options that are not offered and escalates required nulls", async () => {
    const fields = [
      field({ id: "a", label: "Need sponsorship?", kind: "radio", required: true, options: ["Yes", "No"] }),
      field({ id: "b", label: "Date of birth", required: true }),
      field({ id: "c", label: "Favourite colour", kind: "select", options: ["Red"] }),
    ];
    const out = await answerQuestions(fake([
      { id: "a", answer: "no" }, { id: "b", answer: null }, { id: "c", answer: "Blue" },
    ]), job(), applicant, fields);
    expect(out.answers).toEqual({ a: ["No"] });
    expect(out.unanswered).toEqual(["Date of birth"]);
  });
});

describe("ledger", () => {
  it("keeps personal details out of the committed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "jr-"));
    const p = join(dir, "applications.json");
    const pp = join(dir, "private/prepared.json");
    const url = "https://jobs.lever.co/a/1";
    saveLedger({ [url]: { url, company: "A", title: "x", lane: "ats", status: "review", at: "2026-10-07T08:00:00Z", coverNote: "Hi", answers: { Rate: "5k" } } }, p, pp);
    expect(loadLedger(p)[url].coverNote).toBeUndefined();
    expect(loadLedgerWithPrepared(p, pp)[url]).toMatchObject({ coverNote: "Hi", answers: { Rate: "5k" } });
  });
  it("counts only real submissions against the cap", () => {
    const l: Ledger = {
      a: { url: "a", company: "A", title: "", lane: "ats", status: "applied", at: "2026-10-07T08:00:00Z" },
      b: { url: "b", company: "B", title: "", lane: "ats", status: "dry-run", at: "2026-10-07T08:00:00Z" },
      c: { url: "c", company: "C", title: "", lane: "ats", status: "applied", at: "2026-10-06T08:00:00Z" },
    };
    expect(submittedOn(l, new Date("2026-10-07T12:00:00Z"))).toBe(1);
  });
});
