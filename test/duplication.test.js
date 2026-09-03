import test from 'node:test'
import assert from 'node:assert/strict'
import { normTitle, normLoc, titleStem, analyseBoard, fanoutOverCache } from '../scripts/duplication.mjs'

test('normLoc treats differently-written forms of one place as one place', () => {
  assert.equal(normLoc('Chicago, IL'), normLoc('IL - Chicago'))
  assert.equal(normLoc('Chicago, IL (Remote)'), normLoc('Chicago, IL'))
  assert.notEqual(normLoc('Chicago, IL'), normLoc('Aurora, IL'))
})

test('normLoc reports an unstated location as empty rather than as a place', () => {
  // A blank location must not collide with another blank and be counted a duplicate.
  assert.equal(normLoc(''), '')
  assert.equal(normLoc('Remote'), '')
  assert.equal(normLoc(null), '')
})

test('same title at different places is multi-site hiring, not duplication', () => {
  const rows = [
    { title: 'Sales Associate', loc: 'Chicago, IL' },
    { title: 'Sales Associate', loc: 'Aurora, IL' },
    { title: 'Sales Associate', loc: 'Peoria, IL' },
  ]
  const a = analyseBoard(rows)
  assert.equal(a.repeated_extra, 2)
  assert.equal(a.same_location_extra, 0)
  assert.equal(a.distinct_location_extra, 2)
})

test('same title at the same place is the defect and is counted as one', () => {
  const rows = [
    { title: 'Sales Associate', loc: 'Chicago, IL' },
    { title: 'Sales Associate', loc: 'IL — Chicago' },
  ]
  const a = analyseBoard(rows)
  assert.equal(a.repeated_extra, 1)
  assert.equal(a.same_location_extra, 1)
  assert.equal(a.distinct_location_extra, 0)
})

test('the three buckets always sum to the repeated-extra count', () => {
  const rows = [
    { title: 'Nurse', loc: 'Leeds' }, { title: 'Nurse', loc: 'Leeds' },
    { title: 'Nurse', loc: 'York' }, { title: 'Nurse', loc: '' },
    { title: 'Chef', loc: 'Leeds' },
  ]
  const a = analyseBoard(rows)
  assert.equal(
    a.same_location_extra + a.distinct_location_extra + a.unstated_location_extra,
    a.repeated_extra,
  )
})

test('titleStem takes the RAW title — normalising first destroys the separators', () => {
  // This is the bug that reported 0% fan-out on a corpus that has 31%.
  assert.equal(titleStem('Sports Data Collector (American Football) - Ames, Iowa, USA'), 'sports data collector')
  assert.equal(titleStem(normTitle('Sports Data Collector (American Football) - Ames, Iowa')), null)
})

test('a title with no separator has no stem and cannot be fan-out', () => {
  assert.equal(titleStem('Software Engineer'), null)
})

test('fan-out needs MIN_FANOUT distinct tails, so a role at two sites is not accused', () => {
  const twoSites = [{ p: 'gh', t: 'b', titles: ['Nurse - Leeds', 'Nurse - York'] }]
  assert.equal(fanoutOverCache(twoSites).fanout_postings, 0)

  const manySites = [{
    p: 'gh',
    t: 'b',
    titles: ['Nurse - Leeds', 'Nurse - York', 'Nurse - Hull', 'Nurse - Bath', 'Nurse - Ely'],
  }]
  assert.equal(fanoutOverCache(manySites).fanout_postings, 5)
})

test('fan-out is measured over every board, not only boards with repeated titles', () => {
  // The whole point: this board has 5 postings, 5 distinct titles, zero title-repeat. A
  // detector ranked by title-repeat would never look at it, and it is one job.
  const board = [{
    p: 'gh',
    t: 'geniussportssn',
    titles: ['Data Collector - Ames, Iowa', 'Data Collector - Athens, Ohio', 'Data Collector - Boise, Idaho',
      'Data Collector - Allen, Texas', 'Data Collector - Boone, NC'],
  }]
  const distinct = new Set(board[0].titles.map(normTitle)).size
  assert.equal(distinct, board[0].titles.length, 'precondition: no repeated titles')
  assert.equal(fanoutOverCache(board).fanout_rate_pct, 100)
})
