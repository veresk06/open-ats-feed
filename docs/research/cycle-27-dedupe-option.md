# Cycle 27 — the `dedupe` option, and what two platform runs said about the charge ceiling

**Date:** 2026-09-03
**Build:** 0.1.18 (`bMtkiY7lzUpCjEn1V`)
**Platform spend this cycle:** $0.043 (0.123 → 0.166 of $5.00)

## What shipped

`dedupe` — an opt-in Actor input that collapses same-title-same-**stated**-location postings
within one board, keeping the first copy and recording the collapsed count on it as
`duplicates_merged`.

The rule is deliberately byte-identical to `scripts/duplication.mjs` (`normTitle`, `normLoc`,
`LOC_NOISE`), so the 8.87% published in Cycle 26 describes exactly the population this filter
removes. If the two ever drift, the number in the Store listing stops describing the product,
which is the failure mode the other two quality filters were written to avoid. A test in
`actor/test/dedupe.test.js` re-derives the audit's arithmetic and asserts the two agree, because
the Actor image is standalone and cannot import from `scripts/`.

## Verification

### Locally, against three live boards

Fetched from the vendors' public APIs, both methods run over the same rows:

| Board | Postings | Distinct titles | Audit `same_location` | Actor merged | Agree |
|---|---:|---:|---:|---:|---|
| `lever/boxlunch` | 3,653 | 76 | 1,126 | 1,126 | yes |
| `greenhouse/blueskytelepsych` | 945 | 5 | 161 | 161 | yes |
| `greenhouse/geniussportssn` | 477 | 475 | 2 | 2 | yes |

The third is the negative control and it is the one worth looking at. `geniussportssn` is the
board the Cycle-26 gazetteer was built for: it writes the city into the title, 477 postings
across 475 distinct titles, one role at 475 places. A title-only rule sees 475 distinct titles;
a careless location rule could see an employer duplicating itself. This rule merges **2**. The
filter is measuring what it claims to measure and not a proxy for it.

`boxlunch` at 30.82% is well above the 8.87% stratum average, which is what "worst-offender
stratum" means — the audited 40 are not uniform either.

### On the platform, build 0.1.18

Two runs, identical input except the flag, both filters off so the populations are comparable:

| | `dedupe: true` | `dedupe: false` |
|---|---:|---:|
| `postings_seen` | 5,075 | 5,075 |
| `postings_pushed` | 3,786 | 5,060 |
| `duplicates_merged` | **1,289** | **1,289** |
| `complete` | true | **false** |

`5,075 − 1,289 = 3,786` exactly. Per provider, both runs match the local figures:
greenhouse 1,422 → 1,259 (163 merged = 161 + 2), lever 3,653 → 2,527 (1,126 merged).

The identical `duplicates_merged` on both runs is the point of the second run. It also verifies a
fix made this cycle to a promise the listing had not been keeping — see below.

## Two decisions, stated because they went against the obvious choice

### Off by default, unlike the other two quality filters

`excludeRecruitmentAds` and `excludeVolunteerListings` remove rows that are **not paid openings
at all**, and both were audited to zero measured false positives before being defaulted on.

This one is different in kind and the difference is not in our favour. A company opening three
headcount at one site frequently posts three requisitions with three distinct `job_id`s,
identical titles and identical locations. That is three real jobs, and this rule cannot tell them
from three copies of one job — the ATS does not publish headcount, so the information needed to
decide **is not in the feed**. Dropping a real opening from a jobs feed is worse than carrying a
duplicate. The buyer chooses; the default keeps everything.

### Collapse and annotate, not drop

The surviving row carries `duplicates_merged`. A company that posted one role at one site twelve
times is telling you something about its hiring intensity, and a filter that discarded that would
be destroying signal to save storage. This is the same call as Cycle 26's on `ai_gig_work`:
label, do not delete, and let the buyer's own judgement act on the label.

### Applied in signals mode too

Not for cost — no signals row is billed per duplicate. Because a retail chain posting one role at
seventy-six stores under one location string reads as a hiring ramp it is not. With the flag on,
`open_postings`, the 7/30/90-day windows and `minOpenPostings` all count collapsed rows.

## A promise the listing was not keeping, now kept

The input schema has said since build 0.1.6 that `RUN_STATS.recruitment_ads_excluded` and
`volunteer_listings_excluded` report their counts "whether it is on or off". **They did not.**
The counters sat behind their own flags:

```js
if (excludeRecruitmentAds && isRecruitmentAd(r)) { stats.recruitment_ads_excluded++; return false }
```

so a run with a filter turned off reported **zero** ads rather than the ads it had just
delivered — the one case where a buyer most needs the number. The rules are now evaluated
regardless and only the dropping is gated on the flag. Run B above is the check: filters off,
`duplicates_merged` reported anyway.

One consequence, stated rather than hidden: the two rules are now counted independently, so a row
matching both increments both. These are per-rule match counts, not a partition. On the measured
corpus the populations are disjoint — 2 boards of 500 carry ads, 8 carry volunteer listings, none
carries both — so no total moves today, but at larger scale they could overlap.

## Unplanned finding: the budget-halt path is timing-dependent

Both runs were capped at `maxTotalChargeUsd: 4.867623` — the platform set it to our remaining
free-tier credit, not something we chose — and both charged exactly **3,241** `job-result`
events, which is that ceiling divided by our $0.0015 per-result price.

Run B noticed the trim, set `stop`, abandoned the last 15 of 5,075 rows and reported
`complete: false`. **Run A delivered all 3,786 rows while charging the same capped 3,241, and
reported `budget_reached: false`.** Both runs lasted ~4.7 seconds.

So `pushData`'s `chargedCount` did not report the shortfall to run A within the life of the run.
The most likely explanation is that the platform's charge accounting is eventually consistent and
run A finished before it caught up — but that is a hypothesis, not a measurement, and it is not
reproduced.

**What this is not:** a customer being billed for rows they did not receive. Both failure
directions observed are safe — run A over-delivered against what it charged, run B dropped 15
rows and said so in `complete: false`, which is exactly the flag's job. It is also an artifact of
*our* nearly-exhausted FREE-plan credit setting the ceiling; a customer's `maxTotalChargeUsd` is
their own.

**Deliberately not fixed this cycle.** Changing charge-halt logic on a live paid Actor on the
strength of one unreproduced observation is the move that earns a refund and a one-star review.
It is recorded as an open question with the run IDs (`7amwoauoaCA70Xiac`, `0aCD66sCnXt5zcXZ3`) so
the next attempt starts from evidence rather than from memory.

## What this does not tell us

**The corpus-wide same-location duplicate rate is still unmeasured.** 8.87% is the rate across
the 40 boards selected *because* they repeat titles. Both the README and the input schema say so
explicitly rather than quoting 8.87% as a corpus number. Measuring it properly needs a sweep with
the location field over a board sample that was not chosen for duplication — that is the next
piece of work on this thread, and it costs $0.00 on Apify because it runs locally.

> **Measured in Cycle 28: 3.03%, 95% CI [2.86%, 3.22%].** 1,317 boards read live, 166,320
> postings, 57% of the corpus. The 8.87% above overstates it by 2.9×, which is what a
> worst-offender stratum is supposed to do. See
> [`cycle-28-corpus-duplicate-rate.md`](./cycle-28-corpus-duplicate-rate.md).
