import { test } from 'node:test'
import assert from 'node:assert/strict'

import { boardCounts, predict, isRole, junkShare, MAX_NOT_JOB_SHARE } from '../scripts/board-prior.mjs'
import { classify } from '../scripts/role-census.mjs'

test('the prior only ever predicts a real role family', () => {
  // A board prior that can output `other` or `non_english` resolves nothing, and one that can
  // output `suspect_recruitment_ad` would widen an audited quality filter by inference.
  for (const f of ['suspect_recruitment_ad', 'volunteer_unpaid', 'unclassifiable_generic', 'other', 'non_english']) {
    assert.equal(isRole(f), false, `${f} must not be predictable`)
  }
  for (const f of ['engineering', 'healthcare', 'corporate', 'fitness_wellness']) {
    assert.equal(isRole(f), true)
  }
  // The counts a prediction is drawn from must already be free of them.
  const counts = boardCounts(['engineering', 'other', 'other', 'other', 'non_english', 'unclassifiable_generic'])
  assert.deepEqual([...counts.keys()], ['engineering'])
  assert.equal(predict(counts).family, 'engineering')
})

test('predict reports support and confidence over role titles only', () => {
  const counts = boardCounts([
    'engineering', 'engineering', 'engineering', 'corporate',
    'other', 'unclassifiable_generic', 'unclassifiable_generic',
  ])
  const p = predict(counts)
  assert.equal(p.family, 'engineering')
  // 4 role titles, not 7 — the generic and unmatched ones are what we are trying to resolve and
  // must not inflate the confidence used to decide whether the prior is trustworthy.
  assert.equal(p.support, 4)
  assert.equal(p.confidence, 0.75)
})

test('leave-one-out omits exactly one observation', () => {
  const counts = boardCounts(['engineering', 'engineering', 'corporate'])
  assert.equal(predict(counts).support, 3)
  const loo = predict(counts, 'engineering')
  assert.equal(loo.support, 2)
  // 1 engineering vs 1 corporate after the omission — the tie breaks by name, deterministically,
  // so the published numbers are reproducible from the corpus alone.
  assert.equal(loo.family, 'corporate')
})

test('a board with no role titles yields no prior rather than a default', () => {
  assert.equal(predict(boardCounts(['other', 'unclassifiable_generic', 'non_english'])), null)
  // And omitting the only observation must not produce a zero-support prediction.
  assert.equal(predict(boardCounts(['engineering']), 'engineering'), null)
})

test('junkShare counts both not-a-job labels and gates on the published threshold', () => {
  assert.equal(junkShare([]), 0)
  assert.equal(junkShare(['engineering', 'corporate']), 0)
  assert.equal(junkShare(['suspect_recruitment_ad', 'volunteer_unpaid', 'engineering', 'corporate']), 0.5)
  // lever/globalelitecareers is 78.8% not-a-job; it must be refused a prior so its 97 copies of
  // "Benefits Services Representative - Remote" are not stamped `corporate` by inference.
  assert.ok(0.788 >= MAX_NOT_JOB_SHARE)
  // A board with one volunteer listing in 100 real postings must still get its prior.
  assert.ok(junkShare(['volunteer_unpaid', ...Array(99).fill('healthcare')]) < MAX_NOT_JOB_SHARE)
})

test('fitness instructors are no longer counted as education', () => {
  // Regression pin for the ordering bug the board prior surfaced: `instructor` is an `education`
  // key and `education` was ordered before `fitness_wellness`, so all 194 of these read as
  // education — 11.5% of that family.
  assert.equal(classify('Group Fitness Instructor'), 'fitness_wellness')
  assert.equal(classify('Pilates Reformer Instructor'), 'fitness_wellness')
  assert.equal(classify('Yoga Instructor - Austin, TX'), 'fitness_wellness')
  assert.equal(classify('Substitute Group Fitness Instructor'), 'fitness_wellness')
  // The fix must stay narrow. Real teaching keeps its family, and a school swim teacher is why
  // 'swim instructor' was deliberately left out of the fitness list.
  assert.equal(classify('Math Instructor'), 'education')
  assert.equal(classify('Swim Instructor'), 'education')
  assert.equal(classify('Adjunct Instructor, Biology'), 'education')
})
