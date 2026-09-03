// node --test test
//
// The robots evaluator decides whether we are permitted to fetch a provider at all, so
// it is the one piece of this repo where being wrong is not a bug but a broken promise.
// It gets tested against the real files we have on record — including the Personio one,
// which is the reason this module exists.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseRobots, groupFor, isAllowed } from '../scripts/lib/robots.mjs'

const UA = 'open-ats-feed'

// Verbatim from the Common Crawl record of 10xfounders.jobs.personio.com/robots.txt,
// crawled 2025-08-06 (CC-MAIN-2025-33). See data/personio-gate.json for the WARC offset.
const PERSONIO = `User-agent: *
Disallow: /xml
Disallow: /search
Disallow: /privacy-policy
Disallow: /apply/*
Disallow: /check-applied/*
Disallow: /thank-you/*
`

test('Personio disallows the exact path its feed is served on', () => {
  const v = isAllowed(PERSONIO, '/xml', UA)
  assert.equal(v.allowed, false)
  assert.match(v.reason, /disallow: \/xml/)
})

test('an absent robots.txt is not the same statement as an allowing one', () => {
  // The trap, stated as a test. RFC 9309 makes a missing file allow-all, so the caller
  // must distinguish "no file" from "a file that permits" — this module only answers
  // the second question, and callers that conflate them get Personio wrong.
  assert.equal(isAllowed('', '/xml', UA).allowed, true)
  assert.equal(isAllowed(PERSONIO, '/xml', UA).allowed, false)
})

test('the paths we actually read on each shipped provider', () => {
  // boards-api.greenhouse.io — we read /v1/boards/, the file names /embed/.
  const greenhouse = 'User-agent: *\nDisallow: /embed/\n'
  assert.equal(isAllowed(greenhouse, '/v1/boards/acme/jobs?content=true', UA).allowed, true)
  assert.equal(isAllowed(greenhouse, '/embed/job_board?for=acme', UA).allowed, false)

  // {token}.breezy.hr — asset directories only; /json is untouched.
  const breezy =
    'User-agent: *\nDisallow: /css\nDisallow: /fonts\nDisallow: /stylesheets\nDisallow: /javascripts\n'
  assert.equal(isAllowed(breezy, '/json', UA).allowed, true)

  // {token}.recruitee.com — /v/ only; we read /api/offers/.
  const recruitee = 'User-agent: *\nDisallow: /v/\n'
  assert.equal(isAllowed(recruitee, '/api/offers/', UA).allowed, true)
  assert.equal(isAllowed(recruitee, '/v/12345', UA).allowed, false)

  // {token}.teamtailor.com — app routes, plus a blanket ban aimed at a named crawler.
  const teamtailor =
    'User-agent: aihitdata\nDisallow: /\n\n' +
    'User-agent: *\nDisallow: /app/\nDisallow: /messages/\nDisallow: /jobs/internal/\n'
  assert.equal(isAllowed(teamtailor, '/jobs.json', UA).allowed, true)
  assert.equal(isAllowed(teamtailor, '/app/settings', UA).allowed, false)
  // We are not aihitdata, so its group does not govern us.
  assert.equal(isAllowed(teamtailor, '/jobs.json', 'aihitdata').allowed, false)
})

test('a blanket Disallow: / refuses us, as SmartRecruiters did', () => {
  const smartrecruiters =
    'User-agent: LinkedInBot\nAllow: /\n\nUser-agent: *\nDisallow: /\n'
  assert.equal(isAllowed(smartrecruiters, '/v1/companies/acme/postings', UA).allowed, false)
  assert.equal(isAllowed(smartrecruiters, '/v1/companies/acme/postings', 'LinkedInBot').allowed, true)
})

test('an empty Disallow permits everything, and is not a ban on the empty path', () => {
  assert.equal(isAllowed('User-agent: *\nDisallow:\n', '/anything', UA).allowed, true)
})

test('longest match wins, and Allow breaks a tie', () => {
  const text = 'User-agent: *\nDisallow: /api/\nAllow: /api/offers/\n'
  assert.equal(isAllowed(text, '/api/offers/', UA).allowed, true)
  assert.equal(isAllowed(text, '/api/internal/', UA).allowed, false)

  const tie = 'User-agent: *\nDisallow: /json\nAllow: /json\n'
  assert.equal(isAllowed(tie, '/json', UA).allowed, true)
})

test('wildcards and end-anchors', () => {
  assert.equal(isAllowed('User-agent: *\nDisallow: /apply/*\n', '/apply/123', UA).allowed, false)
  assert.equal(isAllowed('User-agent: *\nDisallow: /*.json$\n', '/jobs.json', UA).allowed, false)
  assert.equal(isAllowed('User-agent: *\nDisallow: /*.json$\n', '/jobs.json?x=1', UA).allowed, true)
  assert.equal(isAllowed('User-agent: *\nDisallow: /*/internal\n', '/jobs/internal', UA).allowed, false)
})

test('group selection prefers a named agent over the wildcard', () => {
  const text = `User-agent: *\nDisallow: /\n\nUser-agent: open-ats-feed\nAllow: /\n`
  assert.equal(isAllowed(text, '/v1/boards/acme/jobs', UA).allowed, true)
  assert.equal(isAllowed(text, '/v1/boards/acme/jobs', 'SomeOtherBot').allowed, false)
})

test('consecutive user-agent lines share one group', () => {
  const groups = parseRobots('User-agent: a\nUser-agent: b\nDisallow: /x\n')
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].agents, ['a', 'b'])

  const g = groupFor(groups, 'b-crawler/1.0')
  assert.ok(g)
  assert.equal(g.rules[0].path, '/x')
})

test('rules before any user-agent line belong to no group', () => {
  // A stray leading Disallow must not silently become a global ban.
  assert.equal(isAllowed('Disallow: /\n\nUser-agent: *\nDisallow: /x\n', '/json', UA).allowed, true)
})

test('comments and Sitemap lines are ignored', () => {
  const text = 'Sitemap: https://x/sitemap.xml\nUser-agent: *  # everyone\nDisallow: /x # nope\n'
  assert.equal(isAllowed(text, '/x', UA).allowed, false)
  assert.equal(isAllowed(text, '/y', UA).allowed, true)
})
