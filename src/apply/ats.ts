import { Ats } from "./types.js";

const HOSTS: [RegExp, Ats][] = [
  [/(^|\.)greenhouse\.io$/, "greenhouse"],
  [/(^|\.)lever\.co$/, "lever"],
  [/(^|\.)ashbyhq\.com$/, "ashby"],
  [/(^|\.)workable\.com$/, "workable"],
  [/(^|\.)recruitee\.com$/, "recruitee"],
  [/(^|\.)smartrecruiters\.com$/, "smartrecruiters"],
  [/(^|\.)jobs\.personio\.(de|com)$/, "personio"],
];

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function atsFromUrl(url: string): Ats | null {
  const u = parse(url);
  if (!u) return null;
  if (u.searchParams.has("gh_jid")) return "greenhouse";
  for (const [re, ats] of HOSTS) if (re.test(u.hostname)) return ats;
  return null;
}

/**
 * The URL of the page that holds the form. Each ATS puts the form somewhere
 * slightly different relative to the posting.
 */
export function applyUrlFor(ats: Ats, url: string, boardHint?: string): string {
  const u = parse(url);
  if (!u) return url;
  const path = u.pathname.replace(/\/+$/, "");

  switch (ats) {
    case "greenhouse": {
      // Company careers pages embed Greenhouse with ?gh_jid=; the embed form
      // works standalone and is far more predictable than the host page.
      const jid = u.searchParams.get("gh_jid") ?? path.match(/\/jobs\/(\d+)/)?.[1];
      const board =
        (/greenhouse\.io$/.test(u.hostname) ? path.split("/").filter(Boolean)[0] : undefined) ??
        u.searchParams.get("for") ??
        boardHint;
      if (jid && board && board !== "embed") {
        return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${jid}`;
      }
      return url;
    }
    case "lever":
      return /\/apply$/.test(path) ? `${u.origin}${path}` : `${u.origin}${path}/apply`;
    case "ashby":
      return /\/application$/.test(path) ? `${u.origin}${path}` : `${u.origin}${path}/application`;
    case "workable":
      return /\/apply$/.test(path) ? `${u.origin}${path}/` : `${u.origin}${path}/apply/`;
    case "recruitee":
      return /\/c\/new$/.test(path) ? `${u.origin}${path}` : `${u.origin}${path}/c/new`;
    // The form sits behind an Apply button on the posting; the filler clicks it.
    case "smartrecruiters":
    case "personio":
    case "generic":
      return url;
  }
}
