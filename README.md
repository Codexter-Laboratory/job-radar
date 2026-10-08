# job-radar

A pipeline that collects job postings from twelve sources, normalises
them into one schema, and decides which ones a contractor in Lebanon invoicing
through a Georgian company could actually take.

The interesting part is not the scraping. It is that the second stage is an LLM,
and an LLM you cannot measure is an LLM you cannot trust, so the repository ships
an eval harness and a hand-labelled golden set alongside it.

## The problem

Keyword filters answer "does this title contain react". That is not the question.
The question is "will this company hire someone outside the EU who invoices as a
company", and the answer lives in prose halfway down the description: *EMEA
timezones*, *must hold EU work authorisation*, *we hire through Deel*,
*contractors welcome*. Rules cannot read that. A model can, imperfectly, and the
job of the eval is to say how imperfectly.

## How it works

```
sources ──► prefilter ──► dedupe ──► classifier ──► digest
 12 APIs     keywords     cross-      LLM, prompt    markdown +
             recall-      posting     v1/v2/v3       csv + json
             first        aware
```

**Stage one** is the old keyword filter, deliberately tuned for recall. Paying
for one unnecessary classification is cheaper than never seeing a role that
fitted. It reports how many postings each rule removed so the recall bias can be
checked rather than assumed.

**Dedupe** runs before the classifier, because every posting removed here is a
model call not paid for. The same role is routinely cross-posted as *Senior
Frontend Engineer* on an ATS and *Senior Frontend Engineer (Remote) - EMEA
(m/f/d)* on an aggregator, so titles are reduced to a comparable core and URLs
are compared with tracking parameters stripped.

**Stage two** asks a model the eligibility question and requires a structured
answer: eligible, employment type, the constraint quoted verbatim from the
posting, a confidence, and a one-sentence reason. Malformed responses are
retried, then recorded as failures. A posting the classifier could not judge is
marked unclassified, never quietly dropped.

**Output** is a markdown digest split into what is new since yesterday, what is
still open, and what the model was unsure about, plus CSV and JSON for anything
downstream.

## Measuring it

```bash
npm run label        # build the golden set, one posting at a time
npm run eval         # score the default prompt
npm run eval -- v1 v2 v3   # score three prompts against the same set
```

Prompts are versioned rather than edited in place, so a change that reads better
but scores worse shows up instead of being assumed to be an improvement:

- **v1** title and location only, the baseline the keyword filter already had
- **v2** adds the description body, where the constraints actually are
- **v3** adds decision rules for the cases v2 misread

The harness reports precision, recall, F1, employment-type accuracy, a confusion
matrix, cost per thousand postings, and every disagreement in full so the
failures can be read rather than counted.

### Results

Not yet measured. The golden set needs at least 100 labelled postings before any
number here would mean anything, and publishing a score from thirty would be
worse than publishing none.

Once labelled, `npm run eval -- v1 v2 v3` prints this table ready to paste:

| Prompt | Model | n | Precision | Recall | F1 | Cost / 1k |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

## Running it

```bash
npm install
cp .env.example .env    # add an OpenAI or Anthropic key
npm run scrape
```

Without a key the pipeline still runs and stops after dedupe, so the scraper is
usable on its own. Output lands in `output/`.

```bash
npm test        # 127 tests, no network
npm run typecheck
```

## Sources

Official public APIs, safe to run daily: Greenhouse, Lever, Ashby, Workable and
Recruitee for per-company boards, plus Remotive, RemoteOK, Arbeitnow, Himalayas,
Jobicy and We Work Remotely for aggregate feeds.

LinkedIn's guest search endpoint is included as bonus coverage. It works without
a login but rate-limits and changes its markup, so its parser is isolated,
fixture-tested, and its failures never fail the run.

**Indeed, Bayt and GulfTalent are deliberately not implemented.** They sit behind
bot protection that blocks datacenter IPs within minutes. Scraping them reliably
needs residential proxies and a headless browser, which costs money and breaks
their terms. Email alerts are the supported route. The decision is recorded in
`src/sources/misc.ts` so it does not get re-litigated.

## Failures are reported, not swallowed

An earlier version caught every error silently, which meant a broken adapter and
a quiet job market looked identical from the outside. Now every source records
whether it worked, how many postings it returned, how long it took and what went
wrong, into `output/run-report.json` and the digest. An ATS board where every
company slug failed is marked unhealthy rather than empty, and the run exits
non-zero when more than half the sources are down, so CI goes red when the
pipeline breaks and stays green when nobody is hiring.

## Company websites and job boards without an API

`companySites` takes plain domains. For each one the crawler finds the careers
page, reads any schema.org `JobPosting` data on it, follows links to individual
postings, and spots embedded ATS boards (Greenhouse, Lever, Ashby, Workable,
Recruitee, SmartRecruiters, Personio). Discovered boards are fetched through
their APIs in the same run, so adding a company is just adding its domain.

`jobBoards` takes a listing URL and a pattern for offer links (justjoin.it and
nofluffjobs are set up; both list B2B rates on most offers). Pages that render
client-side are opened in headless Chromium. robots.txt is respected and
requests are spaced by `crawl.delayMs`.

A site that yields nothing shows up in the run report under `company-sites`
with the reason, so a dead domain is easy to spot and remove.

## Auto-apply

`npm run apply` takes today's eligible postings and applies to them. `npm run daily`
runs the scrape and then the apply stage.

```
eligible, confident ──► router ──► ATS form ─────► filled, screenshot, submitted
                                ├► apply email ──► sent with CV over SMTP
                                ├► aggregator ───► opened, real apply link followed
                                └► review ───────► LinkedIn, CAPTCHA, unknown site,
                                                   or a question the facts don't cover
```

Supported forms: Greenhouse, Lever, Ashby, Workable and Recruitee. Standard fields
(name, contact, links, CV, consent, EEO declines) are filled by rule. Every other
question goes to the model in one call with the facts in `applicant.json`; it must
answer `null` when those facts don't cover the question, and choice answers must
match an offered option. A required question left unanswered sends the job to
review instead of guessing.

Guard rails, all in `config.json` under `apply`:

- `dryRun` fills and screenshots without submitting. It ships as `true`.
- `dailyCap` submissions per day, `minConfidence` from the classifier, allowed
  `employmentTypes`, one application per company per `companyCooldownDays`.
- A submit without a visible confirmation goes to review, never to retry, so
  nothing is sent twice.

Sites that forbid automated applications (LinkedIn, Indeed, Bayt, GulfTalent) and
forms with a visible CAPTCHA are not automated. They land in
`output/applications.md` and the daily email with a cover note and answers ready.
After applying by hand, `npm run done -- <url>` marks them.

### Setup

```bash
npm install
npm run setup                          # downloads Chromium for Playwright
cp applicant.example.json applicant.json   # fill every TODO
mkdir -p private && cp ~/path/to/cv.pdf private/cv.pdf
cp .env.example .env                   # LLM key + SMTP app password
npm run daily                          # first run: dry run, check output/screenshots
```

Set `"dryRun": false` once the screenshots look right, then schedule it:

- On your own machine (recommended, residential IP): `./scripts/schedule.sh`
- On GitHub Actions: repo variables `APPLY=true`, `APPLY_DRY_RUN=false`, optionally
  `RUNNER=self-hosted`; secrets `APPLICANT_JSON` (the file's contents),
  `CV_PDF_BASE64` (`base64 -w0 private/cv.pdf`), the LLM key, and `SMTP_*`.

Personal data never reaches git: `applicant.json`, the CV, screenshots, cover notes
and answers are gitignored, and the committed `output/applications.json` holds only
company, title, URL and status.

## Layout

```
src/sources/     one adapter per vendor; mapping is separate from fetching
src/pipeline/    prefilter, dedupe, classifier, prompts, LLM clients, reporting
src/eval/        golden set, labelling CLI, scoring, eval runner
src/store/       first-seen history, so the digest knows what is new
src/output/      CSV and digest rendering
src/apply/       router, form filler, answer writer, mailer, ledger
tests/           103 tests against fixtures, no network
```

Mapping is kept separate from fetching throughout, which is what lets every
vendor payload be tested against a captured fixture offline.

## Licence

MIT.
