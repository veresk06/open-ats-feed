import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROVIDERS } from '../src/normalize.js'

const recruitee = PROVIDERS.recruitee

// Verbatim from https://jobs.recruitee.com/api/offers/ on 2026-09-03, description and
// requirements truncated. Same standard as every other test in this directory: a real
// record, not one invented to make the mapper pass.
const REAL = {
  id: 2700540,
  slug: 'legal-counsel-benelux-1',
  title: 'Legal Counsel – Benelux',
  status: 'published',
  department: '1. G&A',
  created_at: '2026-08-05 07:43:51 UTC',
  published_at: '2026-08-05 08:02:41 UTC',
  employment_type_code: 'fulltime_fixed_term',
  category_code: 'legal_services',
  experience_code: 'mid_level',
  location: 'Amsterdam, Noord-Holland, Netherlands',
  city: 'Amsterdam',
  state_code: 'NH',
  country_code: 'NL',
  remote: false,
  careers_url: 'https://careers.tellent.com/o/legal-counsel-benelux-1',
  careers_apply_url: 'https://careers.tellent.com/o/legal-counsel-benelux-1/c/new',
  description: '<h4><strong>About the Role</strong></h4><p>As Legal Counsel, you&#39;ll help our Sales team.</p>',
  min_hours: 40,
  max_hours: null,
  salary: { max: '78000', min: '66000', period: 'year', currency: 'EUR' },
}

test('maps a real Recruitee offer into the shared record shape', () => {
  const r = recruitee.map(REAL, 'jobs')
  assert.equal(r.source, 'recruitee')
  assert.equal(r.company, 'jobs')
  assert.equal(r.company_url, 'https://jobs.recruitee.com/')
  assert.equal(r.job_id, '2700540')
  assert.equal(r.title, 'Legal Counsel – Benelux')
  assert.equal(r.url, 'https://careers.tellent.com/o/legal-counsel-benelux-1')
  assert.equal(r.location, 'Amsterdam, Noord-Holland, Netherlands')
  assert.equal(r.department, '1. G&A')
  assert.equal(r.employment_type, 'fulltime_fixed_term')
  assert.equal(r.posted_at.slice(0, 10), '2026-08-05')
})

// Recruitee is the first provider whose salary is published as structured data rather
// than buried in prose. A yearly range is taken at face value — this is the company's
// own number, not a parse of its marketing copy.
test('takes a published yearly salary range directly', () => {
  const r = recruitee.map(REAL, 'jobs')
  assert.equal(r.salary_min, 66000)
  assert.equal(r.salary_max, 78000)
  assert.equal(r.salary_currency, 'EUR')
})

// The schema promises salary is never estimated. Monthly x 12 is an estimate wherever
// 13th- and 14th-month payments are ordinary, which is most of Recruitee's home market.
test('leaves salary null for any period other than year', () => {
  for (const period of ['month', 'week', 'day', 'hour']) {
    const r = recruitee.map({ ...REAL, salary: { ...REAL.salary, period } }, 'jobs')
    assert.equal(r.salary_min, null, `${period} must not be annualised`)
    assert.equal(r.salary_max, null, `${period} must not be annualised`)
    assert.equal(r.salary_currency, null, `${period} must not carry a currency`)
  }
})

test('leaves salary null when the offer publishes none', () => {
  for (const salary of [null, undefined, {}, { period: 'year', min: null, max: null }]) {
    const r = recruitee.map({ ...REAL, salary }, 'jobs')
    assert.equal(r.salary_min, null)
    assert.equal(r.salary_max, null)
    assert.equal(r.salary_currency, null)
  }
})

// The rule this codebase already paid for once: a boolean that cannot say "hybrid" is
// not evidence of remote. Ashby's isRemote was true for 110 Hybrid postings all located
// at a New York HQ. Recruitee's `remote` is the same shape and is measured against
// nothing, so it must not reach the column.
test('does not trust the boolean remote flag', () => {
  const onsiteText = { ...REAL, remote: true, location: 'Amsterdam, Netherlands', title: 'Legal Counsel' }
  assert.equal(recruitee.map(onsiteText, 'jobs').workplace, 'onsite')

  const hybrid = { ...REAL, remote: true, location: 'Amsterdam (Hybrid)' }
  assert.equal(recruitee.map(hybrid, 'jobs').workplace, 'hybrid')

  const remoteText = { ...REAL, remote: false, location: 'Remote, Netherlands' }
  assert.equal(recruitee.map(remoteText, 'jobs').workplace, 'remote')
})

test('carries the posting body, stripped of markup', () => {
  const r = recruitee.map(REAL, 'jobs')
  assert.match(r.description, /^About the Role As Legal Counsel/)
  assert.ok(!r.description.includes('<'))
})

test('falls back to city and country when location is absent', () => {
  const r = recruitee.map({ ...REAL, location: null }, 'jobs')
  assert.equal(r.location, 'Amsterdam, NL')
})

test('reads the offer list off the offers key', () => {
  assert.deepEqual(recruitee.list({ offers: [REAL] }), [REAL])
  assert.equal(recruitee.list({ offers: null }), null)
  assert.equal(recruitee.list([]), null)
})

test('addresses a board by subdomain, and encodes the token', () => {
  assert.equal(recruitee.url('acme'), 'https://acme.recruitee.com/api/offers/')
  assert.equal(recruitee.url('a b'), 'https://a%20b.recruitee.com/api/offers/')
})
