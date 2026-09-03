import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SOURCES, PROVIDER_NAMES, tokenFromUrl } from '../scripts/lib/tokens.mjs'

test('every harvest source names a provider the roster knows', () => {
  assert.deepEqual(PROVIDER_NAMES, [
    'greenhouse', 'lever', 'ashby', 'workable', 'breezy', 'recruitee', 'teamtailor',
  ])
  for (const s of SOURCES) assert.ok(PROVIDER_NAMES.includes(s.provider), s.host)
})

// SmartRecruiters was harvested in Cycle 33 and removed the same cycle:
// api.smartrecruiters.com serves "User-agent: * / Disallow: /" and allows
// /v1/companies/ to LinkedInBot alone. This test is the tripwire — re-adding the
// host is a decision that has to be made deliberately, not by pattern-matching the
// list above.
test('no source fetches a host whose robots.txt refuses us', () => {
  const hosts = SOURCES.map((s) => s.host)
  assert.ok(!hosts.some((h) => h.endsWith('smartrecruiters.com')), 'see scripts/lib/tokens.mjs')
})

test('pulls the company token out of a board URL', () => {
  assert.equal(tokenFromUrl('https://boards.greenhouse.io/stripe'), 'stripe')
  assert.equal(tokenFromUrl('https://jobs.lever.co/netflix/abc-123'), 'netflix')
  assert.equal(tokenFromUrl('https://apply.workable.com/1-stopasia/'), '1-stopasia')
})

// Workable routes a direct link to a posting through /j/{SHORTCODE}. Harvesting that
// as a company token yields a board named "j" that does not exist.
test('platform routes are not companies', () => {
  assert.equal(tokenFromUrl('https://apply.workable.com/j/2AB91180EB'), null)
  assert.equal(tokenFromUrl('https://apply.workable.com/api/v1/widget'), null)
  assert.equal(tokenFromUrl('https://boards.greenhouse.io/embed/job_board'), null)
  assert.equal(tokenFromUrl('https://apply.workable.com/'), null)
})

test('lowercases by default, because those four vendors resolve a lowercased token', () => {
  assert.equal(tokenFromUrl('https://apply.workable.com/Acme-Co/'), 'acme-co')
})

// The opposite case is why the flag exists at all: a vendor that puts a
// case-sensitive identifier straight into the API path turns `ubisoft` into a 404
// when the board is `Ubisoft`. No current source needs it, and it stays because the
// next vendor evaluated might.
test('caseSensitive preserves the token verbatim', () => {
  assert.equal(
    tokenFromUrl('https://careers.example.com/10xValuePartnersGmbH', { caseSensitive: true }),
    '10xValuePartnersGmbH',
  )
  // Route filtering is still case-insensitive — /API/ is no more a company than /api/.
  assert.equal(tokenFromUrl('https://careers.example.com/API/v1', { caseSensitive: true }), null)
})

test('rejects the shapes that are never company tokens', () => {
  assert.equal(tokenFromUrl('https://jobs.lever.co/123456'), null, 'a bare job id')
  assert.equal(tokenFromUrl('not a url'), null)
  assert.equal(tokenFromUrl(`https://boards.greenhouse.io/${'a'.repeat(101)}`), null)
})

// Breezy, and the whole class of vendors that address a board as {token}.vendor.tld.
// A path-only harvester finds none of them, which is one measurable reason the roster
// stopped at three providers.
const breezy = { tokenFrom: 'subdomain', host: 'breezy.hr' }

test('pulls the company token out of a subdomain board URL', () => {
  assert.equal(tokenFromUrl('https://47-degrees.breezy.hr/json', breezy), '47-degrees')
  assert.equal(
    tokenFromUrl('https://20four7va.breezy.hr/p/9fa69e90edc7-some-role', breezy),
    '20four7va',
  )
})

// The vendor's own subdomains sit in exactly the slot a company token occupies, so on
// a path vendor these could never be reached and here they are the common case.
test('vendor subdomains are not companies', () => {
  assert.equal(tokenFromUrl('https://www.breezy.hr/blog/ai-in-hr', breezy), null)
  assert.equal(tokenFromUrl('https://app.breezy.hr/signin', breezy), null)
  assert.equal(tokenFromUrl('https://breezy.hr/pricing', breezy), null, 'the apex is not a tenant')
})

// Without an explicit host, a suffix match would accept any hostname that merely
// contains the vendor name, which is how a harvester ends up fetching someone else.
test('a subdomain token is only taken from the named vendor host', () => {
  assert.equal(tokenFromUrl('https://acme.breezy.hr.evil.com/json', breezy), null)
  assert.equal(tokenFromUrl('https://acme.breezy.hr/json', { tokenFrom: 'subdomain' }), null)
  assert.equal(tokenFromUrl('https://a.b.breezy.hr/json', breezy), null, 'a nested label')
})

const recruitee = { tokenFrom: 'subdomain', host: 'recruitee.com' }
const teamtailor = { tokenFrom: 'subdomain', host: 'teamtailor.com' }

test('the same rules hold for the other subdomain vendors', () => {
  assert.equal(tokenFromUrl('https://tellent.recruitee.com/api/offers/', recruitee), 'tellent')
  assert.equal(tokenFromUrl('https://hemnet.teamtailor.com/jobs.json', teamtailor), 'hemnet')
  assert.equal(tokenFromUrl('https://www.teamtailor.com/en/career-site/', teamtailor), null)
  assert.equal(tokenFromUrl('https://support.recruitee.com/en/articles/1', recruitee), null)
  assert.equal(tokenFromUrl('https://acme.recruitee.com.evil.com/', recruitee), null)
})

// A known and accepted false negative, recorded so it is not rediscovered as a bug.
// `jobs` is on the platform-route list because on a path vendor
// (apply.workable.com/jobs) it can only ever be a vendor route. On a subdomain vendor
// it can be a real tenant: jobs.recruitee.com is Tellent's own board and served 8 live
// offers when this was written. The list costs us that board and saves us from
// harvesting every vendor route as a company; the trade is worth it at this ratio, but
// it is a trade and not a free win.
test('a platform-route name shadows a real tenant on a subdomain vendor', () => {
  assert.equal(tokenFromUrl('https://jobs.recruitee.com/api/offers/', recruitee), null)
})
