# Cycle 26 — A gazetteer with no curator

**Date:** 2026-09-03 · **Cost:** $0.00 on Apify (local node against the vendors' public APIs)
**Code:** `scripts/duplication.mjs` — `buildGazetteer`, `gazetteerHit`, two-pass `--verify-fanout`
**Tests:** `test/duplication.test.js` — 6 new, 76/76 pass
**Artifact:** `data/fanout-verified.json`

## The hole this fills

Cycle 24 flagged 38,077 of 121,050 postings (31.46%) as "the location is written into the title",
by a purely structural rule: split a title on its last separator, and if the stem repeats across
the board with ≥5 distinct tails, call it fan-out. The rule cannot tell a city from a
specialisation, so 31.46% was published as an upper bound and nothing more.

Cycle 25 turned that bound into a measurement by asking each posting's own `location` field
whether the tail names the place the posting states. The answer was 9.41% — 3.3× smaller — and
the dominant false positive turned out to be the least exotic thing imaginable: `Role, Team` on
a tech board.

Then the new method was checked against the old method's flagship example, and it failed.

`geniussportssn` is the clearest geographic fan-out in the corpus: 477 postings, 477 distinct
titles, one job, a different city in each title. The field method refutes **all 477** — because
that board writes `"Statistician Network"` in its `location` column. The title carries the place;
the field carries a department label.

**A field is only evidence when the field means what its name says.** That is a failure mode the
field method cannot see from the inside, and it was not one of the three failure modes enumerated
when the rule was written.

## Why not a city list

The obvious fix is a gazetteer of city names. It was rejected for the same reason it was rejected
when the fan-out rule was first written: a maintained list silently misses every place it has not
heard of, and the miss is invisible. It would fix `geniussportssn` and quietly mis-handle the
next board that hires in a town nobody curated.

## The rule

> A token is a place-name token when it appears in the `location` field of **at least 3 distinct
> boards**.

Derived from the corpus, maintained by nobody. Two properties matter:

- **No board can vouch for its own vocabulary.** `geniussportssn` writes "Statistician Network"
  477 times, but that is one board's opinion 477 times over. `statistician` and `network` appear
  in exactly one board's location column, so neither becomes a place.
- **It cannot miss a place for being obscure.** If three boards hire in a town, the town is in the
  gazetteer, whether or not any curator had heard of it.

## Its error runs the other way, and that is the point

Place names are ordinary English words. `new` is in every "New York" and "New Orleans"; `north`
is in every "North Carolina"; `union` and `enterprise` are towns. A tail reading `- New Product`
matches on `new` and is not geographic at all.

So the two methods fail in opposite directions:

| | Under-counts geography when | Over-counts geography when |
|---|---|---|
| **Location field** | the two fields spell a place differently ("München" / "Munich"), or the field holds something other than a location | — |
| **Corpus gazetteer** | — | a place name is also an ordinary word used in a product, team or grade name |

Neither is used to overrule the other. The field method is published as the **lower bound**, the
field-or-gazetteer union as the **upper bound**, and everything between them as **disputed**. The
tokens driving the disputed band are published with their counts, so the leak is measured rather
than asserted to be small.

## Implementation notes

- **Two passes, not one.** The gazetteer cannot be built until every board has been read: a token
  is only a place when three *different* boards independently write it, and no board knows what
  the others wrote. Pass 1 reads all target boards and keeps the rows; the gazetteer is built from
  every location field seen; pass 2 classifies.
- **The four field-verdict counters are never rewritten.** Passing a gazetteer to
  `verifyFanoutBoard` leaves `geographic` / `not_geographic` / `unstated` / `uninformative`
  bit-identical and adds three subset counters cutting across them, so Cycle 25's invariant —
  the buckets sum to exactly the postings the title-only rule flagged — still holds, and is still
  asserted by a test.
- `gazetteerHit` returns the *token* that matched rather than a boolean, purely so the disputed
  band can be broken down by what caused it.

## Results

226 fan-out boards read live, **99,655 postings**, 0 unreachable. The title-only rule flags
**38,096** of them (38.23% of these boards — this is the worst stratum, not the corpus).

| Location written into the title | Postings | Share of the 99,655 |
|---|---:|---:|
| **Lower bound** — the posting's own `location` field agrees | **11,377** | **11.42%** |
| **Upper bound** — field, or a corpus gazetteer token in the tail | **21,372** | **21.45%** |
| Disputed between the two | 9,995 | 10.03% |

The gazetteer is **1,868 place tokens**, drawn from the 11,855 distinct tokens seen in the
`location` column of those boards — 15.8% of the vocabulary clears the ≥3-boards bar.

**The independent check that matters:** the gazetteer recognises **91.02%** of what the location
field had already, separately, called geographic. Two rules built from different columns agree
nine times out of ten, which is the strongest evidence available that the gazetteer is not noise.

### The motivating case is fixed, and it is fixed for partly the wrong reason

`geniussportssn`: 477 postings, one stem (`sports data collector`), 475 distinct tails. The field
refutes **all 477** — the column says "Statistician Network". The gazetteer rescues **452** into
the disputed band, on `american` (64), `china` (34), `israel` (18), `turkey` (14), `norway` (13).

But `american` is not doing the work anyone would want. Every one of those 64 hits comes from
`(American Football)` in the title, not from a place; `american` is in the gazetteer because five
other boards write it in their location column. The postings **are** geographic — the same tails
also carry Albuquerque, and the board is the clearest fan-out in the corpus — so the verdict is
right and the evidence is wrong. That is the over-count failure mode landing on the very case the
gazetteer was built to rescue, and it is why the result is published as a bound and not a number.

### What the disputed band is actually made of

The ten tokens driving the largest share of it:

| Token | Postings | Boards stating it as a location |
|---|---:|---:|
| `home` | 779 | 7 |
| `2` | 413 | 3 |
| `care` | 213 | 3 |
| `new` | 177 | 147 |
| `south` | 150 | 91 |
| `san` | 147 | 131 |
| `global` | 143 | 3 |
| `a` | 136 | 6 |
| `media` | 136 | 3 |
| `s` | 131 | 43 |

Read that table honestly: **the disputed band is dominated by junk, not by genuinely ambiguous
city names.** `home` and `global` are how boards write remote. `2`, `a` and `s` are fragments of
tokenised location strings that cleared a 3-board bar set too low for one-character tokens. Only
`new`, `south` and `san` are the predicted failure — real place-name fragments that are also
ordinary words, and they are 474 postings of the 9,995.

So the upper bound is **loose, and loose in a way that is now measured**. The honest statement is
that location-in-title is at least 11.42% and at most 21.45% of postings on the worst-affected
boards, and that closing the gap is a tokenisation problem (drop tokens under 3 characters, treat
`home`/`remote`/`global` as non-places) rather than a method problem. That fix is not made here:
it would move a published number, and the number was published this cycle to be argued with.

### The count that supersedes Cycle 24

| | Postings | Share | Status |
|---|---:|---:|---|
| Title-only structural rule (Cycle 24) | 38,077 | 31.46% | **superseded** |
| Field-verified, lower bound (Cycle 25) | 11,377 | 11.42% | holds |
| Field ∪ gazetteer, upper bound (Cycle 26) | 21,372 | 21.45% | new |

Cycle 24's 31.46% is above the upper bound of a two-sided measurement. It was overstated by at
least 1.8× and at most 3.3×, and it should not be quoted again.
