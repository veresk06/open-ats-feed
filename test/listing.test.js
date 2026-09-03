import { deepStrictEqual } from 'node:assert/strict'
import { test } from 'node:test'

import { staleListingFields } from '../scripts/lib/listing.mjs'

const SHIPPED = ['Greenhouse', 'Ashby', 'Lever', 'Breezy', 'Recruitee', 'Teamtailor']
const opts = { rosterText: '18,164', providers: SHIPPED }

// Verbatim from the Actor record on 2026-09-03, before Cycle 43 corrected it. The roster had
// been 18,164 for a cycle and six providers for far longer; this is what a buyer was reading.
const STALE = {
  title: 'Open ATS Jobs Feed — Greenhouse, Ashby, Lever',
  description:
    '10,197 verified company boards on Greenhouse, Ashby and Lever, via their official public ' +
    'APIs. Normalised postings with salary, seniority and workplace — or one row per company: ' +
    'who is ramping, which functions just opened. Rows that are not jobs — MLM ads, unpaid ' +
    'listings — are filtered.',
  seoTitle: 'Job Postings API — Greenhouse, Ashby & Lever Boards Scraper',
  seoDescription:
    'Job postings and hiring signals from 10,197 company boards on Greenhouse, Ashby and Lever ' +
    'via official public APIs. MLM recruitment ads and unpaid volunteer listings filtered out ' +
    'by default.',
}

// Verbatim from the Actor record after the correction.
const CURRENT = {
  title: 'Open ATS Jobs Feed — Greenhouse, Ashby, Lever & 3 More',
  description:
    '18,164 verified company boards on Greenhouse, Ashby, Lever, Breezy, Recruitee and ' +
    'Teamtailor, via their official public APIs. Normalised postings with salary, seniority ' +
    'and workplace — or one row per company: who is ramping and which functions just opened. ' +
    'MLM ads and unpaid listings filtered.',
  seoTitle: 'Job Postings API — 6 ATS Boards, 18,164 Companies',
  seoDescription:
    'Job postings and hiring signals from 18,164 verified company boards across six ATS ' +
    'platforms, via their official public APIs. MLM recruitment ads and unpaid volunteer ' +
    'listings filtered out.',
}

test('catches every field of the listing that sat stale for thirty-five cycles', () => {
  deepStrictEqual(staleListingFields(STALE, opts), [
    'title',
    'description',
    'seoTitle',
    'seoDescription',
  ])
})

test('passes the corrected listing', () => {
  deepStrictEqual(staleListingFields(CURRENT, opts), [])
})

test('a stale count alone is enough, even with every provider named', () => {
  const record = { ...CURRENT, description: CURRENT.description.replace('18,164', '16,361') }
  deepStrictEqual(staleListingFields(record, opts), ['description'])
})

test('a title that drops three providers is stale even though titles carry no count', () => {
  const record = { ...CURRENT, title: 'Open ATS Jobs Feed — Greenhouse, Ashby, Lever' }
  deepStrictEqual(staleListingFields(record, opts), ['title'])
})

test('"six platforms" and "6 ATS" are accepted as naming the full set', () => {
  const record = {
    ...CURRENT,
    title: 'Open ATS Jobs Feed — 6 ATS platforms',
    seoTitle: 'Job postings from six ATS platforms',
  }
  deepStrictEqual(staleListingFields(record, opts), [])
})

test('a title naming no provider at all makes no claim to be wrong about', () => {
  const record = { ...CURRENT, title: 'Open ATS Jobs Feed' }
  deepStrictEqual(staleListingFields(record, opts), [])
})

test('a missing record field is treated as stale on the two counted fields', () => {
  deepStrictEqual(staleListingFields({}, opts), ['description', 'seoDescription'])
})
