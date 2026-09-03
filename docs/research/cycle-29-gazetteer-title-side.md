# Cycle 29 — The other half of the same trick

Cycle 26 built a gazetteer with no curator: a token is a place-name token when at least three
*distinct* boards write it in their `location` field. It fixed the failure the field method could
not see, and it produced a two-sided answer to "how often is the location written into the title":
**11.42% to 21.45%** of postings on the worst-affected boards.

A band whose top is 1.9× its bottom is not an answer. This cycle narrows it, and the interesting
part is what got rejected on the way.

## What was prescribed, and why it was not done

Cycle 28's Next Action said: *"drop tokens under 3 characters, treat `home`/`remote`/`global` as
non-places. Removes ~1,600 of the 9,995 disputed."*

That was refused on two counts.

**It is a hand-maintained list.** The gazetteer exists because a curated city dictionary "would be
a permanent maintenance burden and would silently miss every place it had not heard of" — the
objection is written into the source three times. Three hand-entered stop-words are the same
object at a smaller scale, and the fourth would have to be argued about next cycle.

**`< 3 characters` is not evidence.** `uk` is two characters and is stated as a location by 31
distinct boards. Dropping it for its length discards a real place for a reason unrelated to
whether it is one. So does `ny`, `sf`, `la`.

## The rule that replaced it

The gazetteer already counts one thing: **L**, the number of distinct boards that write the token
in their `location` field. The tightening adds the counter-question the corpus can also answer:
**T**, the number of distinct boards that use the token in a **title tail**.

**Keep the token only when `L >= T`.**

That is the whole rule. It is derived from the corpus, symmetric to the test already there, and
nothing is maintained by hand. The bar is a coin flip on purpose: any other threshold — 0.6, 2×,
a log-odds cut — would have to be defended, and there is no ground truth here to defend it with.

Why it works is visible in the data before any threshold is chosen. The tokens wrecking the upper
bound are not near-misses; they are words boards overwhelmingly put in titles:

| rejected | L | T | | kept | L | T |
|---|---:|---:|---|---|---:|---:|
| `home` | 7 | 21 | | `new` | 147 | 91 |
| `2` | 3 | 22 | | `san` | 131 | 46 |
| `care` | 3 | 24 | | `south` | 91 | 60 |
| `global` | 3 | 75 | | `north` | 74 | 66 |
| `media` | 3 | 38 | | `mexico` | 69 | 31 |
| `market` | 4 | 64 | | `germany` | 67 | 25 |
| `corporate` | 3 | 63 | | `canada` | 66 | 34 |
| `spanish` | 3 | 44 | | `france` | 56 | 33 |

`home` — "Work from home" in seven boards' location columns — alone drove 779 disputed postings.

## Its error direction, which is not the old one

This matters more than the headline and is stated everywhere the number is published.

The Cycle 26 gazetteer **over-counted** geography: place names are ordinary words, so "New
Ventures" matched on `new`. Over-counting is what makes a number an upper bound, and it was safe
to call it one.

The tightened rule can **under-count**. A real place whose name boards write into titles more
often than into location fields gets dropped. Measured, there are exactly three of any size —
**`uk` (L=31, T=46, 89 postings), `west` (54, 72, 56) and `east` (27, 59, 38)**, 183 postings
between them. The full accounting is under [Results](#what-the-tightening-cost-measured).

So the tightened figure is **a tighter estimate that can undershoot, not a guaranteed bound.**
Both numbers are therefore computed from the same fetch and published side by side —
`geographic_upper_loose` is the old guaranteed bound, unchanged — and every rejected token is
published with both of its counts in `top_rejected_tokens`. If this rule fails, it fails visibly
in that list, and a reader can check the calls instead of taking them.

## The long tail is not at risk

The obvious worry is that the tightening quietly thins out small places. It cannot, and the reason
is structural: **T counts boards, not postings.** A board fanning out one role over 470 towns is
one board, so each of those towns has T=1 while needing only L>=3 to be in the gazetteer at all.
Rare places have T≈0 and are untouched. The rule can only bite tokens that many *different* boards
independently put in titles — which is the definition of an ordinary word.

This is pinned by a test rather than asserted (`a token no board writes in a title tail is
unaffected by the new rule`).

## Method notes

- **Previewed offline before spending a live run.** `data/role-census-titles.json` already carries
  every target board's titles, so T and the whole rule could be checked against the real 226-board
  set for zero requests. Only the confirmation run touched the network.
- **Both gazetteers are built from one fetch**, and every board is classified twice. The
  narrowing is therefore a difference between two measured numbers, not a claim about one.
- **`buildGazetteer` with no titles passed is byte-for-byte the old rule**, so every previously
  published figure stays reproducible. Pinned by a test.
- 5 new tests, 77/77 passing.

## Results

Fresh live read, 2026-09-03: **225 of 226 fan-out boards reachable, 99,147 postings.** Both
gazetteers built from that one fetch, every board classified twice.

| | Postings | % of live |
|---|---:|---:|
| **Lower bound** — the posting's own `location` field agrees | **11,357** | **11.45%** |
| Upper bound — Cycle 26 rule, location field only | 21,332 | 21.52% |
| **Upper bound — with the title side** | **17,326** | **17.48%** |
| Disputed between the bounds | 5,969 | *was 9,975* |

**The band narrows by 4.04 points and the disputed population falls 40%.** Of 1,867 tokens the
location field alone would admit, the title side rejects **151**.

### The residue changed character, which is the real result

Before, the disputed band was driven by words that are not places at all. After, it is driven by
places:

| was disputed (Cycle 26 top) | now rejected as title words |
|---|---|
| `home` 779, `2` 413, `care` 213, `global` 143, `media` 136 | all of them |

| still disputed (Cycle 29 top) | L | T | postings |
|---|---:|---:|---:|
| `new` | 146 | 91 | 178 |
| `south` | 90 | 60 | 158 |
| `san` | 131 | 46 | 154 |
| `canada` | 66 | 34 | 125 |
| `mexico` | 68 | 31 | 105 |
| `japan` | 57 | 54 | 75 |
| `north` | 73 | 66 | 68 |
| `germany` | 67 | 25 | 67 |
| `france` | 56 | 33 | 62 |
| `spain` | 49 | 20 | 59 |

Every one of the top ten remaining is a real place. What is left in the band is genuine ambiguity
— "New Ventures" really does contain a place token — rather than measurement junk. That is the
floor of what this method can do, and it is a different kind of number from the one it replaced.

### What the tightening cost, measured

4,006 postings were removed from the upper bound. Of those, the ones attributable to tokens that
are plausibly real places are:

| token | L | T | postings removed |
|---|---:|---:|---:|
| `uk` | 31 | 46 | 89 |
| `west` | 54 | 72 | 56 |
| `east` | 27 | 59 | 38 |
| **total** | | | **183** |

The other high-L rejects are `s` (43 vs 56), `c` (36 vs 40) and `m` (15 vs 46) — fragments, not
places, and correctly dropped.

**So the tightened figure can undershoot by at most about 183 postings, 0.18% of live.** 3,823 of
the 4,006 removed were junk. That ceiling is stated rather than estimated because every rejected
token is published with both counts.

### The cost in the sensitivity check

Gazetteer recall on postings the location field *already* called geographic falls from **91.02% to
86.04%**. Fewer tokens necessarily recognise less. 86% is still comfortably high enough for the
gazetteer to be evidence, and this is the honest price of the narrowing.

### One caution on comparing to Cycle 26's published numbers

This is a fresh fetch; boards change between reads. The lower bound moved 11,377 → 11,357 and the
loose upper 21,372 → 21,332 with no code change, and one board that was reachable in Cycle 26 was
not this time. **The 21.52% → 17.48% comparison is valid because both come from this single
fetch.** Comparing 17.48% against Cycle 26's published 21.45% would conflate the rule change with
a day of board churn.

## Where this is published

- `data/fanout-verified.json` — both bounds, `top_disputed_tokens` and `top_rejected_tokens`, each
  with L and T, plus `gazetteer_tightening_method` stating the rule and its error direction.
- `actor/README.md` — the buyer-facing statement, scoped to the fan-out stratum with its
  denominator, not quoted as a corpus rate.
- `docs/research/cycle-26-corpus-gazetteer.md` — superseded as a headline; pointer added.
