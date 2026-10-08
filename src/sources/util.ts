import { stripHtml, truncate } from "../http.js";

/** Longest description we keep. Beyond this the eligibility text is already in. */
export const MAX_DESCRIPTION_CHARS = 6000;

/**
 * Third-party payloads disagree on field names and change without notice, so
 * probe a list of candidates rather than trusting one shape.
 */
export function pickString(obj: unknown, keys: string[]): string {
  if (!obj || typeof obj !== "object") return "";
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/** Pull a description out of whichever field this source happens to use. */
export function pickDescription(obj: unknown, keys: string[]): string {
  const raw = pickString(obj, keys);
  if (!raw) return "";
  return truncate(stripHtml(raw), MAX_DESCRIPTION_CHARS);
}

/** Sources variously emit ISO strings, epoch seconds, epoch millis, or nothing. */
export function toIsoDate(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim() !== "" && !value.includes("-")) {
      return toIsoDate(asNumber);
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  return "";
}

export function joinParts(parts: (string | undefined | false)[], sep = " / "): string {
  return parts.filter((p): p is string => Boolean(p && String(p).trim())).join(sep);
}
