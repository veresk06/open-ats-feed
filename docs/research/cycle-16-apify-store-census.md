# Apify Store census: where we actually sit in the ATS category

**Date:** 2026-09-03 (Cycle 16)
**Method:** ten `GET /v2/store?search=…` queries (`ats jobs`, `greenhouse jobs`, `lever jobs`,
`ashby jobs`, `hiring signals`, `hiring intent`, `job postings api`, `career page jobs`,
`workday jobs`, `companies hiring`), `limit=100` each, deduplicated by `username/name`.
625 distinct public Actors surfaced; 318 of them carry Greenhouse, Lever, Ashby or "ATS" in the
title. All counts are `stats.totalUsers` read from the public API, so they include each
creator's own account exactly as ours does — the comparison is like-for-like.

## The finding

| Statistic, over 318 ATS Actors | Value |
|---|---:|
| Median `totalUsers` | **2** |
| 90th percentile | 18 |
| Maximum | 779 |
| Actors under 10 users | **280 of 318 (88%)** |

**We have 2 users. We are exactly the median entrant in a 318-way commodity market.**

The operator's demand tripwire is ≥10 external users. Measured against this distribution,
clearing it through the store listing alone means finishing **above 88% of 318 competitors**,
in a popularity-ordered store, starting from zero. That is not a stretch goal, it is a
different business.

## The load-bearing datapoint: our twin

`tokyo-cat/ats-job-feed` — *"ATS Job Feed — Greenhouse, Lever & Ashby in one schema"*.

| | tokyo-cat/ats-job-feed | ours |
|---|---|---|
| Created | 2026-08-26 | 2026-09-02 |
| Vendors | Greenhouse, Lever, Ashby | Greenhouse, Ashby, Lever |
| Positioning | "only public ATS endpoints" | "official public APIs, no scraping" |
| Pricing | **FREE** | pay-per-event |
| Users | **3** | 2 |
| Runs | 14 | 20 |

Eight days older, same three vendors, same public-API wedge, and *free* — and it has three
users. This is the cleanest available forecast for our listing, and it was measured on a
same-vintage twin rather than assumed. Note in particular that **going free did not buy it
users**, which removes price from the list of plausible fixes.

## Why the store cannot be won from here

Store search is popularity-ordered. A new Actor ranks below every established one for every
query a buyer would type, so it gets no runs; with no runs it gains no popularity; with no
popularity it never ranks. That loop is closed, and the 88%-under-10-users figure is what the
loop looks like in aggregate — it is not a long tail of bad products, it is the ordinary fate
of an entrant.

The incumbents confirm the shape from the other end. The winners run **portfolios segmented by
vendor**, not single general Actors: `fantastic-jobs` fields `greenhouse-jobs-api` (779),
`ashby-jobs-api` (392) and `lever-co-jobs-api` (214) separately, and `jobo.world` mirrors the
same structure (641 / 397 / 164 / 155). Their advantage is accumulated ranking across many
listings plus review counts we cannot manufacture — `fantastic-jobs/career-site-job-listing-api`
alone holds 6,678 users, 934,549 runs, 4.75★ and 101 bookmarks.

## The reposition we tested and rejected

The plan going into this cycle was to move the listing out of the crowded "ATS scraper" slot
into "hiring signals", where our ramp computation is genuinely differentiated. **Measured
first, and it fails:** that slot is occupied too.

| Actor | Users |
|---|---:|
| `samstorm/hiring-intent-lead-scraper` | 96 |
| `alizarin_refrigerator-owner/linkedin-jobs-scraper-b2b-hiring-intent-signals` | 59 |
| `mambalabs/gtm-hiring-signal-scraper` — *"Greenhouse Lever Ashby Job Scraper: GTM Hiring Signals"* | 20 |
| `signalbase/signalbase-hiring` | 20 |
| `constructive_calm/ats-hiring-intent-scraper` | 5 |
| `alexthecreator/hiring-intent-account-feed` | 4 |

Rewriting the title would have moved us from one commodity slot to another and produced a
cycle's worth of visible activity with no mechanism behind it. Not done.

## What this does and does not say

**It does not say the product is bad or the measurement work was wasted.** The coverage
measurement, the ramp register and the provenance claim are real and, as far as this census
shows, unduplicated as *public artifacts* — none of the 318 publishes a free, market-wide,
dated measurement. What none of that has is a route to a human.

**It does say the channel is the constraint, and we have been treating the product as the
constraint for fourteen cycles.** Every artifact shipped since publication has been supply.
The tripwire has not moved by one user, and this census explains why: supply added to a
318-deep commodity shelf, in a popularity-ranked store, is invisible by construction.

## Decision

1. **Stop investing cycles in the Apify listing.** It stays published — it costs nothing and
   is a lottery ticket — but it gets no more build, copy or pricing time.
2. **The binding constraint is distribution, and it is now the only thing worth working on.**
   Ranked by what is actually reachable today: LinkedIn (live, authorised, unknown reach);
   inbound links to get the pages crawled at all; and channels that need an operator step
   (Google Search Console, a Reddit account with standing, a DEV.to or Hashnode account).
3. **Do not confuse building another artifact with progress.** The next cycle that ships a page
   nobody reads is a wasted cycle.
