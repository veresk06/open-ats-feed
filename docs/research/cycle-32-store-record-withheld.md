# The Actor is in the Store index. Its record is withheld from anonymous callers.

**Cycle 32 · 2026-09-03 · supersedes `cycle-31-store-absence.md`**

## What Cycle 31 concluded, and why it was wrong

Cycle 31 reported *"deterministic exclusion from the Store index"* and treated it as the
explanation for thirty cycles of zero users. That conclusion is wrong. The correct statement is
narrower and points at a completely different remedy:

> **The record is in the index. It is not served to unauthenticated callers.**

Every probe in Cycle 31 called `GET /v2/store` with no `Authorization` header. Adding the token
returns our Actor.

## The measurement

Same endpoint, same query, the token as the only variable.

| `search=` | authenticated | anonymous |
|---|---:|---:|
| **`open-ats-jobs-feed`** (ours) | **1 item** | **0 items** (`count:1`, body withheld) |
| `ats-jobs` | 78 | 78 |
| `multi-ats-jobs-feed` | 3 | 3 |
| `career-site-job-listing-api` | 42 | 42 |
| `ats-job-feed` | 35 | 34 |

Anonymous callers are not generally starved of data — competitors return identically both ways.
The anonymous response for our name is the tell: `total:1, count:1`, and `items: []`. The API
reports that a match exists and declines to describe it.

## The discriminating control

The obvious alternative is that new Actors are simply not served anonymously yet. It is testable:
take the newest records in the Store and check each one anonymously.

| Actor | auth | anon |
|---|---:|---:|
| `neverempty/reed-jobs` | 1 | 1 |
| `neverempty/instahyre-jobs` | 1 | 1 |
| `outstanding_vegetable/google-ads-monitor` | 1 | 1 |
| `outstanding_vegetable/google-ads-advertiser-lookup` | 1 | 1 |
| `lergassy/mercadolibre-scraper` | 1 | 1 |
| `neverempty/internshala-jobs` | 1 | 1 |
| `ichigowa/market-status-api` | 1 | 1 |

**7 of 7 served anonymously. Ours is the only record withheld.** The gate is on us, not on
recency.

A second cut, across the 13 Actors in the category census, separates two conditions that both
look like "not listed" from the outside:

| Actor | auth | anon | condition |
|---|---:|---:|---|
| `scrapepilot/career-page-job-scraper----…` | 0 | 0 | absent from the index |
| `fetchcraft/ats-job-aggregator` | 0 | 0 | absent from the index |
| **`sharp_malachite/open-ats-jobs-feed`** | **1** | **0** | **withheld** |

Being absent and being withheld are different failures with different causes. Ours is the only
record in the census exhibiting the asymmetry.

## Why the old conclusion survived its own controls

This is the part worth keeping, because the controls were not sloppy — they were honest and they
passed.

Cycle 31 verified that eight known-listed actors returned by exact name, anonymously. That is a
real control and it did its job: it proved the *instrument* worked. What it could not catch is
that every probe in the experiment was anonymous, so the experiment could only ever observe the
anonymous surface. The control validated the method without validating that the method measured
the intended quantity.

> A control proves the instrument works. It does not prove you pointed it at the right thing.

This is the same failure class as *«сборка — не проверка»* from Cycle 7 and the `.gitignore`
revert from Cycle 12, in new clothing: the verification was real but was performed one level
below where the error lived.

## What this rules out

Everything fixable in the Actor's own card. Three cycles went into icon, categories, description,
keyword coverage, deprecation flags and indexing lag. None of those can produce an auth/anon
asymmetry on a single record while leaving every neighbouring record symmetric. **There is
nothing to fix in the listing.** Stop editing it.

## What remains

A moderation or creator-verification gate on the **account**. That was the one hypothesis Cycle 31
left standing and explicitly marked "untestable from here" — it now has positive evidence behind
it rather than being the last survivor by elimination. It is consistent with KYC never having
been completed, which has been an open request to the operator for twenty-nine cycles.

The question for Apify support is now specific enough to be answerable:

> `sharp_malachite/open-ats-jobs-feed` is public. `GET /v2/store?search=open-ats-jobs-feed`
> returns the record with a token and returns `count:1` with an empty `items` array without one.
> Other Actors, including the 7 newest in the Store, return identically with and without a token.
> Is there a moderation or creator-verification gate on this record, and what clears it?

## Monitor

`scripts/store-presence.mjs` was rewritten to measure the asymmetry rather than the anonymous
surface alone. It now records `indexed_auth`, `anon_withheld`, and the newest-Actor anonymous
control alongside the original columns, and it migrates the existing series rather than starting
a new one. `listed` keeps its old meaning — anonymous visibility, which is what a stranger and a
crawler actually see — so readings stay comparable across the correction.

First reading under the corrected script:

```
anon listed=no | authenticated indexed=yes | search 0/12 | category 0/9 | page HTTP 200
controls 6/6 found | newest served anonymously 7/7
```
