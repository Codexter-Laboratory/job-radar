import { Job } from "../types.js";
import { applyUrlFor, atsFromUrl } from "./ats.js";
import { Route } from "./types.js";

const AGGREGATORS = /(^|\.)(remoteok\.com|remotive\.com|weworkremotely\.com|himalayas\.app|jobicy\.com|arbeitnow\.com)$/;
const NO_BOTS = /(^|\.)(linkedin\.com|indeed\.[a-z.]+|bayt\.com|gulftalent\.com|glassdoor\.[a-z.]+)$/;
const JUNK_EMAIL = /^(no-?reply|privacy|support|info|security|abuse|legal|press|dpo|gdpr)@/i;

/** An address the posting explicitly asks applicants to write to. */
export function extractApplyEmail(text: string): string | null {
  if (!text) return null;
  const re = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const email = m[1].replace(/\.$/, "");
    if (JUNK_EMAIL.test(email)) continue;
    const around = text.slice(Math.max(0, m.index - 160), m.index + email.length + 40).toLowerCase();
    if (/\b(apply|application|send|cv|resume|résumé|portfolio|reach out|email us|write to)\b/.test(around)) {
      return email;
    }
  }
  return null;
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function routeJob(
  job: Pick<Job, "url" | "company" | "source" | "description">,
  opts: { tryUnknownSites?: boolean } = {}
): Route {
  if (job.url.startsWith("mailto:")) {
    return { lane: "email", email: job.url.slice(7).split("?")[0] };
  }

  const ats = atsFromUrl(job.url);
  if (ats) {
    const hint = job.source === ats ? job.company : undefined;
    return { lane: "ats", ats, applyUrl: applyUrlFor(ats, job.url, hint) };
  }

  const h = host(job.url);
  if (NO_BOTS.test(h)) return { lane: "review", reason: `${h} does not allow automated applications` };

  const email = extractApplyEmail(job.description ?? "");
  if (email) return { lane: "email", email };

  if (AGGREGATORS.test(h)) return { lane: "resolve" };

  if (h && opts.tryUnknownSites) return { lane: "ats", ats: "generic", applyUrl: job.url };
  return { lane: "review", reason: `unsupported application site (${h || "no url"})` };
}
