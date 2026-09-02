# Open ATS Jobs Feed — Greenhouse, Ashby, Lever

Job postings from **10,197 verified company career boards**, straight from each vendor's own
public API, normalised into a single flat schema.

No HTML scraping, no headless browser, no login. Greenhouse, Ashby and Lever all publish a
public JSON job-board API. The hard part is not reading them — it is knowing **which companies
exist on each one**, because none of the three publishes a directory. That index is what this
Actor ships with.

## What you get

| | |
|---|---|
| Verified live boards | **10,197** |
| Postings behind them | **291,507** at index time |
| Providers | Greenhouse (5,506) · Ashby (3,153) · Lever (1,538) |
| Index built | 2026-09-03, from 17 Common Crawl indexes |

Every record is the same shape whatever the source:

```json
{
  "source": "ashby",
  "company": "ramp",
  "company_url": "https://jobs.ashbyhq.com/ramp",
  "job_id": "0f7b...",
  "title": "Senior Software Engineer, Payments",
  "url": "https://jobs.ashbyhq.com/ramp/0f7b...",
  "location": "New York, NY",
  "workplace": "hybrid",
  "department": "Engineering",
  "team": "Payments",
  "employment_type": "FullTime",
  "posted_at": "2026-08-21T10:02:00.000Z",
  "updated_at": "2026-08-29T18:44:00.000Z",
  "salary_min": 180000,
  "salary_max": 245000,
  "salary_currency": "USD",
  "seniority": "senior",
  "index_as_of": "2026-09-03",
  "fetched_at": "2026-09-03T09:15:22.101Z"
}
```

Three fields are derived rather than copied, and it is worth knowing how:

- **`workplace`** — `remote` / `hybrid` / `onsite`. Taken from the vendor's own workplace field
  where one exists, and from the location text otherwise. It deliberately ignores Ashby's
  `isRemote` boolean, which is `true` for hybrid roles as well: on one board, 110 postings were
  tagged `workplaceType: "Hybrid", isRemote: true` and located "New York, NY (HQ)". Trusting it
  called two thirds of the feed remote, wrong by about 3x.
- **`salary_min` / `salary_max` / `salary_currency`** — parsed out of free text, which is the
  only place these vendors put pay. Left `null` unless the range is unambiguous. A wrong salary
  is worse than an absent one.
- **`seniority`** — `intern` / `junior` / `mid` / `senior` / `principal` / `executive`, inferred
  from the title.

## Typical uses

- **A daily delta.** Set `postedSince` to yesterday and poll. You pay for what changed instead
  of re-downloading a quarter of a million rows.
- **Sourcing / recruiting intelligence.** Which companies are hiring which roles, where, at what
  band.
- **Job board and aggregator backfill.** One schema instead of three integrations.
- **Market research.** Hiring volume by department, remote share, salary bands over time.

## Input

Everything is optional. `maxCompaniesPerProvider` is **per provider, not per run**, so with no
input at all you get the 250 largest Greenhouse boards *and* the 250 largest Ashby boards —
500 boards — capped at 5,000 postings.

| Field | Default | Notes |
|---|---|---|
| `providers` | `greenhouse`, `ashby` | Add `lever` if you want it — see the speed note below |
| `keywords` | — | Match any, across title / department / team / description |
| `location` | — | Substring, e.g. `Berlin` |
| `workplace` | — | `remote`, `hybrid`, `onsite` |
| `seniority` | — | `intern` … `executive` |
| `department` | — | Substring |
| `postedSince` | — | `YYYY-MM-DD`, the delta mode |
| `withSalaryOnly` | `false` | Only rows with a parsed range |
| `companies` | — | `greenhouse:stripe`, `ashby:ramp`, or bare `stripe` — overrides the index |
| `maxCompaniesPerProvider` | `250` | **Per provider.** Two providers selected = up to 500 boards. Ordered largest first, so a cap gets the big ones |
| `maxItems` | `5000` | Hard cap on rows |
| `includeDescription` | `false` | Full plain-text description; ~10x the dataset size |
| `includeEmptyBoards` | `false` | 1,268 boards that existed but were empty at index time |
| `includeUnverifiedLever` | `false` | 381 unprobed Lever tokens |

## Pricing

Pay per event, three events:

| Event | Price | Charged |
|---|---|---|
| Run start | $0.005 | Once, after your input validates |
| Company board scanned | $0.0005 | Per board we successfully read — $0.50 per 1,000 |
| Job posting delivered | $0.0015 | Per row written to the dataset, after filters — $1.50 per 1,000 |

**Why the scan is charged separately.** A narrow filter over the whole index reads 10,197 boards
to hand back a few hundred rows. Priced per result, that run costs you almost nothing and costs
us the entire sweep, which is the kind of arrangement that ends with the Actor being withdrawn.
Charging the read and the row separately means you pay for the work you actually asked for, and
a broad cheap query stays broad and cheap.

Worked examples:

- **Default run** — 500 boards, 5,000 postings: **$7.76**, or $1.55 per 1,000 postings.
- **Full sweep** — 10,197 boards, ~290,000 postings: **$440.10**, or $1.52 per 1,000.
- **One title across everything** — 10,197 boards, 300 matching postings: **$5.55**.
- **Daily delta** — `postedSince=yesterday` over 500 boards, ~400 new postings: **$0.86**.

A board we could not read after four attempts is not charged. You paid for a result we did not
produce is not a line item we want in a review.

## Honest notes about coverage

This section is here because the Actor's only real claim is that its coverage is measured, and
a measured number you cannot audit is worth the same as a guess.

- **The company index is discovered from Common Crawl**, not from a vendor directory — no vendor
  publishes one. Coverage is therefore a function of how far back the crawl sweep goes. Ours
  covers 17 indexes. Marginal yield across the tail was roughly flat at 240–493 new candidate
  tokens per additional index, so sweeping further would find more companies. This number is not
  a fixed property of the internet; it is a property of how much sweeping we did.
- **10,197 is counted, not projected.** All three providers were probed token by token:
  Greenhouse and Ashby in full, Lever 4,580 of 4,961 at a 33.6% hit rate. Earlier versions of
  this page quoted a Lever figure extrapolated from a 1,000-token sample; that projection is
  gone, and nothing above rests on one. The 381 tokens still unprobed ship as an opt-in list
  and are counted as neither live nor dead.
- **`index_as_of` is on every record.** Boards open and close. The index is refreshed out of
  band; the postings themselves are always fetched live at run time.
- **Lever runs at 1 request per second**, because `api.lever.co/robots.txt` asks for
  `Crawl-delay: 1` and we honour it. 250 Lever boards is about 4 minutes of wall clock.
  Greenhouse and Ashby have no such request and run concurrently.
- **A board that refuses us is reported as failed, never as empty.** 403/429/5xx and timeouts
  are facts about the request, not verdicts about the company. `RUN_STATS` in the key-value
  store carries `units_completed` / `units_planned` and a `complete` flag, so a truncated run
  can never be mistaken for a full one.

## Source

Index build scripts, the coverage measurement and its raw output:
**https://github.com/veresk06/open-ats-feed** (MIT).

Found a company missing, or a field parsed wrong? Open an issue there.
