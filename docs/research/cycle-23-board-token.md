# Cycle 23 — classifying boards from the board token, and the audit that killed most of it

**Question.** Cycle 22's board prior infers a board's role family from the families its own
*titles* resolve to, and has a ceiling it cannot see past: it propagates the keyword classifier's
mistakes. The worked example was `lever/jetsetpilates`, a Pilates studio whose 168 postings titled
`Instructor - <city>` read as `education` — correct from the title alone, wrong about the company,
and invisible to leave-one-out because the truth labels are wrong the same way. The word "pilates"
appears only in the **board token**. The token is public metadata we already ship, and it is what a
human reads. Can it classify a board?

**Answer: yes, for 1.39% of the roster, and the interesting part is why the other 98.6% fails.**
81 keys were built. **8 survive the audit.** Overall agreement between what a token implies and
what a board's own postings say is **54.3% over 838 audited boards** — barely better than a coin
flip, and the failure is systematic rather than lexical.

Reproduce with `node scripts/board-token.mjs`. 777 boards were read live from the vendors' public
APIs; local node, no Apify platform runs, **$0.00**.

---

## 1. The result in one line

**A company's modal posting family is not its industry.** The token usually reads the industry
correctly and *still* predicts the wrong role family, because most companies employ people to do
something other than the thing the company sells.

| key | says | agreement | what the disagreeing boards' own titles actually say |
|---|---|---:|---|
| `software` | engineering | **38%** (29/29, census) | `sales_marketing` ×6, `corporate` ×3 — `veeamsoftware`, `lucidsoftware`, `thinkcellsoftware`. A software company's most common posting is a salesperson. |
| `capital` | corporate | 48% | **every disagreement resolves to `engineering`** — `towerresearchcapital`, `akunacapital`, `gravitonresearchcapital`. Quant funds are engineering shops. |
| `foods` | retail_food | **0%** (11 boards) | `corporate` ×6, `skilled_trades` ×2. A food plant is not a restaurant. |
| `financial` | corporate | 26% (census) | `engineering` ×3, `sales_marketing` ×3 |
| `construction` | skilled_trades | 18% (census) | `corporate` ×6 — construction firms are full of project managers |
| `orthodon` | healthcare | **0%** (7 boards) | `sales_marketing` ×3, `corporate` ×2 — an orthodontic practice hires treatment coordinators and front-office staff |
| `campus` | education | **0%** (9 boards) | `chicagotradingcampus` is a trading firm, `startcampus` builds data centres |
| `pharmac` | healthcare | 40% (census) | `sales_marketing` ×4 |

None of these is the token misreading the company. `veeamsoftware` **is** a software company.
The prediction is wrong about the *role*, and right about the *industry* — which means the method
is not broken so much as answering a different question than the one it was scored on.

## 2. What survives, and the property they share

| key | family | agreement | audited | basis |
|---|---|---:|---:|---|
| `veterinar` | healthcare | **100%** | 21/21 | population census |
| `hospital` | healthcare | **100%** | 13/13 | population census |
| `vet` (end-anchored) | healthcare | **100%** | 13 of 14 | sample |
| `pediatric` | healthcare | **100%** | 5/5 | population census |
| `dental` | healthcare | 82% | 11/11 | population census |
| `robotics` | engineering | 82% | 39/39 | population census |
| `school` | education | 71% | 28 of 29 | sample |
| `charterschool` | education | 70% | 10/10 | population census |

**The eight share one property: the company's staff *are* the product.** A veterinary practice is
vets, a charter school is teachers, a robotics company is engineers. Where the workforce and the
product coincide, industry and modal role family are the same thing; everywhere else they diverge,
and the divergence is the 54.3%.

Applied to the full roster this reaches **142 boards (1.39%) carrying 4,599 open postings
(1.58%)**. Of those 142, **134 were never censused at all** and 3 were censused but left blank by
the title prior — so 137 boards get a label they had no other way to get. The 5 that already had a
title prior **all agree with it**, which is a small consistency check rather than new information.

## 3. The trap, measured rather than asserted

A substring in a token is not a fact about a company. Every key carries an explicit blocker list
and the script reports what each blocker killed.

- **`care`: 185 raw hits, 110 blocked — 59% of the naive matches are noise.** They are boards
  whose token merely ends in `careers`: `plscareers`, `allcareers`, `zyngacareers`, `nflcareers`.
- **`svetness` contains `vet`, and it is a tutoring staffing agency.** It is also the single
  largest board in the corpus at 4,981 postings, so a naive `vet` substring would have mislabelled
  more postings than the whole shipped result contains. `vet` is end-anchored for this reason;
  `fivetran`, `truveta`, `avetta` and `resolvetosavelives` fail with it.
- **`australianenergymarketoperator` contains `gym`** — "ener-**gym**-arket".
- `oneacrefundmalawi` and `delawaretitleloansinc` contain `law`. `spacex` and `squarespace`
  contain `spa`. `instacart` contains `art`.
- Four keys were dropped before the audit for being pure noise at roster scale: `art` (205 hits,
  all collisions), `spa` (109, all collisions), `market` (35, all marketplaces and trading firms
  rather than marketing), `partners` (68, a legal structure and not an industry).

## 4. Two bugs in this cycle's own key list, found by its own tests

Both are ordering bugs — the same class as the Cycle-22 bug that put 194 fitness instructors into
`education`, and again found by a mechanical check rather than by reading the list.

1. `daycare` sat behind `care` in the ordering and could never fire, so a daycare would have been
   called `healthcare`. Fixed by making `daycare` a blocker on `care`.
2. That fix then silently dropped `greenhouse/thomasvillechildcare`, which needed a `childcare`
   key of its own to land in `education`.

Zero roster boards were affected in either case — both were caught before they counted anything,
which is the only cheap time to catch one. A test now asserts that no key is shadowed by an
earlier, broader key it does not block.

## 5. How much auditing is enough — this run answered that by accident

The first pass audited at most 12 boards per key. On that evidence `care` scored **80% (12/15)**
and shipped. Auditing all 55 boards it fires on put it at **53%**, and it does not ship.

The 95% Wilson interval at n=15 was **[55%, 93%]** — so the true value of 53% sits *below* the
interval's lower bound. The small sample was not merely wide, it was biased: the boards reached
first were the largest ones, and large `care` boards are disproportionately real care providers
while the tail is software. Overall agreement moved 55.0% → 54.3% as n went 469 → 838.

**The correction only ran in one direction that mattered**: `school` went the other way, 62%
(n=13) → 71% (n=28), and now ships. But `care` is the cautionary one, because a 12-board audit
would have published it.

## 6. What this does not do, stated before anyone asks

**Only the FILL use is validated. The OVERRIDE use is not attempted.**

- **Fill** — give a family to a board with no title evidence. Checkable, and it is what ships.
- **Override** — correct a board whose titles are confidently wrong. This is the `jetsetpilates`
  case the token was wanted for, and it **cannot be scored**, because the yardstick is the very
  label the override exists to overrule. `pilates` scores 0%, on n=1, for exactly that reason.

And the population is the harder limit: **`pilates` fires on one board in 10,197 — `jetsetpilates`
itself.** The failure class that motivated this entire cycle is one board wide. That is worth
knowing and it is not what we expected to find.

Two further limits, both inherited:

- **The yardstick is not ground truth.** It is the keyword classifier's own modal label, so 54.3%
  is agreement, not correctness — the same caveat that governs the Cycle-22 board prior.
- **For `dental` (11/11), `hospital` (13/13), `charterschool` (10/10), `pediatric` (5/5),
  `robotics` (39/39) and `veterinar` (21/21) the audit covered every board the key fires on.**
  That is a population census, not a small sample: it carries no sampling error, but equally no
  guarantee for a board added to the roster next month. Reporting a Wilson interval on a census
  would have been the wrong statistic, and the output labels which is which.

## 7. Published

`docs/data/board-industry.csv` — **142 rows**, MIT, one per board a surviving key fires on, with
the key that fired, the family, the board's own title-derived family, and whether the two agree.
**120 rows agree, 20 disagree, 2 could not be read.** The disagreements ship labelled rather than
dropped: removing them would raise the file's apparent accuracy by hiding its misses.

Not one row per roster board. A 10,197-row file that is blank on 10,055 rows would overstate what
this method reaches.

## 8. What would actually move this

Not more keys — the audit rejects them faster than they can be written. The two things with a
real prospect:

1. **Predict the industry, and say so, instead of predicting the role family.** Section 1 shows
   the token is mostly right about the industry and mostly wrong about the role. "What industry is
   this board" is arguably the more useful buyer filter of the two. It needs a different yardstick,
   because titles cannot validate an industry claim.
2. **Re-examine `other`** — 10.61%, 30,113 titles, the largest unclassified block in the census and
   still bigger than `unclassifiable_generic`. It has never had a run of its own.
