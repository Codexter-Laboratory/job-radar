import { mkdirSync, writeFileSync } from "node:fs";
import type { Locator, Page } from "playwright";
import { ClassifiedJob } from "../types.js";
import { LlmClient } from "../pipeline/llm.js";
import { Applicant, Ats } from "./types.js";
import { FieldInfo, Fill, mapStandardField } from "./fields.js";
import { answerQuestions } from "./writer.js";
import { COLLECT_FIELDS, EMPTY_REQUIRED, PAGE_TEXT, VISIBLE_CHALLENGE } from "./page-scripts.js";

export const SHOTS = "output/screenshots";

export interface FormOutcome {
  status: "applied" | "dry-run" | "review" | "failed";
  reason?: string;
  screenshot?: string;
  answers?: Record<string, string>;
}

const SUCCESS = /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(received|submitted|sent)|we('ve| have) received your application|successfully (applied|submitted)|you('ve| have) applied/i;
const APPLY_BUTTON = /^\s*(apply( for this (job|position|role))?( now)?|i'?m interested|apply online|aplikuj)\s*$/i;
const SUCCESS_URL = /thank|confirm|success|submitted/i;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

async function shot(page: Page, name: string): Promise<string> {
  mkdirSync(SHOTS, { recursive: true });
  const path = `${SHOTS}/${name}.png`;
  await page.screenshot({ path, fullPage: true }).catch(() => undefined);
  return path;
}

async function clickIfVisible(loc: Locator, timeout = 1500): Promise<boolean> {
  const first = loc.first();
  if (await first.isVisible({ timeout }).catch(() => false)) {
    await first.click({ timeout: 5000 }).catch(() => undefined);
    return true;
  }
  return false;
}

export async function dismissBanners(page: Page): Promise<void> {
  await clickIfVisible(
    page.getByRole("button", { name: /^(accept( all)?( cookies)?|allow all|agree|i agree|got it|ok)$/i }),
    1200
  );
}

async function hasChallenge(page: Page): Promise<boolean> {
  return Boolean(await page.evaluate(VISIBLE_CHALLENGE).catch(() => false));
}

async function collect(page: Page): Promise<FieldInfo[]> {
  return ((await page.evaluate(COLLECT_FIELDS)) as FieldInfo[]) ?? [];
}

function looksLikeForm(fields: FieldInfo[]): boolean {
  return fields.some((f) => f.kind === "file") || fields.filter((f) => f.kind !== "checkbox").length >= 3;
}

/** Custom dropdowns only reveal their options once opened. */
async function readComboboxOptions(page: Page, f: FieldInfo): Promise<string[]> {
  const el = page.locator(`[data-jr-id="${f.id}"]`);
  try {
    await el.click({ timeout: 3000 });
    await page.waitForTimeout(400);
    const opts = await page.locator('[role="option"]:visible').allInnerTexts();
    await page.keyboard.press("Escape");
    return opts.map((o) => o.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 60);
  } catch {
    return [];
  }
}

async function fillCombobox(page: Page, id: string, value: string): Promise<void> {
  const el = page.locator(`[data-jr-id="${id}"]`);
  await el.click({ timeout: 5000 });
  await el.fill("").catch(() => undefined);
  await el.pressSequentially(value, { delay: 40 });
  await page.waitForTimeout(900);
  const option = page.locator('[role="option"]:visible').filter({ hasText: value }).first();
  if (await option.isVisible({ timeout: 1500 }).catch(() => false)) await option.click();
  else {
    const any = page.locator('[role="option"]:visible').first();
    if (await any.isVisible({ timeout: 800 }).catch(() => false)) await any.click();
    else await page.keyboard.press("Enter");
  }
}

async function apply(page: Page, f: FieldInfo, fill: Fill, cover: { text: string; file: string }): Promise<string | null> {
  const el = page.locator(`[data-jr-id="${f.id}"]`);
  switch (fill.type) {
    case "skip":
      return null;
    case "file":
      await el.first().setInputFiles(fill.path);
      return fill.path.split("/").pop() ?? "file";
    case "cover-file":
      await el.first().setInputFiles(cover.file);
      return "cover note (file)";
    case "cover-text":
      await el.fill(cover.text);
      return cover.text;
    case "check":
      if (fill.checked) await el.check({ force: true });
      return fill.checked ? "checked" : null;
    case "value":
      if (f.kind === "combobox") await fillCombobox(page, f.id, fill.value);
      else if (f.kind === "select") await el.selectOption({ label: fill.value });
      else await el.fill(fill.value);
      return fill.value;
    case "choice": {
      if (f.kind === "select") {
        await el.selectOption(fill.values.map((label) => ({ label })));
      } else if (f.kind === "radio" || f.kind === "checkbox-group") {
        for (const v of fill.values) {
          const idx = f.options.indexOf(v);
          if (idx >= 0) await page.locator(`[data-jr-id="${f.id}"][data-jr-opt="${idx}"]`).check({ force: true });
        }
      } else if (f.kind === "combobox") {
        await fillCombobox(page, f.id, fill.values[0]);
      } else if (f.kind === "checkbox") {
        if (/^(yes|true|i agree|agree)/i.test(fill.values[0])) await el.check({ force: true });
      } else {
        await el.fill(fill.values.join(", "));
      }
      return fill.values.join(", ");
    }
  }
}

function toFill(f: FieldInfo, values: string[]): Fill {
  if (f.options.length || f.kind === "radio" || f.kind === "checkbox-group" || f.kind === "checkbox") {
    return { type: "choice", values };
  }
  return { type: "value", value: values[0] };
}

async function findSubmit(page: Page): Promise<Locator | null> {
  const candidates = [
    page.locator('button[type="submit"]:visible, input[type="submit"]:visible'),
    page.getByRole("button", { name: /submit|send application|apply/i }),
  ];
  for (const c of candidates) {
    if ((await c.count()) > 0) return c.last();
  }
  return null;
}

async function waitForResult(page: Page, startUrl: string): Promise<"success" | "challenge" | "unknown"> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (await hasChallenge(page)) return "challenge";
    const url = page.url();
    if (url !== startUrl && SUCCESS_URL.test(url)) return "success";
    const body = String(await page.evaluate(PAGE_TEXT).catch(() => ""));
    if (SUCCESS.test(body)) return "success";
  }
  return "unknown";
}

export interface FormJob {
  job: ClassifiedJob;
  ats: Ats;
  applyUrl: string;
  coverNote: string;
}

export async function applyViaForm(
  page: Page,
  { job, ats, applyUrl, coverNote }: FormJob,
  a: Applicant,
  client: LlmClient,
  dryRun: boolean
): Promise<FormOutcome> {
  const name = `${slug(job.company)}-${slug(job.title)}`;
  const coverFile = `output/cover/${name}.txt`;
  mkdirSync("output/cover", { recursive: true });
  writeFileSync(coverFile, coverNote);

  await page.goto(applyUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await dismissBanners(page);

  let fields = await collect(page);
  if (!looksLikeForm(fields)) {
    // Some postings keep the form behind an Apply button.
    const opened =
      (await clickIfVisible(page.getByRole("link", { name: APPLY_BUTTON }))) ||
      (await clickIfVisible(page.getByRole("button", { name: APPLY_BUTTON })));
    if (opened) {
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      fields = await collect(page);
    }
  }
  if (!looksLikeForm(fields)) {
    return { status: "review", reason: `no application form found on ${ats} page`, screenshot: await shot(page, name) };
  }
  if (await hasChallenge(page)) {
    return { status: "review", reason: "form shows a CAPTCHA", screenshot: await shot(page, name) };
  }

  for (const f of fields) {
    if (f.kind === "combobox" && !f.options.length) f.options = await readComboboxOptions(page, f);
  }

  const plan = new Map<string, Fill>();
  const open: FieldInfo[] = [];
  for (const f of fields) {
    const std = mapStandardField(f, a);
    if (std) plan.set(f.id, std);
    else if (f.kind === "checkbox" && !f.required) plan.set(f.id, { type: "skip" });
    else open.push(f);
  }

  const answered = await answerQuestions(client, job, a, open);
  for (const f of open) {
    const v = answered.answers[f.id];
    if (v) plan.set(f.id, toFill(f, v));
  }

  const record: Record<string, string> = {};
  const fillErrors: string[] = [];
  for (const f of fields) {
    const fill = plan.get(f.id);
    if (!fill) continue;
    try {
      const shown = await apply(page, f, fill, { text: coverNote, file: coverFile });
      if (shown) record[f.label || f.name] = shown;
    } catch (e) {
      if (f.required) fillErrors.push(`${f.label || f.name}: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  const emptyIds = ((await page.evaluate(EMPTY_REQUIRED)) as string[]) ?? [];
  const labelOf = new Map(fields.map((f) => [f.id, f.label || f.name]));
  const empty = [...new Set([...answered.unanswered, ...emptyIds.map((id) => labelOf.get(id) ?? id)])];

  if (empty.length || fillErrors.length) {
    return {
      status: "review",
      reason: [empty.length ? `needs your answer: ${empty.join(" | ")}` : "", fillErrors.join(" | ")].filter(Boolean).join("; "),
      screenshot: await shot(page, name),
      answers: record,
    };
  }

  const filledShot = await shot(page, `${name}-filled`);
  if (dryRun) return { status: "dry-run", screenshot: filledShot, answers: record };

  const submit = await findSubmit(page);
  if (!submit) return { status: "review", reason: "could not find the submit button", screenshot: filledShot, answers: record };

  const startUrl = page.url();
  await submit.scrollIntoViewIfNeeded().catch(() => undefined);
  await submit.click({ timeout: 10_000 });
  const result = await waitForResult(page, startUrl);
  const after = await shot(page, `${name}-submitted`);

  if (result === "success") return { status: "applied", screenshot: after, answers: record };
  if (result === "challenge") {
    return { status: "review", reason: "CAPTCHA appeared on submit; the form is filled in the screenshot", screenshot: after, answers: record };
  }
  // Not "failed": it may have gone through, and a retry would apply twice.
  return {
    status: "review",
    reason: "submitted but no confirmation appeared; check your inbox or the screenshot before re-applying",
    screenshot: after,
    answers: record,
  };
}
