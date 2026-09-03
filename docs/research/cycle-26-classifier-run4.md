# Cycle 26 — Classifier run 4: what `other` was actually made of

**Date:** 2026-09-03 · **Cost:** $0.00 (reclassified from `data/role-census-titles.json`, no network)
**Code:** `scripts/role-census.mjs` · **Tests:** `test/role-census.test.js` — 9 new, 85/85 pass
**Audit tool:** `node scripts/audit-classifier.mjs <family>`

Run 3 left 10.61% of the corpus in `other` and a note saying the classifier speaks American.
This run reads the residue and acts on it. Three families are new, 60 keys were written, and
**24 of them were deleted before publication** — 15 for firing zero times, 9 for firing on the
wrong jobs.

## The headline table

| Family | Before | After | Δ |
|---|---:|---:|---:|
| engineering | 21.17% | **21.05%** | −0.12 |
| corporate | 14.52% | 14.38% | −0.14 |
| sales_marketing | 11.82% | 11.72% | −0.10 |
| unclassifiable_generic | 11.96% | 11.64% | −0.32 |
| **other** | **10.61%** | **8.88%** | **−1.73** |
| **healthcare** | **8.03%** | **8.75%** | **+0.72** |
| **ai_gig_work** | — | **1.26%** | new |
| **events** | — | **0.45%** | new |
| **media_production** | — | **0.14%** | new |

4,912 weighted postings left `other`. Everything else moved by less than a third of a point.

## Where each new family came from

Not a new bucket filling from `other` — the interesting movement is sideways, out of families
that were counting these as real openings.

| Move | Weighted postings |
|---|---:|
| other → ai_gig_work | 1,690 |
| other → healthcare | 1,660 |
| corporate → ai_gig_work | 833 |
| other → corporate | 688 |
| corporate → healthcare | 426 |
| other → events | 412 |
| unclassifiable_generic → events | 376 |
| unclassifiable_generic → corporate | 350 |
| **engineering → ai_gig_work** | **333** |
| other → media_production | 319 |
| sales_marketing → events | 223 |
| non_english → ai_gig_work | 190 |
| healthcare → ai_gig_work | 157 |

`ai_gig_work` drew from **ten** different families. That is the finding: AI-training piecework
was not sitting in a corner of `other`, it was distributed across the entire taxonomy wearing the
job title of whatever profession it was recruiting — accountants, cardiologists, German speakers,
CAD engineers.

## The three new families

**`ai_gig_work` — 3,567 postings, 1.26%.** Two boards post AI-training gig work by the thousand:
`greenhouse/prolificacademicltd` (1,979 of the 2,062 `ai training` hits) and `greenhouse/agency`.
"AI Trainer - Electrical Engineers, CAD, Python expertise" is piecework for a model vendor, not
an opening on an engineering team.

Unlike `suspect_recruitment_ad` and `volunteer_unpaid`, **the Actor does not filter it.** An MLM
pitch is not a job and an unpaid listing is not paid; AI gig work is a real paid job a buyer may
well want. It is labelled so it can be excluded by choice.

**`healthcare` +0.72pp.** `greenhouse/pulse` carries 832 UK clinical postings written in NHS
vocabulary — Agenda for Change pay bands, `locum`, `radiographer`, `biomedical scientist` — and
every one had been landing in `other`. The second group was American: specialty physicians named
by specialty (`endocrinolog`, `gynecolog`, `patholog`) rather than by the word "physician".

**`events` — 1,283 postings, 0.45%.** One board family writes out `event operations organiser`,
`conference operations producer`, `events executive` and a dozen more permutations. Ordered after
`skilled_trades` so a Conference Room AV Technician stays a trade, and before `sales_marketing` so
event operations is not read as marketing.

**`media_production` — 409 postings, 0.14%.** Small, and smaller than it first looked. See below.

## The five keys the audit killed, and why this section is the point

Every key was written from evidence in the residue, then run through
`scripts/audit-classifier.mjs` to see which titles it actually caught. Five had to go, and none
of the five was obvious from reading the keyword.

| Key | Hits | What it was really catching |
|---|---:|---|
| `producer` | 323 | **201 were `Insurance Producer - Abilene, TX`** and its siblings on one insurance-agency board. In US insurance a "producer" is a salesperson. |
| `post production` | 62 | **61 were `Associate Director, Post Production & Quality Operations` at Carvana** — a used-car retailer, where post-production means reconditioning a vehicle. |
| `broadcast` | 39 | National Broadcast *Buying* (media buying, a marketing job) and AI subject-matter gigs. |
| `hospice` | 26 | Account executives and client-services managers at hospice providers. `healthcare` is ordered ahead of `sales_marketing`, so keeping it would have inflated the exact family this run set out to correct. |
| `radiograph` | 19 | `Sr. NDE Engineer, Radiography Testing` — industrial weld inspection at SpaceX. Narrowed to `radiographer`. |

Also deleted: `data annotation` and `data labeling`, whose few hits were staff jobs at model labs
("Technical Program Manager, Human Data Annotation") — precisely the engineering roles the new
family must not steal. And 15 keys that fired zero times, following run 3's precedent with
`pro bono`: a key with no hits is pure false-positive risk carried for free.

**The lesson generalises past this file.** `producer` looked correct from three examples and was
62% wrong. Three examples is what you get by reading the top of a list; the audit is what tells
you the other 320. The nine assertions in `test/role-census.test.js` freeze each of these
decisions, because the failure mode of a first-match-wins keyword list is that adding a family in
the middle silently re-decides every title the families below it used to own — and nothing else
in the suite would notice.

## What this does not change

**The engineering headline moved 0.12 points, from 21.17% to 21.05%.** 333 postings counted as
engineering were AI gig work, which is a real contamination and a small one. Anyone hoping this
run would settle the open positioning question — segment to engineering, or re-aim at
recruiters? — should read that number as settling nothing. The corpus is still ~21%
developer-facing and the argument is still where it was.

## Residue, stated rather than hidden

- **`other` is still 8.88%.** What is left is genuinely diverse: superintendents, home inspectors,
  quantitative researchers, "Founder's Office", `business unit head` titles. There is no third
  large block to find; the next percent will cost more keys than the last four did.
- **`ai_gig_work` is a lower bound.** `greenhouse/agency` also posts specialty-physician gigs —
  "Cardiologists (Freelance - Remote) - Albuquerque, US" — that carry no AI wording at all. Those
  are counted as `healthcare`, and on the evidence in the title alone that is the defensible call.
- **`Sr. NDE Engineer, Radiography Testing` now lands in `engineering`** via the bare `engineer`
  catch. It is industrial NDE and belongs in `engineering_nonsoftware`. One title; noted, not
  chased.
- **`docs/data/board-industry.csv` is still computed under run 3's classifier.**
  `scripts/board-token.mjs` needs a live fetch for boards outside the census cache, so it was not
  re-run this cycle. `docs/data/engineering.csv` and `docs/data/board-roles.csv` were regenerated.
- **The board prior was re-scored on the new families** and holds: support ≥ 5, confidence ≥ 0.7,
  **92.5% leave-one-out accuracy**, 1,718 of 10,838 generic titles assigned. 67 of those
  assignments now go to `ai_gig_work`.
