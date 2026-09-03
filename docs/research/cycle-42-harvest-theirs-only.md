# Cycle 42 — Taking the other half of the diff: their 2,035 boards, probed our way

**Date:** 2026-09-03
**Inputs:** `data/ats-scrapers-theirs-only.csv` (new), `data/coverage-theirs-only.json`,
`data/summary-theirs-only.json`
**Reproduce:** `node scripts/diff-ats-scrapers.mjs` then
`CONCURRENCY=8 TOKENS_FILE=data/tokens-theirs-only.json OUT_FILE=data/coverage-theirs-only.json
SUMMARY_FILE=data/summary-theirs-only.json node scripts/verify-coverage.mjs`

## Why

Cycle 41 measured the diff against `kalil0321/ats-scrapers` and published the half that
flatters us — 5,929 boards of ours absent from their snapshot. The same diff said they hold
**2,035 boards we do not**, mostly Lever (458) and Ashby (315). That number was left on the
page unacted on for a cycle. Harvesting it costs one query and is the cheapest coverage gain
available to this project.

## The rule that governed the work

**Their snapshot supplied a candidate list and nothing else.** No status, count, posting
figure or company name of theirs entered our index. Each of the 2,035 tokens was probed
against the same vendor public API, with the same retry and back-off policy, and admitted only
on the same terms as every other row in the roster: HTTP 200 and ≥1 open posting.

This is not fussiness. Provenance is the one claim that survived Cycle 41 — API-only,
robots-checked, refusals published by name. Copying rows in to buy a bigger number would have
traded the asset for the metric.

## Result

| Provider | candidates | live | empty | dead | blocked | postings | hit rate |
|---|---:|---:|---:|---:|---:|---:|---:|
| Greenhouse | 477 | 465 | 8 | 4 | 0 | 7,071 | 97.5% |
| Lever | 458 | 304 | 2 | **152** | 0 | 15,850 | 66.4% |
| Ashby | 315 | 260 | 6 | 49 | 0 | 2,888 | 82.5% |
| Teamtailor | 347 | 341 | 4 | 2 | 0 | 6,034 | 98.3% |
| Breezy | 239 | 236 | 3 | 0 | 0 | 5,586 | 98.7% |
| Recruitee | 199 | 197 | 1 | 1 | 0 | 3,040 | 99.0% |
| **Total** | **2,035** | **1,803** | **24** | **208** | **0** | **40,469** | **88.6%** |

**0 blocked on every provider**, so this is a measurement and not a partial one. The
`GATE: FAIL` line the script prints at the end is the old Cycle-2 whole-corpus gate applied to
a 2,035-token subset; it is meaningless here and is not a result.

### Roster effect

| | before | after | Δ |
|---|---:|---:|---:|
| Live boards | 16,361 | **18,164** | +1,803 (+11.0%) |
| Open postings | 399,398 | **439,867** | +40,469 (+10.1%) |
| Lever unprobed tail | 134 | **80** | −54 |

## The honesty check, run before claiming the number

A "new board" that we had already probed and recorded as empty or dead is a recheck, not a
discovery, and counting it as coverage growth would be the same class of error as Cycle 40's.
So the 1,803 were split against everything we have ever measured:

| | boards |
|---|---:|
| Never in our Common Crawl harvest at all | **1,748** |
| Harvested but never probed (the Lever 1 req/s tail) | 54 |
| Probed before and not live then | **1** |

40,468 of the 40,469 postings sit on genuinely new boards. The gain is real, not recycled.

## What the probe found that the diff could not

**152 of their 458 Lever boards — 33.2% — answer 404 today.** Greenhouse, by contrast, came
back 97.5% live. A published snapshot ages, and it ages unevenly across providers. This is the
argument for a probed roster stated as a measurement instead of a slogan, and it applies to
ours identically: our own numbers decay the moment they are written, which is why every row
ships with the API URL that produced it.

The high hit rates elsewhere (98–99% on Breezy, Recruitee, Teamtailor) also say something about
their pipeline: their list is largely boards that had postings when they last swept, so it is
pre-filtered in a way a Common Crawl URL harvest is not. That is why our harvest hit rate is
33–72% and this one is 88.6% — the two numbers are not comparable and should never be quoted
side by side.

## Published

- **Coverage page** (`docs/coverage.html`) — new section *Measured against the largest free
  dataset, in both directions*, crediting `kalil0321/ats-scrapers` by name and link, stating
  both directions of the diff, the caveat that their count is a lower bound, and the Lever 404
  finding. Every number in it is read from the data files at build time, never typed.
- **`docs/data/all.csv`** — 18,164 rows.
- `data/ats-scrapers-theirs-only.csv` — the 2,035 candidates, so the harvest is auditable.

## Attribution and licence

Their repository is **MIT**. We used their published manifest as a pointer list of factual
board identifiers and re-derived every fact ourselves from the vendor APIs. They are credited
by name and link on the coverage page, and we opened `ats-scrapers#280` giving them our
5,929-board list and the diff script before taking anything from theirs. The exchange is
symmetric and stated publicly in both places.

## What this did not do

**It sold nothing.** 1 external run, $0, listing still withheld from anonymous callers. An
11% roster gain does not move a tripwire that reads 1/10 users, 0/3 repeat runs, 0/1 paid, and
should not be reported as if it did.
