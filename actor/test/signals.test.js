// node --test actor/test
//
// The signal classifier is the part of this Actor a buyer will trust or not trust,
// and it is pure, so it gets tested against fixed dates rather than against
// whatever the boards happen to look like today.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { companySignal, techIn } from '../src/signals.js'

const NOW = Date.parse('2026-09-03T00:00:00.000Z')
const DAY = 86_400_000
const ago = (d) => new Date(NOW - d * DAY).toISOString()

const META = {
  provider: 'greenhouse',
  token: 'acme',
  company_url: 'https://job-boards.greenhouse.io/acme',
  index_as_of: '2026-09-03',
  fetched_at: new Date(NOW).toISOString(),
  now: NOW,
}

function post(daysAgo, extra = {}) {
  return {
    title: 'Backend Engineer',
    department: 'Engineering',
    team: null,
    workplace: 'onsite',
    seniority: 'mid',
    salary_min: null,
    posted_at: daysAgo === null ? null : ago(daysAgo),
    ...extra,
  }
}

const sig = (rows) => companySignal(rows, META)

test('an empty board produces no record at all', () => {
  assert.equal(sig([]), null)
})

test('ramping: the last 30 days at more than twice the prior pace', () => {
  // 2 roles across the prior 60 days -> a baseline of 1 per 30 days; 6 in the last 30.
  const rows = [post(70), post(50), ...Array.from({ length: 6 }, (_, i) => post(i + 1))]
  const s = sig(rows)
  assert.equal(s.signal, 'ramping')
  assert.equal(s.opened_30d, 6)
  assert.equal(s.baseline_30d, 1)
  assert.equal(s.ramp_ratio, 6)
  assert.equal(s.open_postings, 8)
  assert.equal(s.postings_dated, 8)
})

test('steady: hiring, but not faster than it was', () => {
  const rows = [...Array.from({ length: 10 }, (_, i) => post(35 + i * 10)), post(5)]
  const s = sig(rows)
  assert.equal(s.signal, 'steady')
  assert.equal(s.opened_30d, 1)
  assert.ok(s.ramp_ratio < 2)
})

test('quiet: roles are open but nothing was opened in 30 days', () => {
  const s = sig([post(120), post(200), post(45)])
  assert.equal(s.signal, 'quiet')
  assert.equal(s.opened_30d, 0)
})

test('a brand new board is new_board, not an infinite ramp', () => {
  const s = sig([post(10), post(12), post(20), post(40)])
  assert.equal(s.signal, 'new_board')
  assert.equal(s.oldest_posting_at, ago(40))
})

test('no prior baseline on an old board reports ramping with a null ratio, never a division by zero', () => {
  // One role from 200 days ago, then a burst — the 30-90 day window is empty.
  const s = sig([post(200), post(3), post(4), post(5)])
  assert.equal(s.baseline_30d, 0)
  assert.equal(s.ramp_ratio, null)
  assert.equal(s.signal, 'ramping')
})

test('a board whose vendor published no dates is undated, not quiet', () => {
  const s = sig([post(null), post(null)])
  assert.equal(s.signal, 'undated')
  assert.equal(s.postings_dated, 0)
  assert.equal(s.open_postings, 2)
  assert.equal(s.oldest_posting_at, null)
})

test('a function that opened this month at a company with older history', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => post(100 + i)),
    post(10, { department: 'Sales', title: 'Account Executive' }),
    post(12, { department: 'Sales', title: 'Account Executive' }),
  ]
  const s = sig(rows)
  assert.deepEqual(s.new_functions, [{ name: 'Sales', count: 2 }])
  assert.deepEqual(s.top_titles[0], { name: 'Backend Engineer', count: 5 })
})

test('a single role in a department is not a newly opened function', () => {
  const rows = [...Array.from({ length: 5 }, (_, i) => post(100 + i)), post(10, { department: 'Sales' })]
  assert.deepEqual(sig(rows).new_functions, [])
})

test('a board that uses department as a site code reports no functions at all', () => {
  // BAYADA's live board carries ~200 departments like "Baltimore Visits (BV) - 94".
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => post(100 + i)),
    ...Array.from({ length: 30 }, (_, i) => post(10, { department: `Region ${i}` })),
    ...Array.from({ length: 30 }, (_, i) => post(11, { department: `Region ${i}` })),
  ]
  assert.deepEqual(sig(rows).new_functions, [])
})

test('a new company does not report every department as newly opened', () => {
  const rows = [post(5), post(6, { department: 'Sales' }), post(7, { department: 'Marketing' })]
  assert.deepEqual(sig(rows).new_functions, [])
})

test('a long-running department is not reported as newly opened', () => {
  const rows = Array.from({ length: 6 }, (_, i) => post(10 + i * 30))
  assert.deepEqual(sig(rows).new_functions, [])
})

test('technology detection refuses the ambiguous cases', () => {
  assert.deepEqual(techIn('Senior Rust Engineer'), ['Rust'])
  assert.deepEqual(techIn('Go-To-Market Manager'), [])
  assert.deepEqual(techIn('Java Developer'), ['Java'])
  assert.deepEqual(techIn('JavaScript Developer'), ['JavaScript'])
  assert.ok(techIn('Analytics Engineer (dbt, Snowflake)').includes('Snowflake'))
})

test('acronyms that belong to another industry do not count outside a technical role', () => {
  // Both of these came off BAYADA's live board, a home-care company.
  assert.deepEqual(techIn('DBT Clinician - Partial Hospitalization Program (PHP)'), [])
  assert.deepEqual(techIn('Registered Nurse, PHP/IOP'), [])
  assert.ok(techIn('Analytics Engineer, dbt and Airflow').includes('dbt'))
  assert.ok(techIn('Senior PHP Developer').includes('PHP'))
  // Rust the language, not rust the corrosion.
  assert.deepEqual(techIn('Painter — surface preparation and rust removal'), [])
})

test('a technology named only inside a URL is not a technology', () => {
  // Both of these are verbatim from BAYADA's live board, and between them they
  // are the whole reason a home-care company appeared to be hiring for a
  // Microsoft stack: a HubSpot CDN link and a Facebook emoji image.
  const nurse = 'Home Care Nurse'
  const share =
    '<img src="//cdn2.hubspot.net/hubfs/201792/Social.png"> ' +
    '<img src="//static.xx.fbcdn.net/images/emoji.php/v9/t39/1/16/1f4e2.png">'
  assert.deepEqual(techIn(`${nurse} ${share}`, nurse), [])
  // And the same terms still count when a posting genuinely names them.
  const dev = 'Senior Software Engineer'
  const real = techIn(`${dev} Maintain our ASP.NET services and a legacy PHP admin tool.`, dev)
  assert.ok(real.includes('.NET'))
  assert.ok(real.includes('PHP'))
})

test('the guard reads the title, not the description', () => {
  // A description long enough to be useful nearly always says "data" or
  // "technical" somewhere, so a guard applied to the whole text passes for
  // practically every posting and stops being a guard.
  const description = 'Document each visit in our clinical data system. PHP/IOP caseload.'
  assert.deepEqual(techIn(`Registered Nurse ${description}`, 'Registered Nurse'), [])
  assert.ok(techIn(`Data Engineer ${description}`, 'Data Engineer').includes('PHP'))
  // One argument still guards on that argument, as the earlier callers assume.
  assert.deepEqual(techIn('Registered Nurse, PHP/IOP'), [])
})

test('bare "rails" is not Ruby on Rails', () => {
  // Both live: a construction-equipment board and a fintech board.
  assert.deepEqual(techIn('Trench Safety Specialist — bedding boxes, safety rails, trench ladders'), [])
  const fintech = 'Technical Product Lead'
  assert.deepEqual(techIn(`${fintech} licensing, compliance, and third-party rails are core`, fintech), [])
  assert.ok(techIn('Senior Ruby on Rails Engineer').includes('Rails'))
})

test('a department that names a place is not a function', () => {
  const rows = [
    post(5, { department: 'North San Diego, CA' }),
    post(6, { department: 'North San Diego, CA' }),
    post(300, { department: 'Clinical' }),
    post(301, { department: 'Clinical' }),
  ]
  assert.deepEqual(sig(rows).new_functions, [])
})

test('technologies are counted over the last 90 days only', () => {
  const rows = [post(200, { title: 'Rust Engineer' }), post(10, { title: 'Snowflake Data Engineer' }), post(11, { title: 'Snowflake Analyst' })]
  const s = sig(rows)
  assert.deepEqual(s.tech_signals, [{ name: 'Snowflake', count: 2 }])
})

test('executive openings are counted from the inferred seniority', () => {
  const rows = [post(5, { title: 'VP of Sales', seniority: 'executive' }), post(300, { title: 'Head of Ops', seniority: 'executive' }), post(6)]
  assert.equal(sig(rows).executive_openings_90d, 1)
})

test('remote and salary counts describe the board as it stands, not a window', () => {
  const rows = [post(5, { workplace: 'remote', salary_min: 100000 }), post(300, { workplace: 'remote' }), post(6)]
  const s = sig(rows)
  assert.equal(s.remote_postings, 2)
  assert.equal(s.postings_with_salary, 1)
})
