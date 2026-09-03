# Cycle 20 — classifier run 2, and the first filter that ships from a measurement

**Date:** 2026-09-03 · **Network cost:** $0.00 (reclassified from cache) · **Apify cost:** $0.0029
(one verification run) · **Supersedes the family table in** `cycle-19-role-census.md`.

Run 1 measured the corpus and shipped a classifier it already knew was a third short — 36.05%
of titles landed in `other` — because fetching 121,050 titles had eaten five minutes of a
thirty-minute cycle. Every title was cached for exactly this reason. Run 2 reclassified the same
corpus with no network calls, in under two seconds.

## What changed in the numbers

| Family | Run 1 | Run 2 | |
|---|---:|---:|---|
| **engineering** | 14.33% | **21.17%** | run 1 missed software work that never says "software" |
| other (unclassified) | 31.34% | **10.61%** | |
| unclassifiable_generic | — | 11.96% | new: titles naming a level and nothing else |
| corporate | 15.16% | 14.52% | |
| sales & marketing | 12.53% | 11.82% | |
| healthcare | 7.98% | 8.03% | |
| engineering_nonsoftware | — | 3.47% | new: electrical, mechanical, field, civil |
| product & design | 3.08% | 2.96% | |
| **suspect_recruitment_ad** | 0.48% | **0.50%** (1,411) | |
| **volunteer_unpaid** | — | **0.16%** (445) | new, and it is the second data-quality finding |

Everything is still a **floor**, not an estimate: an unclassified title is only ever missing
from a family, never added to one.

### The engineering number moved, and it moved for a reason worth stating

14.33% → 21.17% is a 48% relative jump in the one number we would quote publicly, so it was
audited rather than accepted. `scripts/audit-classifier.mjs` reports which keyword fired on
which titles. Of 20,004 raw engineering titles, the new bare `engineer` catch accounts for 3,230
and bare `developer` for 487 — and the examples are real software roles that simply drop the
adjective (`Staff Database Engineer`, `Research Engineer, Post-Training`). The rest came from
named stacks (`laravel` 102, `react` 151, `python` 133) and lead titles (`technical lead`,
`engineering lead`, `lead engineer`, 383 together).

Pushing the other way, `engineering_nonsoftware` was split out deliberately so that electrical,
mechanical, field and project engineers — 3.47% — cannot inflate a number used as a proxy for
"developer-facing". The honest reading: **the corpus is about a fifth developer-facing, not a
seventh.** That materially narrows, but does not close, the positioning gap from Cycle 19.

### A correction to Cycle 19's method line

Cycle 19 reported "500 boards, zero fetch failures". Zero failures is true. But 600 boards were
*requested* (300 head + 300 tail) and only **500 were read** — the run hit its wall-clock budget
partway through the Lever tail, which is fetched at 1 req/s to honour `api.lever.co/robots.txt`.
Boards never probed are not boards that failed, and reporting them as a clean census overstated
the coverage. `method.head_boards_read` / `method.tail_boards_read` now record both numbers.
The tail weighting divides by postings actually sampled, so the shares are unaffected.

## Two artifacts, not a filed report

**1. `docs/data/engineering.csv`** — the 500 measured boards, ranked by engineering postings,
with each board's engineering share and stratum. MIT, beside the existing free roster CSVs.
Ranking by size and ranking by engineering produce different lists, which is the point:

| By open postings | | By engineering postings | |
|---|---:|---|---:|
| `lever/svetness` (tutoring staffing) | 4,981 | `ashby/bjakcareer` | 1,356 of 3,084 |
| | | `greenhouse/speechify` | **1,206 of 1,317 (91.6%)** |
| | | `greenhouse/andurilindustries` | 1,007 of 2,208 |
| | | `lever/bluelightconsulting` | **511 of 513 (99.6%)** |

Scope is stated in the file rather than implied — these are the boards whose titles were
actually read, not all 10,197.

**2. `excludeRecruitmentAds`, shipped in Actor build 0.1.16, on by default.** The corpus carries
open-ended commission-only / MLM recruitment copy on genuine Greenhouse, Ashby and Lever boards.
Verbatim, from the cache: *"Tired of Your Income Being Capped? Work from Home Opportunity"*
(134), *"Work From Home - Benefits Services Representative"* (72), *"Work From Home - Break Free
of the 9-5"* (65). A buyer paying per delivered row should not pay for these.

**Verified live, not just built** — the standing rule since 0.1.6 shipped broken on a green
build. One board, `lever/globalelitecareers`, is 79% recruitment ads:

```
postings_seen 1752 · recruitment_ads_excluded 1380 · postings_pushed 372 · $0.0029
```

`RUN_STATS.recruitment_ads_excluded` reports the count whether the filter is on or off. A filter
that will not say what it removed is worse than no filter.

**The false positives were audited before it was defaulted on**, which is what changed the list.
`remote opportunity` fired 2 times in 121,050 titles and `no experience necessary` 0 — against a
real cost, because *"Registered Nurse - Remote Opportunity"* is a job, not a pitch. Both were
dropped from the phrase list. What remains is dominated by `work from home` (1,072), which the
audit shows resolves to a handful of distinct MLM titles duplicated across boards.

## Why this is the only differentiator found in two cycles that a competitor cannot copy cheaply

Not because the code is hard — it is forty lines. Because copying it requires first admitting
the problem exists in your own product. An incumbent shipping 1.8M jobs/month who publishes
"0.5% of what we deliver is not a job, here is the flag" is publishing a defect report. We can
publish it as a feature precisely because we are the ones who counted.

## What is still unmeasured

- **`unclassifiable_generic` (11.96%) is honest, not solved.** `Associate`, `Coordinator II`,
  `Specialist` carry no industry word. Resolving them needs the board's own industry, which we
  have and have not used — a board-level prior would classify these at zero fetch cost.
- **The non-English pass is still partial.** French, plus what run 2 added for Portuguese,
  Spanish, Italian, German and Dutch. 1.14% is a floor and the true share is higher.
- **`volunteer_unpaid` (445) is named and not yet filtered.** It belongs behind the same kind of
  flag as the ads, and it did not ship this cycle.
