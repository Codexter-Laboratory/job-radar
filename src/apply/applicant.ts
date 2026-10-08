import { existsSync, readFileSync } from "node:fs";
import { Applicant } from "./types.js";

export const APPLICANT_PATH = process.env.APPLICANT_PATH ?? "applicant.json";

const REQUIRED: (keyof Applicant)[] = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "location",
  "country",
  "cvPath",
  "engagement",
  "workAuthorisation",
  "pitch",
];

export function loadApplicant(path: string = APPLICANT_PATH): Applicant {
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Copy applicant.example.json to ${path} and fill it in.`);
  }
  const a = JSON.parse(readFileSync(path, "utf8")) as Applicant;
  const missing = REQUIRED.filter((k) => !a[k] || String(a[k]).includes("TODO"));
  if (missing.length) throw new Error(`${path} is missing: ${missing.join(", ")}`);
  if (!existsSync(a.cvPath)) throw new Error(`CV not found at ${a.cvPath}`);
  a.answers ??= [];
  a.consent ??= { privacyPolicy: true, futureOpportunities: false };
  a.city ||= a.location.split(",")[0].trim();
  return a;
}

export function fullName(a: Applicant): string {
  return `${a.firstName} ${a.lastName}`.trim();
}
