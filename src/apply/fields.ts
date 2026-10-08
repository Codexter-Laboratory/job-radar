import { Applicant } from "./types.js";
import { fullName } from "./applicant.js";

export type FieldKind =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "date"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "checkbox-group"
  | "combobox"
  | "file";

/** A form control as seen from the page. `id` is the data-jr-id the page script assigned. */
export interface FieldInfo {
  id: string;
  kind: FieldKind;
  label: string;
  name: string;
  required: boolean;
  options: string[];
  maxLength?: number;
}

export type Fill =
  | { type: "value"; value: string }
  | { type: "choice"; values: string[] }
  | { type: "check"; checked: boolean }
  | { type: "file"; path: string }
  | { type: "cover-file" }
  | { type: "cover-text" }
  | { type: "skip" };

const DECLINE = /decline|prefer not|don.?t wish|do not wish|not to (say|disclose|answer|identify)|rather not|i don.?t want/i;
const EEO = /gender|race|ethnic|hispanic|latino|veteran|disabilit|sexual orientation|pronoun|transgender|eeo/i;

export function pickOption(options: string[], wanted: string | RegExp): string | null {
  if (wanted instanceof RegExp) return options.find((o) => wanted.test(o)) ?? null;
  const w = wanted.trim().toLowerCase();
  if (!w) return null;
  return (
    options.find((o) => o.trim().toLowerCase() === w) ??
    options.find((o) => o.toLowerCase().startsWith(w)) ??
    options.find((o) => o.toLowerCase().includes(w)) ??
    options.find((o) => w.includes(o.trim().toLowerCase()) && o.trim().length > 2) ??
    null
  );
}

function text(value: string | number | undefined): Fill | null {
  const v = value === undefined ? "" : String(value).trim();
  return v ? { type: "value", value: v } : null;
}

/**
 * Fields every ATS asks in roughly the same words. Returns null for anything
 * that needs judgement; those go to the model with the answer bank.
 */
export function mapStandardField(f: FieldInfo, a: Applicant): Fill | null {
  const l = `${f.label} ${f.name}`.toLowerCase().replace(/[_\-]+/g, " ");

  if (f.kind === "file") {
    if (/cover/.test(l)) return f.required ? { type: "cover-file" } : { type: "skip" };
    if (/resume|cv\b|curriculum|attach/.test(l) || f.required) return { type: "file", path: a.cvPath };
    return { type: "skip" };
  }

  if (f.kind === "checkbox") {
    if (/privacy|consent|agree|terms|gdpr|process(ing)? (of )?my|data protection|acknowledge/.test(l)) {
      if (/future|talent (pool|community)|other (roles|positions|opportunities)|keep my/.test(l)) {
        return { type: "check", checked: a.consent.futureOpportunities };
      }
      return { type: "check", checked: a.consent.privacyPolicy };
    }
    if (/future|talent (pool|community)|newsletter|marketing/.test(l)) {
      return { type: "check", checked: a.consent.futureOpportunities };
    }
    return null;
  }

  if (EEO.test(l) && f.options.length) {
    const d = pickOption(f.options, DECLINE);
    return d ? { type: "choice", values: [d] } : f.required ? null : { type: "skip" };
  }

  if (/cover letter|coverletter/.test(l) && (f.kind === "textarea" || f.kind === "text")) return { type: "cover-text" };

  if (/first name|given name|prénom|firstname/.test(l)) return text(a.firstName);
  if (/last name|surname|family name|lastname/.test(l)) return text(a.lastName);
  if (/preferred name/.test(l)) return text(a.firstName);
  if (/(^|\s)(full )?name\b/.test(l) && !/company|employer|school|university|reference|referr|manager/.test(l)) {
    return text(fullName(a));
  }
  if (f.kind === "email" || /e ?mail/.test(l)) return text(a.email);
  if (f.kind === "tel" || /phone|mobile|telephone|whatsapp/.test(l)) return text(a.phone);
  if (/linkedin/.test(l)) return text(a.linkedin);
  if (/github/.test(l)) return text(a.github);
  if (/portfolio|personal (site|website)|^website|website\b|other (link|website)/.test(l)) return text(a.portfolio);
  if (/current (company|employer)|company name|most recent (company|employer)/.test(l)) return text(a.currentCompany);
  if (/current (job )?(title|role|position)|most recent (title|role)/.test(l)) return text(a.currentTitle);
  if (/years of (professional |relevant )?experience|how many years/.test(l) && (f.kind === "number" || f.kind === "text")) {
    return text(a.yearsExperience);
  }
  if (/country/.test(l) && !/countries/.test(l)) {
    if (f.options.length) {
      const o = pickOption(f.options, a.country);
      return o ? { type: "choice", values: [o] } : null;
    }
    return text(a.country);
  }
  if (/^(current )?location|where are you (based|located)|city of residence|your city|\bcity\b/.test(l.trim())) {
    if (f.kind === "combobox") return text(a.city);
    return text(f.kind === "text" ? a.location : a.city);
  }
  if (f.kind === "url") return text(a.portfolio);
  return null;
}
