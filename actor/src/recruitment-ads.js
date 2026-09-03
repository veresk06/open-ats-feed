// Recruitment-ad detection.
//
// The ATS corpus is not all real openings. Measured on 2026-09-03 across 121,050 titles read
// from 500 live boards: **1,411 postings carry the open-ended commission-only / MLM signature**
// — "stop building someone else's dream", "tired of your income being capped?", "work from home
// - client benefits representative" — sitting on genuine Greenhouse, Ashby and Lever boards.
// Full method and numbers: docs/research/cycle-19-role-census.md.
//
// Two corrections to how this was stated in build 0.1.16, both of which make the claim better:
//
//  1. The count is 1,411, not 1,413, and "1,413 of 121,050 titles, 0.48% of the corpus" invited
//     the reader to divide and get 1.17%. Both numbers were real — 1.17% is the share of what
//     was read, 0.48% the stratum-weighted estimate over the whole corpus — but printed side by
//     side they read as an arithmetic error. Quote the measured share of what was read.
//  2. **The share was the wrong statistic anyway. It is the concentration that sells.** Of 500
//     boards, exactly **2** carry any recruitment ads, and `lever/globalelitecareers` alone is
//     1,380 of them — 79% of that board's 1,752 postings. So this filter does nothing at all on
//     ~498 boards, and on one board it decides whether the run is usable. A buyer does not fear
//     losing 1% of their rows; they fear paying for 1,380 rows of pitch off a single board.
//
// Every competitor in this category ships these rows silently, because none of them has counted
// them. We compute the classification anyway, so filtering costs nothing and the count is
// reportable. `excludeRecruitmentAds` is on by default and `RUN_STATS.recruitment_ads_excluded`
// says how many rows it removed — a filter that will not tell you what it took is worse than no
// filter.
//
// Deliberately conservative. These phrases are the *pitch*, not the job: a real posting says
// what the work is. False positives are still possible (a genuine "Remote Opportunity - Staff
// Nurse" exists), which is why this is `suspect_` and why the flag can be turned off rather
// than being hardcoded. Kept in sync by hand with FAMILIES.suspect_recruitment_ad in
// scripts/role-census.mjs; the Actor image is standalone and cannot import from there.

const PHRASES = [
  'work from home', 'work at home', 'be your own boss', 'unlimited income',
  'income being capped', 'someone else s dream', 'break free of the 9 5', 'another way',
  'burned out from the 9 5', 'take back control of your time',
  // 'remote opportunity' and 'no experience necessary' were dropped after auditing what they
  // actually caught: 2 hits and 0 hits in 121,050 titles, against a real false-positive cost —
  // "Registered Nurse - Remote Opportunity" is a job, not a pitch. A default-on filter has to
  // be measured on its false positives, not just its true ones.
  'earn from home', 'financial freedom',
]

// Same normalisation as the census: lowercase, punctuation to spaces, padded so that a phrase
// at either end of the title still matches on word boundaries.
const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `

export function isRecruitmentAd(row) {
  const t = norm(row?.title)
  return PHRASES.some((p) => t.includes(norm(p).trim()))
}

export const RECRUITMENT_AD_PHRASES = PHRASES
