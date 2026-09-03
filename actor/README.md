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

## Hiring signals — one row per company

Set **`outputMode: "signals"`** and the same scan comes back as one row per *company* instead of
one per posting: who is accelerating, what they have just started staffing, and what they are
building with.

A real row, exactly as the Actor returned it on 2026-09-03:

```json
{
  "record_type": "company_signal",
  "source": "ashby",
  "company": "snowflake",
  "company_url": "https://jobs.ashbyhq.com/snowflake",
  "signal": "ramping",
  "open_postings": 379,
  "postings_dated": 379,
  "opened_7d": 39,
  "opened_30d": 161,
  "opened_90d": 315,
  "baseline_30d": 77,
  "ramp_ratio": 2.09,
  "new_functions": [
    { "name": "Data Analytics and AI", "count": 8 },
    { "name": "Workplace", "count": 4 },
    { "name": "Revenue Operations", "count": 2 }
  ],
  "top_departments": [
    { "name": "Engineering", "count": 105 },
    { "name": "Solution Engineering", "count": 62 },
    { "name": "Sales", "count": 50 }
  ],
  "top_titles": [
    { "name": "Senior Solution Engineer", "count": 11 },
    { "name": "Sales Development Representative", "count": 8 }
  ],
  "tech_signals": [{ "name": "Snowflake", "count": 8 }, { "name": "GCP", "count": 1 }],
  "executive_openings_90d": 18,
  "remote_postings": 59,
  "postings_with_salary": 246,
  "oldest_posting_at": "2025-08-27T22:58:39.632Z",
  "newest_posting_at": "2026-09-02T22:56:39.577Z"
}
```

`signal` is one of:

| | |
|---|---|
| `ramping` | 3+ roles opened in the last 30 days, at **2x or more** the pace of the 60 days before that |
| `new_board` | Nothing on the board is older than 60 days — a new company, not an infinite ramp |
| `steady` | Hiring, but not accelerating |
| `quiet` | Roles are open; none was opened in the last 30 days |
| `undated` | This board published no dates, so no window can be computed. Never silently counted as quiet |

Filter with `signalTypes` and `minOpenPostings` and you are billed only for the companies you
kept — `signalTypes: ["ramping"]` over 25 boards delivers the 13 that are actually moving.

**Where this comes from, and where it stops.** Every window is computed from the publication
date each ATS puts on a posting; nothing is modelled and nothing is extrapolated. Two limits,
stated because they change how you should read the output:

- Only *currently open* roles are visible. A department whose older roles were filled looks
  newly opened. `new_functions` is evidence a function is being staffed now — not proof it did
  not exist before.
- On boards with more than 25 distinct departments the field is a site or sub-team code, not a
  function ("Baltimore Visits (BV) - 94"). `new_functions` is suppressed entirely there rather
  than returning a directory.

`tech_signals` matches whole words from a conservative list. Ambiguous terms are refused or
require a technical context: "Go" is never matched because "go-to-market" is a job title, and on
a home-care board `dbt` is Dialectical Behavior Therapy and `PHP` is a Partial Hospitalization
Program. Turning on `includeDescription` widens matching past the job title — more hits, some of
them from a stack named only in a benefits paragraph.

## Rows that are not jobs, and why one board matters more than one percent

Every feed in this category ships some rows that are not openings. We counted ours. On
2026-09-03 we read **121,050 titles from 500 live boards** and classified every one:

| | Postings | Boards carrying any, of 500 |
|---|---:|---:|
| Commission-only / MLM recruitment copy | **1,411** | **2** |
| Volunteer and unpaid listings | **445** | **8** |

The percentages are small — 1.17% and 0.37% of what we read — and **the percentage is the wrong
thing to look at.** This junk is not spread thinly across the corpus. It is concentrated:

| Board | Postings | Not a paid job |
|---|---:|---:|
| `lever/globalelitecareers` | 1,752 | **1,380 recruitment ads (79%)** |
| `greenhouse/privateequityinsights` | 1,159 | 113 volunteer (9.8%) |
| `greenhouse/cfoinsights` | 373 | 112 volunteer (30%) |
| `greenhouse/unitedmedia` | 367 | 102 volunteer (28%) |

So on roughly 490 of 500 boards these filters do nothing whatsoever, and on a handful they are
the difference between a usable run and a dataset dominated by "tired of your income being
capped?". Both are **on by default**, and both report what they took in `RUN_STATS` —
`recruitment_ads_excluded` and `volunteer_listings_excluded` — whether they are on or off. A
filter that will not tell you what it removed is worse than no filter.

Verified on a live run of build 0.1.17 against the two worst boards in the index — not inferred
from the build, run on the platform and read back out of `RUN_STATS`:

```
boards_fetched              2
postings_seen           2,911
postings_pushed         1,418
recruitment_ads_excluded 1,380   ← all from lever/globalelitecareers (1,752 → 372)
volunteer_listings_excluded 113  ← all from greenhouse/privateequityinsights (1,159 → 1,046)
```

Two deliberate limits, because a default-on filter has to be judged on its false positives:

- **Paid jobs that manage volunteers are kept.** "Volunteer Services Manager", "Director of
  Volunteer Engagement" — these are salaried roles and removing them from a jobs feed would be
  the opposite of the point.
- **The ad phrase list is the pitch, not the job.** `remote opportunity` and `no experience
  necessary` were both tested and **dropped**: they fired 2 and 0 times respectively in 121,050
  titles, against a real cost — "Registered Nurse - Remote Opportunity" is a job.

Turn either off with `excludeRecruitmentAds: false` / `excludeVolunteerListings: false` and you
get the corpus exactly as the ATS published it.

## Typical uses

- **Prospecting on hiring intent.** Companies that just opened a sales function, or that are
  ramping engineering 3x — with the technologies they are hiring for, so the list is already
  qualified.
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
| `outputMode` | `postings` | `signals` for one row per company instead of one per posting |
| `signalTypes` | — | Signals mode. `ramping`, `new_board`, `steady`, `quiet`, `undated` |
| `minOpenPostings` | `1` | Signals mode. Skip companies with fewer open roles, and skip the charge |
| `providers` | `greenhouse`, `ashby` | Add `lever` if you want it — see the speed note below |
| `keywords` | — | Match any, across title / department / team / description |
| `location` | — | Substring, e.g. `Berlin` |
| `workplace` | — | `remote`, `hybrid`, `onsite` |
| `seniority` | — | `intern` … `executive` |
| `department` | — | Substring |
| `postedSince` | — | `YYYY-MM-DD`, the delta mode |
| `withSalaryOnly` | `false` | Only rows with a parsed range |
| `excludeRecruitmentAds` | `true` | Drops commission-only / MLM copy — see above |
| `excludeVolunteerListings` | `true` | Drops volunteer and unpaid listings — see above |
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

A company signal row is billed as one delivered row, at that same $0.0015. Signals mode reads
exactly the same boards and returns one row per company rather than one per posting, so it is
much the cheaper of the two outputs: the default 500 boards costs **$1.01** as signals against
$7.76 for the 5,000 postings behind them.

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
