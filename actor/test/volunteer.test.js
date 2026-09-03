import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isVolunteerListing } from '../src/volunteer.js'

// Same standard as recruitment-ads.test.js: the positives below are verbatim titles read off
// live Greenhouse boards on 2026-09-03, not invented ones.

test('flags the unpaid listings actually found in the corpus', () => {
  for (const title of [
    'Hospice Volunteer (Unpaid)',
    'Hospice Volunteer-OFFICE (Unpaid)',
    'Private Equity Event Volunteer',
    'Event Assistant (volunteer)',
    'Conference Coordinator Volunteer',
    'Volunteer Team Member',
  ]) {
    assert.equal(isVolunteerListing({ title }), true, title)
  }
})

// The class this filter exists to survive. These are salaried positions that happen to be about
// volunteers, and dropping them from a paid-jobs feed would be the opposite of the point. None
// occurs in the 121,050 titles measured — the guard is here for scale, not for the sample.
test('keeps paid roles that manage volunteers', () => {
  for (const title of [
    'Volunteer Services Manager',
    'Director of Volunteer Engagement',
    'Volunteer Coordinator',
    'Volunteer Programs Specialist',
    'Manager of Volunteer Relations',
  ]) {
    assert.equal(isVolunteerListing({ title }), false, title)
  }
})

// 'pro bono' was dropped from the phrase list: 0 hits in the corpus, and Pro Bono Counsel is a
// salaried law-firm role. Pinned so it does not get added back without the audit being redone.
test('does not flag pro bono roles, which are salaried at law firms', () => {
  assert.equal(isVolunteerListing({ title: 'Pro Bono Counsel' }), false)
  assert.equal(isVolunteerListing({ title: 'Pro Bono Program Manager' }), false)
})

test('leaves ordinary postings alone, and survives missing titles', () => {
  for (const title of ['Senior Software Engineer', 'Registered Nurse', 'Warehouse Associate']) {
    assert.equal(isVolunteerListing({ title }), false, title)
  }
  assert.equal(isVolunteerListing({}), false)
  assert.equal(isVolunteerListing({ title: null }), false)
  assert.equal(isVolunteerListing({ title: '' }), false)
  // Normalised the same way the census normalises, so punctuation and casing still match.
  assert.equal(isVolunteerListing({ title: 'EVENT HELPER — (VOLUNTEER)' }), true)
})
