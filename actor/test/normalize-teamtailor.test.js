import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROVIDERS } from '../src/normalize.js'

const teamtailor = PROVIDERS.teamtailor

// Verbatim from https://hemnet.teamtailor.com/jobs.json on 2026-09-03, with
// content_html truncated. Teamtailor serves a JSON Feed, and each item carries a
// schema.org JobPosting under `_jobposting` — which is where the location lives.
const REAL = {
  id: '7d5bfccb-034a-48cc-84cf-4436ff5dfb34',
  title: 'Analytics Implementation Specialist',
  url: 'https://hemnet.teamtailor.com/jobs/7773812-analytics-implementation-specialist',
  date_published: '2026-05-21T12:41:19+02:00',
  content_html: '<p>We are looking for an <strong>Analytics Implementation Specialist</strong>.</p>',
  _jobposting: {
    '@context': 'http://schema.org/',
    '@type': 'JobPosting',
    title: 'Analytics Implementation Specialist',
    datePosted: '2026-05-21T12:41:19+02:00',
    validThrough: null,
    employmentType: null,
    baseSalary: null,
    jobLocationType: null,
    hiringOrganization: { '@type': 'Organization', name: 'Hemnet' },
    jobLocation: [
      {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          streetAddress: 'Sveavägen 9',
          addressLocality: 'Stockholm',
          postalCode: '111 57',
          addressCountry: 'SE',
          addressRegion: null,
        },
      },
    ],
  },
}

test('maps a real Teamtailor posting into the shared record shape', () => {
  const r = teamtailor.map(REAL, 'hemnet')
  assert.equal(r.source, 'teamtailor')
  assert.equal(r.company, 'hemnet')
  assert.equal(r.company_url, 'https://hemnet.teamtailor.com/')
  assert.equal(r.job_id, '7d5bfccb-034a-48cc-84cf-4436ff5dfb34')
  assert.equal(r.title, 'Analytics Implementation Specialist')
  assert.equal(r.url, REAL.url)
  assert.equal(r.location, 'Stockholm, SE')
  assert.equal(r.posted_at.slice(0, 10), '2026-05-21')
  assert.equal(r.employment_type, null)
})

// `company` is the harvested token on every provider, including the ones that also
// publish a display name. Breezy ships company.name and Teamtailor ships
// hiringOrganization.name; neither reaches the column, because the token is the thing
// the row can be re-fetched by and the display name is not.
test('company is the token, not the hiring organisation name', () => {
  assert.equal(teamtailor.map(REAL, 'hemnet').company, 'hemnet')
})

test('carries the posting body, stripped of markup', () => {
  const r = teamtailor.map(REAL, 'hemnet')
  assert.equal(r.description, 'We are looking for an Analytics Implementation Specialist .')
})

// jobLocationType is schema.org vocabulary, but in practice it is "TELECOMMUTE" or
// absent — it cannot express hybrid, which makes it the same shape of flag as Ashby's
// isRemote rather than the same shape as Ashby's three-valued workplaceType. Believing
// that flag once classified two thirds of the feed as remote, wrong by ~3x. Unmeasured
// here, so the column comes from the text.
test('does not trust jobLocationType', () => {
  const tagged = {
    ...REAL,
    _jobposting: { ...REAL._jobposting, jobLocationType: 'TELECOMMUTE' },
  }
  assert.equal(teamtailor.map(tagged, 'hemnet').workplace, 'onsite')
})

test('reads workplace from the text', () => {
  const hybrid = { ...REAL, title: 'Analytics Specialist (Hybrid)' }
  assert.equal(teamtailor.map(hybrid, 'hemnet').workplace, 'hybrid')

  const remote = { ...REAL, title: 'Remote Analytics Specialist' }
  assert.equal(teamtailor.map(remote, 'hemnet').workplace, 'remote')
})

// A posting with no _jobposting at all must map rather than throw. It is the only part
// of the record we do not control and the feed spec does not require it.
test('survives a missing _jobposting block', () => {
  const bare = { id: 'x', title: 'Engineer', url: 'https://a.teamtailor.com/jobs/1', date_published: '2026-01-02T00:00:00+00:00' }
  const r = teamtailor.map(bare, 'a')
  assert.equal(r.location, null)
  assert.equal(r.department, null)
  assert.equal(r.employment_type, null)
  assert.equal(r.posted_at.slice(0, 10), '2026-01-02')
})

test('reads the item list off the items key', () => {
  assert.deepEqual(teamtailor.list({ items: [REAL] }), [REAL])
  assert.equal(teamtailor.list({ items: null }), null)
  assert.equal(teamtailor.list([]), null)
})

test('addresses a board by subdomain, and encodes the token', () => {
  assert.equal(teamtailor.url('acme'), 'https://acme.teamtailor.com/jobs.json')
  assert.equal(teamtailor.url('a b'), 'https://a%20b.teamtailor.com/jobs.json')
})
