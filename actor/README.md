# Open ATS Jobs Feed — Greenhouse, Ashby, Lever, Breezy, Recruitee, Teamtailor

Job postings from **18,164 verified company career boards**, straight from each vendor's own
public API, normalised into a single flat schema.

No HTML scraping, no headless browser, no login. Greenhouse, Ashby, Lever, Breezy, Recruitee
and Teamtailor all publish a public JSON job-board API. The hard part is not reading them — it
is knowing **which companies exist on each one**, because not one of the six publishes a
directory. That index is what this Actor ships with.

## What you get

| | |
|---|---|
| Verified live boards | **18,164** |
| Postings behind them | **439,867** at index time |
| Providers | Greenhouse (5,971) · Ashby (3,413) · Recruitee (2,444) · Teamtailor (2,334) · Breezy (2,077) · Lever (1,925) |
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

## Duplicates: the 40% number that is mostly not a defect

40.29% of the 121,050 titles we read are an exact duplicate of another title **on the same
board**. `lever/boxlunch` carries 3,653 postings across 76 distinct titles. It would be easy to
sell that as "we remove 40% of the junk", and it would be wrong.

A retailer posting "Sales Associate" seventy-six times is filling seventy-six real openings in
seventy-six stores. The store is in the `location` field, not in the title. **A repeated title is
evidence of nothing until you read the location alongside it** — so we did, live, and the 40%
splits into two populations that deserve opposite treatment:

| | What it is |
|---|---|
| Same title, **different** stated location | Real multi-site hiring. A legitimate row. Never touched. |
| Same title, **same** stated location | The board duplicating itself. You pay twice for one place. |

Only the second is a defect. **Corpus-wide it is 3.03% of open postings** — 95% CI [2.86%,
3.22%], about 8,822 of 291,507. Measured on 2026-09-03 by reading **1,317 boards live, 166,320
postings, 57% of the corpus**, drawn from the full roster **by board size and never by how much a
board repeats itself**. The two largest size strata (498 boards, half of all postings) were read
in full rather than sampled, so half the answer carries no sampling error at all.

That 291,507 is the corpus as it stood on the measurement day, and it is left as measured rather
than rescaled to today's 439,867 — Recruitee and Teamtailor were added afterwards and were not in
the sample frame. The rate has not been re-measured against them, so treat 3.03% as covering the
four providers it was drawn from, not the six shipping now.

For contrast, across the 40 worst boards by title-repeat the rate is **8.87%** — 2.9× the corpus.
Those boards were picked *because* they repeat titles, which is exactly why that number was never
quoted as a corpus rate.

**Three things about the 3.03% matter more than the 3.03%.**

**It is a lower bound.** "Leeds" and "Leeds, UK" are two different keys to us; we strip noise
words but resolve nothing. Every alias pair is a duplicate we decline to merge. The filter
under-removes, deliberately.

**It falls off a cliff with board size.** Boards with 500+ postings: 7.60%. 100–499: 2.87%.
30–99: 1.64%. 10–29: 0.90%. **3–9: zero, across 1,102 postings read.** If you are pulling small
and mid-size boards, leave `dedupe` off — it has nothing to find for you.

**It is concentrated, so the mean describes almost nobody.** Only **452 of the 1,317 boards read
(34%) carry a single duplicate**. The worst 10 boards account for **47%** of every duplicate
found; the worst 25 for **63%**. Two buyers in three see zero. A buyer pulling
`greenhouse/herewithgmbh` sees **59.34%** — 359 duplicates in 605 postings. This is why
`RUN_STATS.duplicates_merged` reports the count for *your* boards whether the filter is on or
off: measure your run, not our corpus.

Full method, per-stratum table and worst boards: [`duplication-corpus.csv`](https://veresk06.github.io/open-ats-feed/data/duplication-corpus.csv).

### The inverse error: the city is in the title, not the location field

If you filter or group rows by `location`, you will miss postings whose place is written into the
title instead — "Sports Data Collector (American Football) - Ames, Iowa, USA" with a `location`
column that says "Statistician Network". This is the opposite defect to duplication and it is
worth knowing about before you build a location filter on top of the feed.

**Across the 225 boards that show any title fan-out — 99,147 postings read live on 2026-09-03 —
it is between 11.45% and 17.48% of postings.** The lower figure is where the posting's own
`location` field confirms the title carries the place; the upper adds every posting whose title
tail names a token the corpus uses as a place elsewhere.

**This is a stratum, not a corpus rate.** Those 225 boards were selected *because* their titles
fan out, the same way the 8.87% duplicate figure above came from the 40 worst repeaters. Do not
read it as "17% of the feed". It bounds the problem on the boards where the problem exists.

The band is still wide because the residual ambiguity is real: the tokens driving it are `new`,
`south`, `san`, `canada`, `mexico`, `japan`. A title tail reading "New Ventures" genuinely does
contain a place name. Method, both bounds and every token with its counts:
[`cycle-29-gazetteer-title-side.md`](https://github.com/veresk06/open-ats-feed/blob/main/docs/research/cycle-29-gazetteer-title-side.md).

Set `dedupe: true` and one row survives each same-title-same-location group, carrying
`duplicates_merged` — how many copies were folded into it. Nothing is silently discarded: a
company that posted one role at one site twelve times is telling you something about its hiring,
and a filter that threw that away would be destroying signal to save storage.

Three live boards, the third chosen as a negative control:

| Board | Postings | Distinct titles | Merged | Rate |
|---|---:|---:|---:|---:|
| `lever/boxlunch` | 3,653 | 76 | **1,126** | 30.82% |
| `greenhouse/blueskytelepsych` | 945 | 5 | **161** | 17.04% |
| `greenhouse/geniussportssn` | 477 | 475 | **2** | 0.42% |

Verified on two live runs of build 0.1.18 over those three boards — run on the platform and read
back out of `RUN_STATS`, not inferred from the build:

```
dedupe: true    postings_seen 5,075   postings_pushed 3,786   duplicates_merged 1,289
dedupe: false   postings_seen 5,075   postings_pushed 5,060   duplicates_merged 1,289
```

Same number both times. With the flag on it is what was removed; with it off it is what would
have been. 5,075 − 1,289 = 3,786, so nothing is lost to rounding or to a second rule.

The third board is the check that the rule is not just counting repeated words.
`geniussportssn` writes the city *into* the title — "Sports Data Collector (American Football) -
Ames, Iowa, USA" — so it is one role posted at 475 different places. A title-only rule sees 475
distinct titles and a naive location rule could see one employer duplicating itself. This one
correctly leaves it almost entirely alone.

**Why this is off by default when the other two Quality filters are on.** Those remove rows that
are not paid openings at all. This one removes rows that may well be: a company opening three
headcount at one site often posts three requisitions with three distinct `job_id`s, identical
titles and identical locations, and the ATS does not publish headcount, so nothing in the feed
can tell those apart from three copies of one job. Dropping a real opening is worse than
carrying a duplicate, so the choice is yours rather than ours.

Two conservatisms worth knowing before you turn it on:

- **A posting with no stated location is never collapsed.** Unstated is not the same as
  same-place. Roughly a fifth of the corpus publishes no location, and treating those as one
  place would delete real jobs in bulk.
- **Location strings are compared, not resolved.** "Chicago, IL" and "IL - Chicago" are one
  place; "Chicago, IL" and "Aurora, IL" are two. `remote` / `hybrid` / `onsite` are ignored in
  the comparison, because a board that writes its work arrangement into the location column
  would otherwise defeat the rule — the workplace type is carried in its own field regardless.

`RUN_STATS.duplicates_merged` reports the count **whether `dedupe` is on or off**, so you can see
what it would take on your own query before you turn it on.

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
| `dedupe` | `false` | Collapses same-title-same-stated-location rows within a board — see above |
| `companies` | — | `greenhouse:stripe`, `ashby:ramp`, or bare `stripe` — overrides the index |

A bare token is routed to the provider the roster already has it on, so naming one company
costs one board-scan rather than one per selected provider. Only a token the roster has never
seen — a board that appeared after our last sweep, which is what this input is for — is tried
across every selected provider.
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

**Why the scan is charged separately.** A narrow filter over the whole index reads 18,164 boards
to hand back a few hundred rows. Priced per result, that run costs you almost nothing and costs
us the entire sweep, which is the kind of arrangement that ends with the Actor being withdrawn.
Charging the read and the row separately means you pay for the work you actually asked for, and
a broad cheap query stays broad and cheap.

Worked examples:

- **Default run** — 500 boards, 5,000 postings: **$7.76**, or $1.55 per 1,000 postings.
- **Full sweep** — 18,164 boards, ~440,000 postings: **$668.89**, or $1.52 per 1,000.
- **One title across everything** — 18,164 boards, 300 matching postings: **$9.54**.
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
- **18,164 is counted, not projected.** Every provider was probed token by token: Greenhouse,
  Ashby, Breezy, Recruitee and Teamtailor in full, Lever 5,140 of 5,220 candidate tokens.
  Earlier versions of this page quoted a Lever figure extrapolated from a 1,000-token sample and
  a Breezy figure from a 250-token one; both projections are gone, and nothing above rests on
  one. The 80 tokens still unprobed ship as an opt-in list and are counted as neither live nor
  dead.
- **1,803 of those boards came from someone else's published list, and were probed, not copied.**
  [`kalil0321/ats-scrapers`](https://github.com/kalil0321/ats-scrapers) (MIT) publishes a board
  snapshot. It held 2,035 tokens across these six providers that we did not; every one was probed
  on the same terms as every other row — HTTP 200, at least one open posting, same retries and
  back-off — and 1,803 answered. **No status, posting count or company name was taken from their
  file.** The reverse diff is published too: we hold 5,929 boards their snapshot does not, and
  that is a lower bound on their coverage rather than a verdict on it, because their list spans
  more providers than we ship.
- **A published snapshot ages, and unevenly.** Probing their list is also the clearest evidence
  for why this one is probed rather than compiled: **152 of their 458 Lever boards (33.2%) answer
  404 today**, against 97.5% still live on Greenhouse. The same decay applies to our numbers, at
  whatever rate, which is why every row here ships with the API URL that produced it and an
  `index_as_of` date you can hold it to.
- **A board that refuses us under load is not counted dead.** Recruitee refused 5 of 3,554
  tokens when probed at concurrency 8. Re-asked one at a time, four of the five answered with
  live boards worth 61 postings. A refusal is a fact about our request rate, so those tokens are
  re-probed slowly before any number here is published.
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
