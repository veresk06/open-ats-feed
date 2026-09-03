# What is actually in the feed — role census, 2026-09-03

**121,050 job titles read across 500 boards, zero fetch failures.** First measurement of the
*composition* of our corpus. We had measured the roster exhaustively (10,197 live boards,
291,507 open postings) and never once measured what those postings are.

## Method

Stratified, because board size is heavily skewed (top 500 boards = 50.7% of all postings, median
board = 9). A uniform sample would be dominated by nine-posting boards and would answer a
different question.

| Stratum | Boards | Titles read | Treatment |
|---|---:|---:|---|
| Head | 250 | 116,490 | **Census** — every posting read, no sampling error |
| Tail | 250 of 9,947 | 4,560 | Deterministic every-39th sample, weighted ×38.4 |

The sample is deterministic rather than random so a third party can reproduce it from
`docs/data/all.csv` alone. Reproduce with `node scripts/role-census.mjs --head=250 --tail=250`.

**Roster counts validated as a by-product.** The head stratum claimed 116,444 open postings and
returned 116,490 titles — a 0.04% drift over four days. The published roster numbers are real.

## Result

| Family | Postings | Share |
|---|---:|---:|
| other (unclassified) | 91,361 | 31.34% |
| corporate | 44,189 | 15.16% |
| **engineering** | **41,780** | **14.33%** |
| sales & marketing | 36,518 | 12.53% |
| healthcare | 23,270 | 7.98% |
| skilled trades | 10,025 | 3.44% |
| retail & food | 9,360 | 3.21% |
| product & design | 8,977 | 3.08% |
| education | 6,805 | 2.33% |
| fitness & wellness | 6,172 | 2.12% |
| retail/food (generic mgmt) | 4,175 | 1.43% |
| logistics | 3,230 | 1.11% |
| non-English | 2,365 | 0.81% |
| support | 1,912 | 0.66% |
| **suspect recruitment ad** | **1,413** | **0.48%** |

## Three findings

### 1. "291,507 ATS postings" is roughly 14% developer-facing

Engineering is 41,780 postings — **14.33%**, or 17.4% if product and design are counted with it.
Frontline and service work (healthcare, retail, food, fitness, logistics, trades, education)
together is 21.6%, and that is a floor, since much of `other` is the same kind of work.

This is the fact the positioning question needed. Selling "291,507 open postings" to a developer
job-board builder describes a corpus that is ~86% not what they want. The number is honest and
the framing was not. Two options follow, and they are genuinely different businesses:

- **Segment it.** Ship an engineering-filtered view where the headline is ~41,780 postings across
  the boards that actually carry them. Smaller number, far higher relevance.
- **Re-aim it.** The head of the corpus is staffing, healthcare and retail. That buyer is a
  recruiter or a staffing firm, not an engineer. Nobody in this category is aiming there.

Not resolved here. It is a CEO call and it now has a measurement under it.

### 2. There are recruitment ads inside the ATS corpus, and nobody publishes that

1,413 postings match the open-ended "be your own boss" signature — *"stop building someone
else's dream"*, *"tired of your income being capped?"*, *"burned out from the 9-5? there's
another way"*, *"work from home - client benefits representative"*. These are commission-only or
MLM recruitment ads occupying real Greenhouse/Ashby/Lever boards.

0.48% is small but it is not noise: it is the kind of thing that ends up in a customer's product
as a real-looking job. Every competitor in this category ships this content silently. Naming it,
counting it and offering to filter it is a differentiator that costs us nothing, because we
already compute it.

### 3. Ranking boards by engineering postings is a different list than ranking by size

Our top board overall is `svetness` (4,981 — tutoring staffing). Our top board *for engineering*
is `greenhouse/speechify` (1,190 engineering of 1,317 total). The overall head — `boxlunch`,
`eosfitness`, `bayada`, `liquidpersonnel` — contributes almost nothing.

Top boards by engineering postings (from the censused head):

| Eng. postings | Board total | Board |
|---:|---:|---|
| 1,190 | 1,317 | greenhouse/speechify |
| 871 | 3,084 | ashby/bjakcareer |
| 628 | 2,208 | greenhouse/andurilindustries |
| 461 | 2,281 | greenhouse/spacex |
| 402 | 859 | greenhouse/databricks |
| 307 | 513 | lever/bluelightconsulting |
| 249 | 770 | ashby/openai |
| 198 | 433 | lever/shieldai |
| 190 | 444 | greenhouse/asm |
| 183 | 498 | ashby/airapps |

Full list of 200 in `data/role-census.json` → `engineering_boards_top`.

This directly sharpens the fetch-ordering result we gave `xCirno1/applyer#29` yesterday. We told
them the top 500 boards of 10,197 hold 50.7% of postings, which budgets a full sweep. For a
*developer* job tool the correct ordering is by engineering postings, not total — and by that
ordering the head is different. Worth contributing as a follow-up, but **not immediately**: the
first comment landed at 03:15Z today and a second within the hour reads as working the thread
rather than helping it.

## Limitations, stated rather than buried

- **31.3% is still unclassified.** Down from 36.05% on the first run after adding fitness,
  generic retail management and a partial French pass. The classifier is keyword-on-title,
  first-match-wins, and it under-reads anything whose title carries no industry word
  (`Associate`, `Coordinator II`, `Specialist`). The families reported are floors, not
  estimates — a title only lands in a family if it says so.
- **English-biased.** `non_english` at 0.81% is what a partial French keyword pass caught, not a
  real count of non-English postings. The true figure is higher.
- **Engineering is the most reliable row.** Software titles are unusually self-describing, so
  14.33% is the number in this table least likely to move with a better classifier.
- All 121,050 titles are cached in `data/role-census-titles.json`. Reclassification is now free
  (`--from-cache`); the 5 minutes of fetching does not have to be spent again.

## Cost

$0.00 on Apify. Local node against the vendors' public APIs, same as `snapshot-history.mjs`.
Month-to-date platform spend unchanged at $0.118 of $5.00.
