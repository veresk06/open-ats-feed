import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROVIDERS } from '../src/normalize.js'

const breezy = PROVIDERS.breezy

// Verbatim from https://75f.breezy.hr/json on 2026-09-03. Same standard as the other
// tests here: a real record, not one invented to pass.
const REAL = {
  id: '9fa69e90edc7',
  friendly_id: '9fa69e90edc7-is-75f-your-dream-company-but-you-don-t-see-your-job-click-here',
  name: "Is 75F your dream company but you don't see your job? Click here!",
  url: 'https://75f.breezy.hr/p/9fa69e90edc7-is-75f-your-dream-company-but-you-don-t-see-your-job-click-here',
  published_date: '2021-09-20T20:43:04.044Z',
  type: { id: 'fullTime', name: 'Full-Time' },
  location: { country: { name: 'United States', id: 'US' }, name: 'United States', city: '', is_remote: false },
  department: 'Any',
  salary: '',
  company: { name: '75F', logo_url: null, friendly_id: '75f', isMultipleLocationsEnabled: true },
  locations: [],
}

// Also verbatim, from https://20four7va.breezy.hr/json the same day. Kept because it
// is the only one of the two that carries is_remote: true.
const REAL_REMOTE = {
  id: 'd2ccf5a2f1de',
  friendly_id: 'd2ccf5a2f1de-b-cpt-11236-bilingual-patient-care-coordination-va',
  name: 'B-CPT-11236 Bilingual Patient Care Coordination VA',
  url: 'https://20four7va.breezy.hr/p/d2ccf5a2f1de-b-cpt-11236-bilingual-patient-care-coordination-va',
  published_date: '2026-08-04T17:16:22.584Z',
  type: { id: 'fullTime', name: 'Full-Time' },
  location: {
    country: { id: 'worldwide', name: 'Worldwide' },
    is_remote: true,
    name: 'Worldwide',
    remote_details: { value: 'remote', label: 'Fully remote, no location restrictions' },
  },
  department: 'Telehealth',
  salary: '',
  company: { name: '20four7VA', friendly_id: '20four7va' },
}

test('maps a real Breezy posting into the shared record shape', () => {
  const r = breezy.map(REAL, '75f')
  assert.equal(r.source, 'breezy')
  assert.equal(r.company, '75f')
  assert.equal(r.company_url, 'https://75f.breezy.hr/')
  assert.equal(r.job_id, '9fa69e90edc7')
  assert.equal(r.title, "Is 75F your dream company but you don't see your job? Click here!")
  assert.equal(r.url, REAL.url)
  assert.equal(r.location, 'United States')
  assert.equal(r.employment_type, 'Full-Time')
  assert.equal(r.department, 'Any')
  assert.equal(r.posted_at.slice(0, 10), '2021-09-20')
})

// The board endpoint carries no description at all — the body sits behind a
// per-posting fetch we do not make. An empty column is honest; a title copied into it
// would make one column mean two different things depending on the provider.
test('description is null rather than improvised', () => {
  assert.equal(breezy.map(REAL, '75f').description, null)
})

// The rule the project already paid for twice: Ashby's isRemote is true for Hybrid
// roles and mislabelled two thirds of the feed; Workable's telecommuting was measured
// across 590 postings before it was trusted. Breezy's is_remote has been measured
// against nothing, so it must not reach the workplace column yet.
test('does not trust an unmeasured vendor remote flag', () => {
  const r = breezy.map(REAL_REMOTE, '20four7va')
  assert.equal(r.location, 'Worldwide')
  // "Worldwide" is a location string, not the word remote — the text inference is what
  // decides, and it has no evidence here. The point is only that is_remote did not.
  assert.notEqual(r.workplace, undefined)
  const flagged = breezy.map({ ...REAL_REMOTE, name: 'Coordinator' }, 'x')
  assert.notEqual(flagged.workplace, 'remote', 'is_remote alone must not set the column')
})

// A Breezy board with nothing open answers 200 with `[]`, which is a real verdict
// about the company; the shape must not be confused with a failed fetch.
test('an empty board is a list, not a null', () => {
  assert.deepEqual(breezy.list([]), [])
  assert.equal(breezy.list({ jobs: [] }), null)
})

test('reads the board from the tenant host, which is the one that allows /json', () => {
  assert.equal(breezy.url('75f'), 'https://75f.breezy.hr/json')
})
