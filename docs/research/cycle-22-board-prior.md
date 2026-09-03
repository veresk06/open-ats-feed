# Cycle 22 — resolving `unclassifiable_generic` with a board-level prior

**Question.** 11,319 of the 121,050 titles we read (9.35%; 11.96% once weighted to the corpus)
resolve to `unclassifiable_generic` — bare nouns that name a level and no work. `manager` 4,209,
`lead` 2,504, `associate` 1,922. The title cannot resolve them. Can the *board* they sit on?

**Answer: partly, and the useful output is the tradeoff curve rather than a single number.** At a
defensible error rate the board prior resolves **16.2% of them (1,831 titles)**. Pushing coverage
to 97% drops accuracy to 63%, which mislabels more than a third of the rows it touches.

Everything below is computed from `data/role-census-titles.json`, the cached run-2 corpus.
No network, **$0.00**. Reproduce with `node scripts/board-prior.mjs`.

## Method

For each board, count the families of its titles that resolved to a real role family; the most
common one is the board's prior. Assign a board's generic titles to it when the board has enough
resolved titles (`support`) and the top family is dominant enough (`confidence`).

Five labels are excluded from ever being predicted. `other` and `unclassifiable_generic` resolve
nothing; `non_english` is a language, not a role, and would make a French board predict "French";
and `suspect_recruitment_ad` / `volunteer_unpaid` are data-quality findings whose filters are
keyword-driven and separately audited — inference has no business widening them.

**Scoring.** Leave-one-out over the resolved titles: hide one title's family, predict it from the
rest of its board, compare. Baseline for comparison is the only honest one — always guess the
corpus mode, which is `engineering` at **21.9%**.

## The curve

`support >= 5` throughout; the support axis turned out to change nothing (all six values from 1
to 50 agree within 0.5 points at every confidence level), so confidence does all the work.

| min confidence | coverage of resolved titles | accuracy | accuracy on weak titles | generic titles resolved |
|---:|---:|---:|---:|---:|
| 0.00 | 99.0% | 63.2% | 63.6% | 10,966 (96.9%) |
| 0.30 | 97.4% | 63.7% | 64.1% | 10,734 (94.8%) |
| 0.40 | 84.2% | 68.4% | 68.8% | 8,702 (76.9%) |
| 0.50 | 66.1% | 74.6% | 76.1% | 5,653 (49.9%) |
| 0.60 | 41.6% | 86.6% | 86.6% | 2,533 (22.4%) |
| **0.70** | **33.6%** | **91.6%** | **91.2%** | **1,831 (16.2%)** |
| 0.80 | 29.1% | 94.8% | 94.1% | 1,218 (10.8%) |

*Weak titles* are those a single-word key decided — `engineer`, `manager`, `technician`. They are
the weakly-identified titles in the resolved set, so they are the closest available proxy for the
generic ones we actually want to predict.

**Operating point: confidence ≥ 0.70.** The rule was originally "beat the baseline by 20 points,
then maximise coverage", which selected confidence ≥ 0 — 63% accurate, covering everything. That
clears the baseline three times over and is still wrong: on a published artifact a confident wrong
label is worse than a blank one. The rule is accuracy-first instead. The full sweep ships in
`data/board-prior.json` so anyone can take a different point.

## What the accuracy number does and does not mean

**91.2% is agreement with the keyword classifier, not 91.2% correct.** Leave-one-out compares the
prior against the classifier's own label, which is not ground truth. Where the classifier is
systematically wrong about a board, the prior agrees with it confidently and scores full marks.

The worked example, found by spot-check rather than by reasoning: `lever/jetsetpilates` is a
Pilates studio. 168 of its 379 postings are titled `Instructor - <city>`, which the classifier
reads as `education` — correctly, from the title alone, since a bare "Instructor" is a teacher. So
the board gets an `education` prior at 0.70 confidence and its 134 generic titles are assigned to
education. All 134 are wrong, and leave-one-out cannot see it, because the truth labels are wrong
the same way. The word "pilates" appears only in the board token, never in a title.

That is the ceiling on this method: it propagates whatever the resolved titles say, so it inherits
and then amplifies the base classifier's blind spots.

## Two bugs the prior found

**1. Fitness instructors were being counted as education — 194 titles, 11.5% of that family.**
`instructor` is an `education` key, `education` was ordered before `fitness_wellness`, so every
"Group Fitness Instructor" in the corpus resolved to education. All 194 fired on that one key.
Fixed with a narrow pre-pass entry (`fitness instructor`, `group fitness`, `yoga instructor`,
`pilates`, `barre `, `zumba`, `spin instructor`) placed to win the ordering, same family label so
the counts merge. `swim instructor` was deliberately left out — a school swim teacher is a real
education job and the phrase does not distinguish the two.

Measured effect on the census, and it is exactly the intended one: `fitness_wellness` +195,
`education` −194, `sales_marketing` −1, **nothing else moved**. `engineering` stays at 21.17%, so
the developer-facing headline is untouched.

**2. The prior would have laundered a junk board into a real family.**
`lever/globalelitecareers` is 78.8% recruitment ads. Its 97 generic titles are 97 copies of
"Benefits Services Representative - Remote" — the same commission-only pitch, worded so it dodges
the ad filter's phrase list. Its remaining real-looking titles gave it a `corporate` prior at 0.78
confidence, so inference would have stamped a legitimate job family on exactly what the quality
filter exists to catch.

Guard added: **a board whose not-a-job share is ≥ 10% gets no prior at all**, and is excluded from
the accuracy scoring too, so the published number describes the board set the prior is actually
used on. Four boards are refused: `globalelitecareers` (78.8%), `cfoinsights` (30.0%),
`unitedmedia` (27.8%), `hrtechx` (10.1%).

## Where the 1,831 resolved titles go

| Family | Assigned |
|---|---:|
| retail_food | 427 |
| healthcare | 407 |
| sales_marketing | 320 |
| corporate | 318 |
| education | 188 |
| engineering | 99 |
| skilled_trades | 43 |
| engineering_nonsoftware | 21 |
| product_design | 8 |

`engineering` gains 99 titles. **The board prior does not move the positioning number**, and that
is worth stating plainly: the corpus is 21.2% developer-facing before this work and after it.

The shape of the residue is the real result. The boards confident enough to trust are
single-purpose boards — a hospital, a school district, a restaurant group — and those had few
generic titles to begin with. The 9,488 titles left unresolved sit on *mixed* boards, which is
precisely where a board prior has least to say. The free-work item assumed this was "trivial from
the board's own posting mix"; for 84% of the cases, it is not.

## Published artifact

`docs/data/board-roles.csv` — 500 boards, MIT, linked from the index. Columns: `provider`,
`token`, `titles_read`, `resolved_titles`, `inferred_family`, `confidence`, `generic_titles`,
`generic_assigned`, `not_job_share`, `stratum`. **`inferred_family` is blank where the evidence is
too thin to say**, which is 399 of the 500 boards. Nobody else in this category publishes what a
board is *for*, and ranking boards by size is a different question from knowing what they hire.

## Next step, deliberately not taken here

The board token is public metadata we already ship, and it is exactly what a human reads to know
that `jetsetpilates` is a gym. Using it would fix the one failure mode this method cannot see. It
is not attempted in this cycle because a token-based classifier needs its own false-positive audit
before it is trusted — `sharp` in a token does not make a board a knife shop — and the standing
rule is that a default-on inference gets audited on its false positives before it ships.
