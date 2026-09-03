import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normTitle, normLoc, titleStem, titleTail, locTokens,
  classifyFanoutRow, verifyFanoutBoard, analyseBoard, fanoutOverCache,
  buildGazetteer, gazetteerHit,
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

test('a place is a token three different boards independently call a place', () => {
  const gaz = buildGazetteer([
    ['Ames, Iowa', 'Chicago, IL'],
    ['Ames, IA'],
    ['Ames'],
    ['Chicago, IL'],
  ])
  assert.equal(gaz.tokens.has('ames'), true, 'three boards state it')
  assert.equal(gaz.tokens.has('chicago'), false, 'only two boards state it')
  assert.equal(gaz.tokens.has('iowa'), false, 'one board states it')
})

test('a board cannot vouch for its own vocabulary', () => {
  // geniussportssn writes "Statistician Network" in its location column 477 times. Repetition
  // within one board is one board's opinion, so it must not manufacture a place name.
  const gaz = buildGazetteer([
    Array(477).fill('Statistician Network'),
    ['Ames, Iowa'], ['Ames, IA'], ['Ames, MN'],
  ])
  assert.equal(gaz.tokens.has('statistician'), false)
  assert.equal(gaz.tokens.has('network'), false)
  assert.equal(gaz.tokens.has('ames'), true)
})

test('the gazetteer rescues a board whose location field is a department label', () => {
  // The failure mode the field method cannot see, and the reason this exists: the clearest
  // geographic fan-out in the corpus is refuted by its own location column.
  const rows = [
    { title: 'Sports Data Collector - Ames, Iowa', loc: 'Statistician Network' },
    { title: 'Sports Data Collector - Athens, Ohio', loc: 'Statistician Network' },
    { title: 'Sports Data Collector - Boise, Idaho', loc: 'Statistician Network' },
    { title: 'Sports Data Collector - Allen, Texas', loc: 'Statistician Network' },
    { title: 'Sports Data Collector - Boone, NC', loc: 'Statistician Network' },
  ]
  const gaz = buildGazetteer([
    ['Ames, IA', 'Athens, OH', 'Boise, ID', 'Allen, TX', 'Boone, NC'],
    ['Ames, Iowa', 'Athens, Ohio', 'Boise, Idaho', 'Allen, Texas', 'Boone, North Carolina'],
    ['Ames', 'Athens', 'Boise', 'Allen', 'Boone'],
  ])
  const bare = verifyFanoutBoard(rows)
  assert.equal(bare.not_geographic, 5, 'the field refutes all five')
  assert.equal(bare.geographic_upper, bare.geographic_lower, 'with no gazetteer there is one number')

  const v = verifyFanoutBoard(rows, gaz)
  assert.equal(v.geographic_lower, 0, 'the lower bound still believes the field')
  assert.equal(v.geographic_upper, 5, 'the upper bound believes the corpus')
  assert.equal(v.not_geographic, 5, 'the field verdict itself is not rewritten')
})

test('the gazetteer never moves a posting the location field already confirmed', () => {
  const rows = [
    { title: 'Data Collector - Ames, Iowa', loc: 'Ames, IA' },
    { title: 'Data Collector - Athens, Ohio', loc: 'Athens, OH' },
    { title: 'Data Collector - Boise, Idaho', loc: 'Boise, ID' },
    { title: 'Data Collector - Allen, Texas', loc: 'Allen, TX' },
    { title: 'Data Collector - Boone, NC', loc: 'Boone, NC' },
  ]
  const gaz = buildGazetteer([rows.map((r) => r.loc), rows.map((r) => r.loc), rows.map((r) => r.loc)])
  const bare = verifyFanoutBoard(rows)
  const v = verifyFanoutBoard(rows, gaz)
  for (const k of ['fanout_postings', 'geographic', 'not_geographic', 'unstated', 'uninformative']) {
    assert.equal(v[k], bare[k], `${k} is a field verdict and the gazetteer must not touch it`)
  }
  assert.equal(v.geographic_lower, v.geographic_upper, 'nothing is disputed when the field agrees')
})

test('the upper bound leaks on place names that are also ordinary words, by design', () => {
  // "New" is a place token because it is in every "New York" and "New Orleans". A product line
  // called "New Ventures" therefore matches it. This is the gazetteer's error direction and the
  // reason it is published as an upper bound rather than as the answer.
  const gaz = buildGazetteer([
    ['New York, NY'], ['New Orleans, LA'], ['New Haven, CT'],
  ])
  assert.equal(gazetteerHit('Analyst - New Ventures', gaz), 'new')
  assert.equal(gazetteerHit('Analyst - Air Defense', gaz), null)
  assert.equal(gazetteerHit('Analyst', gaz), null, 'no tail, nothing to match')
  assert.equal(gazetteerHit('Analyst - New Ventures', { tokens: new Set() }), null, 'an empty gazetteer claims nothing')
})

test('the two bounds always bracket, and never exceed what the title-only rule flagged', () => {
  const rows = [
    { title: 'Nurse - Leeds', loc: 'Leeds, UK' },
    { title: 'Nurse - York', loc: '' },
    { title: 'Nurse - Band 6', loc: 'Leeds, UK' },
    { title: 'Nurse - Hull', loc: 'Clinical Services' },
    { title: 'Nurse - Remote', loc: 'Bath' },
    { title: 'Nurse - Ely', loc: 'Ely' },
  ]
  const gaz = buildGazetteer([['Leeds', 'York', 'Hull', 'Ely'], ['Leeds', 'York', 'Hull', 'Ely'], ['Leeds', 'York', 'Hull', 'Ely']])
  const v = verifyFanoutBoard(rows, gaz)
  assert.ok(v.geographic_lower <= v.geographic_upper, 'lower <= upper')
  assert.ok(v.geographic_upper <= v.fanout_postings, 'upper <= what was flagged')
  assert.equal(v.geographic + v.not_geographic + v.unstated + v.uninformative, v.fanout_postings)
})

// ---- Title-side counter-evidence (Cycle 29) --------------------------------------------------
// Clearing the location bar is not the same as being a place. The tokens that wrecked the upper
// bound were the ones boards mostly write in TITLES: "home" was stated as a location by 7 boards
// and used in a title tail by 21; "global" 3 against 75. Counting both sides fixes it without
// anybody maintaining a stop-list.

test('a token boards mostly write in titles is not a place token', () => {
  // Three boards write "Home" in their location column, which is enough to clear the old bar.
  // Five boards put it in a title tail. L=3 < T=5, so it is a title word, not a place.
  const locs = [['Home'], ['Home'], ['Home'], ['Ames, IA'], ['Ames, IA'], ['Ames, IA']]
  const titles = [
    ['Nurse - Work From Home'], ['Rep - Home Office'], ['Tech - Home Health'],
    ['Aide - Home Care'], ['Coach - Home Team'], ['Clerk - Ames'],
  ]
  const loose = buildGazetteer(locs)
  const tight = buildGazetteer(locs, titles)
  assert.equal(loose.tokens.has('home'), true, 'the old rule admits it')
  assert.equal(tight.tokens.has('home'), false, 'the title side refutes it')
  assert.equal(tight.rejected.get('home').loc_boards, 3)
  assert.equal(tight.rejected.get('home').tail_boards, 5)
})

test('a real place survives even when boards also fan out to it in their titles', () => {
  // "ames" is written as a location by 4 boards and appears in 2 boards' tails. L >= T, kept.
  const locs = [['Ames, IA'], ['Ames, Iowa'], ['Ames'], ['Ames, IA'], ['Nowhere']]
  const titles = [['Clerk - Ames'], ['Clerk - Ames'], ['Clerk - Payroll'], ['Clerk'], ['Clerk']]
  const gaz = buildGazetteer(locs, titles)
  assert.equal(gaz.tokens.has('ames'), true)
  assert.equal(gaz.rejected.has('ames'), false)
})

test('the tightened rule can drop a real place, and that is its error direction', () => {
  // Measured on the corpus, not hypothetical: "uk" is stated as a location by 31 boards and used
  // in a title tail by 46, so L < T drops it even though it is plainly a place. The old rule
  // over-counted geography; this one can now under-count it. Stated because it is not symmetric
  // with the old error and a reader comparing the two numbers has to know which way each leans.
  const locs = [['London, UK'], ['Leeds, UK'], ['Hull, UK']]
  const titles = [
    ['Nurse - UK Wide'], ['Rep - UK Sales'], ['Tech - UK'], ['Aide - UK Region'],
  ]
  const gaz = buildGazetteer(locs, titles)
  assert.equal(gaz.tokens.has('uk'), false, 'a genuine place, dropped')
  assert.equal(gazetteerHit('Nurse - UK Wide', gaz), null, 'so the upper bound no longer counts it')
})

test('with no titles passed the gazetteer is exactly what it was before', () => {
  // Backward compatibility is the point: every prior published number must still be reproducible.
  const locs = [['Home'], ['Home'], ['Home'], ['Ames, IA'], ['Ames, IA'], ['Ames, IA']]
  const before = buildGazetteer(locs)
  assert.equal(before.tokens.has('home'), true)
  assert.equal(before.tokens.has('ames'), true)
  assert.equal(before.title_evidence, false)
  assert.equal(before.rejected.size, 0, 'nothing can be rejected without counter-evidence')
})

test('a token no board writes in a title tail is unaffected by the new rule', () => {
  // T=0 for every rare city, which is the common case: a board fanning out to 470 towns is one
  // board. So the tightening cannot quietly thin out the long tail of small places.
  const locs = [['Peoria, IL'], ['Peoria, IL'], ['Peoria']]
  const gaz = buildGazetteer(locs, [['Clerk - Payroll'], ['Clerk - Nights'], ['Clerk']])
  assert.equal(gaz.tokens.has('peoria'), true)
  assert.equal(gaz.tails.get('peoria') || 0, 0)
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
