import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROVIDERS } from '../src/normalize.js'

const workable = PROVIDERS.workable

// Verbatim from apply.workable.com/api/v1/widget/accounts/1-stopasia?details=true on
// 2026-09-03, trimmed to the fields the mapper reads. Same standard as the other
// tests in this directory: a real record, not one invented to pass.
const REAL = {
  title: 'Finnish Native Speakers Needed - Paid Voice Recording Project - Freelance Remote',
  shortcode: '2AB91180EB',
  code: '',
  employment_type: 'Temporary',
  telecommuting: true,
  department: 'Production',
  url: 'https://apply.workable.com/j/2AB91180EB',
  shortlink: 'https://apply.workable.com/j/2AB91180EB',
  published_on: '2026-07-30',
  created_at: '2026-07-30',
  country: 'Finland',
  city: '',
  state: '',
  experience: 'Associate',
  description: '<p>1-StopAsia is looking for pairs of Finnish native speakers.</p>',
}

test('maps a real Workable posting into the shared record shape', () => {
  const r = workable.map(REAL, '1-stopasia')
  assert.equal(r.source, 'workable')
  assert.equal(r.company, '1-stopasia')
  assert.equal(r.company_url, 'https://apply.workable.com/1-stopasia/')
  assert.equal(r.job_id, '2AB91180EB')
  assert.equal(r.url, 'https://apply.workable.com/j/2AB91180EB')
  assert.equal(r.employment_type, 'Temporary')
  assert.equal(r.department, 'Production')
  assert.equal(r.description, '1-StopAsia is looking for pairs of Finnish native speakers.')
  assert.equal(r.posted_at.slice(0, 10), '2026-07-30')
})

// Workable ships city/state/country as three fields and leaves the unused ones as
// empty strings rather than null. Joining them naively produces ", , Finland".
test('builds a location from the parts that are actually present', () => {
  assert.equal(workable.map(REAL, 'x').location, 'Finland')
  assert.equal(
    workable.map({ ...REAL, city: 'Berlin', state: '', country: 'Germany' }, 'x').location,
    'Berlin, Germany',
  )
  // A board with no location at all must yield null, not an empty string — the
  // dataset schema documents null as "not published" and '' as nothing.
  assert.equal(workable.map({ ...REAL, country: '', city: '', state: '' }, 'x').location, null)
})

// The reason `telecommuting` is trusted at all is that it was measured, and the
// reason it is not trusted blindly is Ashby: `isRemote` there is true for Hybrid
// roles, and believing it classified two thirds of the feed as remote.
test('telecommuting sets remote, and a hybrid label still wins', () => {
  assert.equal(workable.map(REAL, 'x').workplace, 'remote')
  // The fixture's own title ends "Freelance Remote", so clearing the flag alone does
  // not make it onsite — the text fallback still reads the title. Clear both.
  assert.equal(
    workable.map({ ...REAL, telecommuting: false, title: 'Voice Recording Assistant' }, 'x').workplace,
    'onsite',
  )
  assert.equal(
    workable.map({ ...REAL, telecommuting: true, city: 'Berlin (Hybrid)' }, 'x').workplace,
    'hybrid',
    'a board that says hybrid is hybrid even when the remote flag is set',
  )
  assert.equal(
    workable.map({ ...REAL, telecommuting: false, title: 'Backend Engineer (Remote)' }, 'x').workplace,
    'remote',
    'the text fallback still runs when the flag is absent or false',
  )
})

// Workable ships an `experience` enum. We ignore it on purpose: three providers derive
// seniority from the title, and one column must not mean two different things
// depending on which row it sits in.
test('seniority stays title-derived rather than taking the vendor enum', () => {
  assert.equal(workable.map({ ...REAL, title: 'Senior Data Engineer', experience: 'Entry level' }, 'x').seniority, 'senior')
  assert.equal(workable.map({ ...REAL, title: 'Data Engineering Intern', experience: 'Director' }, 'x').seniority, 'intern')
})

test('list() requires the jobs array details=true provides', () => {
  assert.deepEqual(workable.list({ jobs: [REAL] }), [REAL])
  assert.equal(workable.list({ name: 'Deliveroo' }), null, 'no jobs key is not an empty board')
  assert.deepEqual(workable.list({ jobs: [] }), [], 'an empty array is a genuinely empty board')
})

test('the URL asks for details, without which every board reads as empty', () => {
  const u = new URL(workable.url('acme-co'))
  assert.equal(u.host, 'apply.workable.com')
  assert.equal(u.searchParams.get('details'), 'true')
  assert.ok(u.pathname.endsWith('/acme-co'))
})
