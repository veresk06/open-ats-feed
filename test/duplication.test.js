import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normTitle, normLoc, titleStem, titleTail, locTokens,
  classifyFanoutRow, verifyFanoutBoard, analyseBoard, fanoutOverCache,
} from '../scripts/duplication.mjs'

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

test('titleTail is everything after the first separator, and it is what names the place', () => {
  assert.equal(titleTail('Sports Data Collector (American Football) - Ames, Iowa, USA'), 'american football ames iowa usa')
  assert.equal(titleTail('Software Engineer'), null)
})

test('a fan-out tail that names the posting own location is geographic', () => {
  assert.equal(classifyFanoutRow('Data Collector - Ames, Iowa', 'Ames, IA'), 'geographic')
  assert.equal(classifyFanoutRow('Researcher - Berlin', 'Berlin, Germany'), 'geographic')
})

test('a fan-out tail that names a product or a team is NOT geographic', () => {
  // The two false positives Cycle 24 found by hand-auditing the eight largest stems. This is
  // the class the title-only rule could not tell from a city, and the location field can.
  assert.equal(classifyFanoutRow('Senior Engineer - AI Neobank App', 'Kuala Lumpur, Malaysia'), 'not_geographic')
  assert.equal(classifyFanoutRow('Software Engineer - Air Defense', 'Costa Mesa, CA'), 'not_geographic')
})

test('a posting with no stated location cannot testify either way', () => {
  assert.equal(classifyFanoutRow('Data Collector - Ames, Iowa', ''), 'unstated')
  assert.equal(classifyFanoutRow('Data Collector - Ames, Iowa', 'Remote'), 'unstated')
})

test('a tail made only of noise words is uninformative, not evidence against geography', () => {
  // "Engineer - Remote" must not be counted as a product tail. It says nothing.
  assert.equal(classifyFanoutRow('Engineer - Remote, USA', 'Chicago, IL'), 'uninformative')
  assert.equal(classifyFanoutRow('Engineer', 'Chicago, IL'), 'uninformative')
})

test('locTokens drops the noise words that appear on one copy and not the other', () => {
  assert.deepEqual([...locTokens('Chicago, IL (Remote)')].sort(), ['chicago', 'il'])
  assert.equal(locTokens('Remote').size, 0)
  assert.equal(normLoc('Chicago, IL'), [...locTokens('Chicago, IL')].sort().join(' '))
})

test('verifyFanoutBoard splits a fan-out board into geographic and not, by the location field', () => {
  const rows = [
    { title: 'Data Collector - Ames, Iowa', loc: 'Ames, IA' },
    { title: 'Data Collector - Athens, Ohio', loc: 'Athens, OH' },
    { title: 'Data Collector - Boise, Idaho', loc: 'Boise, ID' },
    { title: 'Data Collector - Allen, Texas', loc: 'Allen, TX' },
    { title: 'Data Collector - Boone, NC', loc: 'Boone, NC' },
    { title: 'Engineer - Air Defense', loc: 'Costa Mesa, CA' },
    { title: 'Engineer - Space Systems', loc: 'Costa Mesa, CA' },
    { title: 'Engineer - Maritime', loc: 'Costa Mesa, CA' },
    { title: 'Engineer - Counter UAS', loc: 'Costa Mesa, CA' },
    { title: 'Engineer - Autonomy', loc: 'Costa Mesa, CA' },
  ]
  const v = verifyFanoutBoard(rows)
  assert.equal(v.fanout_postings, 10, 'title-only rule flags all ten')
  assert.equal(v.geographic, 5)
  assert.equal(v.not_geographic, 5)
  assert.equal(v.stems_geographic, 1)
  assert.equal(v.stems_not_geographic, 1)
})

test('the verified buckets always sum to the postings the title-only rule flagged', () => {
  const rows = [
    { title: 'Nurse - Leeds', loc: 'Leeds, UK' },
    { title: 'Nurse - York', loc: '' },
    { title: 'Nurse - Band 6', loc: 'Leeds, UK' },
    { title: 'Nurse - Hull', loc: 'Hull' },
    { title: 'Nurse - Remote', loc: 'Bath' },
    { title: 'Nurse - Ely', loc: 'Ely' },
  ]
  const v = verifyFanoutBoard(rows)
  assert.equal(v.geographic + v.not_geographic + v.unstated + v.uninformative, v.fanout_postings)
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
