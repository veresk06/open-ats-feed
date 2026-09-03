# Apify Store visibility: we are not ranked low, we are absent

Measured 2026-09-03, ~02:20–02:35 UTC. Actor `sharp_malachite/open-ats-jobs-feed`
(`bMtkiY7lzUpCjEn1V`), public since 2026-09-02T22:13Z, build 0.1.15.

## The prior belief

`scripts/build-site.mjs` carries this note at the top, written in an earlier cycle:

> Apify Store search is popularity-ranked, and a 2-user Actor is not in the top 100 for any
> query a buyer would type (measured 2026-09-03, ten queries).

That framed the problem as ranking, which implies the remedy is popularity or keywords.

## What is actually true

Ranking is not the mechanism. The Actor is **excluded from store search results entirely.**

```
$ curl -s "https://api.apify.com/v2/store?limit=10&search=open-ats-jobs-feed" \
    | jq '{total:.data.total, count:(.data.items|length)}'
{ "total": 1, "count": 0 }
```

The index counts a match and returns no item. The same query shape for a peer behaves normally:

```
$ curl -s "https://api.apify.com/v2/store?limit=10&search=ats-job-feed-actor" \
    | jq '{total:.data.total, count:(.data.items|length)}'
{ "total": 1, "count": 1 }        # dstyx/ats-job-feed-actor, 2 users
```

Searching our own username returns the same signature: `total: 1`, `items: []`.

This is not a popularity floor. Across the queries below, actors with 1–3 total users are
returned freely — `zmei-automations/company-jobs-scraper` (2 users) ranks #6 for `lever` and
`ashby` and #10 for `greenhouse`; `bikram07/multi-ats-jobs-feed` (1 user) and
`seibs.co/hiring-signal-intel` (1 user) both appear. Ours never does, at any rank, for any query.

| Query | Top-25 contains our Actor | Leader in results |
|---|---|---|
| `greenhouse` | no | `fantastic-jobs/greenhouse-jobs-api` (779) |
| `ats` | no | `jobo.world/ats-jobs-api` (641) |
| `lever` | no | `bovi/greenhouse-lever-ashby-job-scraper` (354) |
| `ashby` | no | `fantastic-jobs/ashby-jobs-api` (392) |
| `job board` | no | `openclawai/job-board-scraper` (2,526) |
| `open ats jobs feed` (our literal title) | no | — |

## Causes ruled out

| Hypothesis | Evidence against |
|---|---|
| Not actually public | `isPublic: true`; unauthenticated `GET /v2/acts/sharp_malachite~open-ats-jobs-feed` returns `200`; the store page renders at `apify.com/sharp_malachite/open-ats-jobs-feed` with our `seoTitle` |
| Deprecated or under a notice | `isDeprecated: false`, `notice: "NONE"` |
| Missing category | `categories: ["JOBS"]` is set |
| Missing icon | `pictureUrl` is `null` — but `bikram07/multi-ats-jobs-feed` also has none and **is** returned |
| Too few users to be indexed | 1-user actors are returned; see above |

## What is left

Index propagation lag. The Actor was created at 2026-09-02T22:13Z and measured about four
hours later. `total` and `items` are plausibly served by two different stores, the counter
updating on write and the document set on a slower rebuild.

**This is falsifiable and costs nothing.** Re-run the first command. If it still reports
`total: 1, count: 0` more than 24 hours after publication, it is not lag, and it is a platform
problem to raise with Apify support rather than a marketing problem to write copy against.

## Why it matters beyond this Actor

The `JOBS` category holds 5,436 actors and the direct ATS competitors number 30+, with the
leader at 641 users. Even fully indexed, this is a commodity aisle we do not win on keywords.
The finding's real value is negative: it removes "improve the store listing" from the list of
things worth a cycle, because a listing that is not in the index cannot be improved into
visibility. Distribution effort belongs on surfaces we control — the directory, the coverage
measurement, and the dated digest series.
