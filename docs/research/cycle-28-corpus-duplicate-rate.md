# Cycle 28 — the corpus-wide duplicate rate

**2026-09-03.** `scripts/duplication-corpus.mjs`, `data/duplication-corpus.json`,
`docs/data/duplication-corpus.csv`. $0.00 on Apify — local node against the vendors' public APIs.

## The gap this closes

Cycle 27 shipped the `dedupe` option: within one board, collapse postings that share a title and
a stated location, keep the first, record `duplicates_merged` on it. The only rate we could put
next to it was **8.87%**, measured over the 40 boards with the highest title-repeat in the census
cache. Those boards were selected *because* they repeat titles. Quoting that as a corpus rate
would have been the most flattering misreading available, so the README and the input schema both
said, in as many words, that it was not one, and that we did not have a corpus number.

Now we do.

## The answer

**3.03% of open postings in the corpus are same-title-same-stated-location duplicates within
their own board.** 95% CI **[2.86%, 3.22%]**. That is roughly **8,822 duplicate postings out of
291,507**.

The worst-offender stratum figure, 8.87%, overstates the corpus by **2.9×**. It was right to
refuse to quote it.

## What was actually read

1,318 boards targeted, **1,317 read**, one failed on a transport error. **166,320 live postings**
— **57.1% of the corpus's 291,507 postings passed through the rule directly** rather than being
inferred from anything.

| Postings/board | Boards | Postings | Weight | Treatment | Read | Live postings | Duplicates | Rate |
|---|---:|---:|---:|---|---:|---:|---:|---:|
| 500+ | 47 | 62,234 | 21.35% | **census** | 47/47 | 62,194 | 4,726 | **7.60%** |
| 100–499 | 451 | 85,449 | 29.31% | **census** | 451/451 | 85,366 | 2,448 | **2.87%** |
| 30–99 | 1,385 | 72,161 | 24.75% | sample | 259/260 | 13,473 | 221 | **1.64%** |
| 10–29 | 2,971 | 49,407 | 16.95% | sample | 240/240 | 4,008 | 36 | **0.90%** |
| 3–9 | 3,572 | 19,652 | 6.74% | sample | 200/200 | 1,102 | 0 | **0.00%** |
| 1–2 | 1,771 | 2,604 | 0.89% | sample | 120/120 | 177 | 1 | **0.56%** |
| **corpus** | **10,197** | **291,507** | 100% | | **1,317** | **166,320** | | **3.03%** |

**The two largest strata were censused, not sampled.** They are only 498 boards but carry 50.6%
of all postings, so reading them in full was cheaper than arguing about them. Across those 498
boards the rate is **7,174 of 147,560 = 4.86%**, and that half of the answer carries **no
sampling error at all** — every board in it was read. All 498 answered; there is no non-response
to explain away either.

## Method

Three choices, each made against an available shortcut that would have been wrong.

**Boards are drawn by size, never by how much they repeat themselves.** This is the entire
difference from `duplication.mjs`, whose 40 targets are ranked by title-repeat. Here a board that
repeats nothing is exactly as likely to be read as a board that repeats everything.

**Census the head, sample the tail.** Strata cut on posting count — the only board attribute the
roster carries, and the only one that predicts duplication a priori: a two-posting board can
contribute at most one duplicate. The tail strata are sampled by a deterministic every-kth walk
over a stable sort, the same choice `role-census.mjs` made and for the same reason: **the run has
to be reproducible from the public roster by someone who is not us.** `Math.random` would make
the number unauditable. The bootstrap is seeded for the same reason — a published confidence
interval that changes on every run is a strange object.

**The rule is imported, not restated.** `duplication-corpus.mjs` imports `analyseBoard` from
`scripts/duplication.mjs`, which is the rule the Actor ships as `dedupe`. A second copy would
have drifted from the option this number exists to describe, and nothing would have caught it.

The interval is a board-level bootstrap over the **sampled strata only** — resampling a censused
stratum would invent uncertainty that does not exist. It treats the systematic sample as if it
were simple random within stratum; because the sort variable (board size) correlates with the
outcome, that assumption makes the interval **wider** than the truth, not narrower.

## What the shape of it means for a buyer

**Duplication is a big-board phenomenon, and it falls off a cliff.** 7.60% → 2.87% → 1.64% →
0.90% → 0.00%. The 3,572 boards with 3–9 postings produced **zero** duplicates across 1,102
postings read. If you are pulling small and mid-size boards, `dedupe` will find almost nothing
for you, and the honest advice is to leave it off.

**And it is concentrated.** Of the 1,317 boards read, only **452 (34.3%)** carry a single
duplicate. Of every duplicate found, the **top 1 board is 15.2%**, the **top 10 are 47.0%**, and
the **top 25 are 63.1%**. So 3.03% is a corpus mean that describes almost nobody exactly: two
buyers out of three see zero, and a buyer who happens to pull `lever/boxlunch` (30.82%) or
`greenhouse/herewithgmbh` (**59.34%** — 359 duplicates in 605 postings) sees an order of
magnitude more than the mean. The concentration is published alongside the rate for that reason;
quoting the mean alone would be a worse answer than quoting nothing.

Worst boards found, all read live:

| Board | Postings | Duplicates | Rate |
|---|---:|---:|---:|
| `greenhouse/herewithgmbh` | 605 | 359 | 59.34% |
| `lever/boxlunch` | 3,653 | 1,126 | 30.82% |
| `greenhouse/housebuyersofamerica` | 636 | 183 | 28.77% |
| `greenhouse/luminishealth` | 423 | 101 | 23.88% |
| `ashby/bjakcareer` | 3,084 | 730 | 23.67% |
| `greenhouse/jdsportsfr` | 693 | 123 | 17.75% |
| `greenhouse/liquidpersonnel` | 1,586 | 276 | 17.40% |
| `greenhouse/blueskytelepsych` | 945 | 161 | 17.04% |

Note `greenhouse/svetness`, the single largest board in the corpus at 4,981 postings: **3.01%**.
Size raises the ceiling on duplication; it does not cause it.

## Direction of the error

**3.03% is a lower bound.** `normLoc` strips the noise words that vary between copies ("remote",
"hybrid", "usa") but it resolves nothing: "Leeds" and "Leeds, UK" are two keys, as are "NYC" and
"New York". Every such pair is a duplicate the rule declines to merge. This was found by getting
a test wrong on the first attempt and is now pinned by
`test/duplication-corpus.test.js` — *"the corpus rate is a LOWER bound"*. The error has a known
direction, which is worth more than a smaller error of unknown sign, and it is the conservative
direction: the option under-removes rather than over-removes, which is the same asymmetry that
made `dedupe` opt-in in the first place.

Two smaller caveats, stated rather than buried:

- **Stratum weights come from the roster harvest, and boards move between strata.** The check is
  live-vs-roster postings inside the censused strata, where both numbers exist: 62,194 vs 62,234
  and 85,366 vs 85,449 — **0.06% and 0.10% apart**. The roster is fresh enough that the weights
  are not doing damage.
- **One board of 1,318 failed.** It sits in the 30–99 stratum, whose 259 responding boards give
  0.221 duplicates per board; the missing board would move the corpus rate by less than 0.001pp.

## What this does not tell us

It does not say what a *given* buyer's duplicate rate will be — the concentration numbers above
are the reason, and no corpus mean can answer that. `RUN_STATS.duplicates_merged` already reports
the count for the boards actually pulled whether `dedupe` is on or off, which is the only honest
way to answer it: measure the run, not the corpus.

It also does not touch the *cross-board* duplicate, where two boards carry the same opening. The
rule is deliberately per-board, because two boards posting the same title in the same city are
usually two employers, and merging them would destroy real rows. Unmeasured, and not on the
roadmap until someone asks.

## Files

- `scripts/duplication-corpus.mjs` — the measurement; `--plan` prints the design and fetches nothing.
- `test/duplication-corpus.test.js` — 15 tests. Full suite 113/113.
- `data/duplication-corpus.json` — full output, per stratum and per board.
- `docs/data/duplication-corpus.csv` — the table above, MIT, no signup.
