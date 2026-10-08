export type Ats = "greenhouse" | "lever" | "ashby" | "workable" | "recruitee" | "smartrecruiters" | "personio" | "generic";

/**
 * ats      fill the hosted application form
 * email    the posting asks for a CV by email
 * resolve  aggregator page; open it to find where the real application lives
 * review   a person has to submit (LinkedIn, CAPTCHA, unknown site, unanswerable question)
 */
export type Lane = "ats" | "email" | "resolve" | "review";

export type ApplicationStatus = "applied" | "dry-run" | "review" | "failed";

export interface Route {
  lane: Lane;
  ats?: Ats;
  applyUrl?: string;
  email?: string;
  reason?: string;
}

export interface ApplicationRecord {
  url: string;
  company: string;
  title: string;
  lane: Lane;
  ats?: Ats;
  status: ApplicationStatus;
  /** ISO timestamp of the attempt. */
  at: string;
  reason?: string;
  applyUrl?: string;
  email?: string;
  screenshot?: string;
  /** Cover note prepared for this job, kept so a review item is ready to paste. */
  coverNote?: string;
  /** Answers prepared for form questions, label to answer. */
  answers?: Record<string, string>;
}

/** Keyed by posting URL. */
export type Ledger = Record<string, ApplicationRecord>;

export interface ApplyConfig {
  enabled: boolean;
  /** Fill and screenshot everything, submit nothing. */
  dryRun: boolean;
  /** Maximum submissions (form + email) per calendar day. */
  dailyCap: number;
  minConfidence: number;
  employmentTypes: string[];
  /** Do not apply to the same company twice inside this window. */
  companyCooldownDays: number;
  /** Ignore postings first seen longer ago than this. */
  maxAgeDays: number;
  /** Retry a failed attempt after this many days. Review items are never retried automatically. */
  retryFailedAfterDays: number;
  /** How many review items get a prepared cover note per run. */
  reviewPrepLimit: number;
  excludeCompanies: string[];
  /** Try the form on company sites and boards with no known ATS. */
  tryUnknownSites: boolean;
  headless: boolean;
  /** Pause between applications, seconds. */
  pauseSeconds: [number, number];
}

export interface Applicant {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  city: string;
  country: string;
  linkedin: string;
  github: string;
  portfolio: string;
  cvPath: string;
  currentTitle: string;
  currentCompany: string;
  yearsExperience: number;
  noticePeriod: string;
  engagement: string;
  workAuthorisation: string;
  timezone: string;
  languages: string;
  rate: string;
  pitch: string;
  /** Facts the model may draw on for screening questions. Anything not here is escalated. */
  answers: { q: string; a: string }[];
  consent: { privacyPolicy: boolean; futureOpportunities: boolean };
}
