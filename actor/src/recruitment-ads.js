// Recruitment-ad detection.
//
// The ATS corpus is not all real openings. Measured on 2026-09-03 across 121,050 titles read
// from 500 live boards: **1,413 postings (0.48%) carry the open-ended commission-only / MLM
// signature** — "stop building someone else's dream", "tired of your income being capped?",
// "work from home - client benefits representative" — sitting on genuine Greenhouse, Ashby and
// Lever boards. Full method and numbers: docs/research/cycle-19-role-census.md.
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
