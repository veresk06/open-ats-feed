// Unpaid-listing detection.
//
// Second data-quality finding from the role census, and the same shape as recruitment ads: the
// ATS corpus carries listings that are not paid work. Measured on 2026-09-03 across 121,050
// titles read from 500 live boards: **445 postings** are volunteer or unpaid — "Hospice
// Volunteer (Unpaid)", "Private Equity Event Volunteer", "Event Assistant (volunteer)". They sit
// on genuine Greenhouse boards belonging to real organisations.
//
// As with the ads, the number that matters is not the corpus share, it is the concentration.
// Eight boards of 500 carry any of it, and on those eight it is not a rounding error:
// `greenhouse/privateequityinsights` is 113 of 1,159 titles, `greenhouse/cfoinsights` 112 of
// 373 — conference organisers staffing their events with unpaid help. A buyer paying per
// delivered row should not pay for those unless they asked for them.
//
// `excludeVolunteerListings` is on by default and `RUN_STATS.volunteer_listings_excluded`
// reports the count whether the flag is on or off. Same rule as the ad filter: a filter that
// will not tell you what it took is worse than no filter.
//
// Kept in sync by hand with FAMILIES.volunteer_unpaid in scripts/role-census.mjs; the Actor
// image is standalone and cannot import from there.

// 'pro bono' was in the census family and is deliberately NOT here. It fired **0 times in
// 121,050 titles**, and "Pro Bono Counsel" / "Pro Bono Program Manager" are salaried positions
// at large law firms — a phrase with no measured yield and a real false-positive cost is exactly
// what the audit is for. Same call, same reason, as dropping 'remote opportunity' from the ad
// list. 'unpaid intern' also fired 0 times but stays: it cannot describe a paid job.
const PHRASES = ['volunteer', 'unpaid intern']

// The false-positive class this filter has to survive: jobs that are *about* volunteers and are
// perfectly well paid. "Volunteer Services Manager" at a hospital, "Director of Volunteer
// Engagement" at a nonprofit. Removing those from a paid-jobs feed is the exact opposite of the
// point.
//
// Audited before defaulting the flag on, per the standing rule: this guard fires **0 times in
// 121,050 titles**, so it costs nothing today. It is here because the class is real at larger
// scale, not because the corpus demanded it — the whole reason the audit is worth running is
// that it tells you which of those two you are looking at.
// The role noun has to be present. "Volunteer Programme" on a conference board is the unpaid
// listing itself; "Volunteer Programs Specialist" is the person hired to run one. The optional
// middle word is what separates them, and getting that wrong in either direction is the whole
// difficulty here.
const ROLE = 'coordinator|manager|director|supervisor|specialist|recruiter|administrator|officer|lead|liaison'
const STAFF_ROLE = new RegExp(
  ` of volunteer | volunteer (?:(?:programs?|programme|services?|resources|engagement|relations) )?(?:${ROLE}) | volunteer (?:services?|engagement|relations) `,
)

// Same normalisation as the census: lowercase, punctuation to spaces, padded so that a phrase at
// either end of the title still matches on word boundaries.
const norm = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `

export function isVolunteerListing(row) {
  const t = norm(row?.title)
  if (STAFF_ROLE.test(t)) return false
  return PHRASES.some((p) => t.includes(norm(p).trim()))
}

export const VOLUNTEER_PHRASES = PHRASES
