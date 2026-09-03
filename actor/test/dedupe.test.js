import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normTitle, normLoc, dedupeKey, dedupeBoardRows } from '../src/dedupe.js'

const row = (title, location, extra = {}) => ({ title, location, ...extra })

// ---- the key ---------------------------------------------------------------------------------

test('two spellings of one place produce one key', () => {
  assert.equal(normLoc('Chicago, IL'), normLoc('IL - Chicago'))
  assert.equal(normLoc('Remote - Chicago, IL'), normLoc('Chicago, IL'))
  assert.equal(normLoc('New York, NY, USA'), normLoc('NY / New York'))
})

test('two different places do not', () => {
  assert.notEqual(normLoc('Chicago, IL'), normLoc('Aurora, IL'))
  assert.notEqual(normLoc('Berlin'), normLoc('Munich'))
})

test('titles differing only by punctuation or case are one title', () => {
  assert.equal(normTitle('Senior Engineer  '), normTitle('senior engineer'))
  assert.equal(normTitle('Engineer – Backend'), normTitle('Engineer - Backend'))
})

// The single most important conservatism in the rule. Roughly a fifth of the corpus states no
// location; if "unstated" collapsed with "unstated" this filter would delete real jobs in bulk.
test('a posting with no stated location is never a dedupe candidate', () => {
  assert.equal(dedupeKey(row('Sales Associate', '')), null)
  assert.equal(dedupeKey(row('Sales Associate', null)), null)
  // A location made only of noise words states no place either.
  assert.equal(dedupeKey(row('Sales Associate', 'Remote')), null)
  assert.equal(dedupeKey(row('Sales Associate', 'Multiple Locations')), null)
})

test('a posting with no title is never a dedupe candidate', () => {
  assert.equal(dedupeKey(row('', 'Chicago, IL')), null)
})

// ---- the collapse ----------------------------------------------------------------------------

test('same title, same stated location collapses to one row', () => {
  const { rows, merged } = dedupeBoardRows([
    row('Sales Associate', 'Chicago, IL', { job_id: 'a' }),
    row('Sales Associate', 'IL - Chicago', { job_id: 'b' }),
    row('Sales Associate', 'Chicago, IL', { job_id: 'c' }),
  ])
  assert.equal(rows.length, 1)
  assert.equal(merged, 2)
  assert.equal(rows[0].job_id, 'a', 'first copy wins')
  assert.equal(rows[0].duplicates_merged, 2)
})

// The population the filter must NOT touch, and the reason Cycle 26 refused to publish the
// title-only 40.29% as a duplication rate.
test('same title, different location is real multi-site hiring and is kept', () => {
  const { rows, merged } = dedupeBoardRows([
    row('Sales Associate', 'Chicago, IL'),
    row('Sales Associate', 'Aurora, IL'),
    row('Sales Associate', 'Naperville, IL'),
  ])
  assert.equal(rows.length, 3)
  assert.equal(merged, 0)
  assert.deepEqual(rows.map((r) => r.duplicates_merged), [0, 0, 0])
})

test('same location, different title is kept', () => {
  const { rows, merged } = dedupeBoardRows([
    row('Sales Associate', 'Chicago, IL'),
    row('Store Manager', 'Chicago, IL'),
  ])
  assert.equal(rows.length, 2)
  assert.equal(merged, 0)
})

test('rows with no stated location all survive, however many there are', () => {
  const { rows, merged } = dedupeBoardRows([
    row('Sales Associate', ''),
    row('Sales Associate', ''),
    row('Sales Associate', 'Remote'),
  ])
  assert.equal(rows.length, 3)
  assert.equal(merged, 0)
})

// `apply: false` is how RUN_STATS reports the count on a run that did not ask for the filter.
// The rows must come back untouched — not merely equal in length, but unannotated, because a
// buyer who left the flag off should not find a field they did not ask for in their CSV.
test('apply:false counts what it would have taken and changes nothing', () => {
  const input = [
    row('Sales Associate', 'Chicago, IL'),
    row('Sales Associate', 'Chicago, IL'),
    row('Sales Associate', 'Aurora, IL'),
  ]
  const { rows, merged } = dedupeBoardRows(input, { apply: false })
  assert.equal(merged, 1)
  assert.equal(rows.length, 3)
  assert.equal(rows, input)
  for (const r of rows) assert.equal('duplicates_merged' in r, false)
})

test('annotate:false collapses without adding the field', () => {
  const { rows, merged } = dedupeBoardRows([
    row('Sales Associate', 'Chicago, IL'),
    row('Sales Associate', 'Chicago, IL'),
  ], { annotate: false })
  assert.equal(rows.length, 1)
  assert.equal(merged, 1)
  assert.equal('duplicates_merged' in rows[0], false)
})

test('an empty board is not a special case', () => {
  const { rows, merged } = dedupeBoardRows([])
  assert.deepEqual(rows, [])
  assert.equal(merged, 0)
})

// ---- the rule must stay identical to the audit that produced the published number -------------
//
// scripts/duplication.mjs measured 4,374 same-title-same-location postings across the 40 worst
// boards. If the Actor's rule drifts from the audit's rule, that number stops describing this
// filter. The Actor image is standalone and cannot import from scripts/, so the guard is a
// re-derivation of the audit's arithmetic: for one title group, the audit's `same` counter is
// exactly the number of rows this function removes.
test('agrees with the audit arithmetic on a title group', () => {
  const locs = ['Chicago, IL', 'Chicago, IL', 'Aurora, IL', '', '', 'IL - Chicago']
  const rows = locs.map((l) => row('Sales Associate', l))

  // The audit: group by title, count a location already seen as `same`, skip blanks.
  const seen = new Set()
  let same = 0
  for (const l of locs) {
    const k = normLoc(l)
    if (!k) continue
    if (seen.has(k)) same++
    else seen.add(k)
  }

  assert.equal(dedupeBoardRows(rows, { apply: false }).merged, same)
  assert.equal(same, 2)
})
