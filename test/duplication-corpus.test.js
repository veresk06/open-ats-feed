import test from 'node:test'
import assert from 'node:assert/strict'
import {
  STRATA, parseRoster, pickSample, buildPlan, stratumRate, combine, bootstrap, lcg,
} from '../scripts/duplication-corpus.mjs'
import { analyseBoard } from '../scripts/duplication.mjs'

const roster = (n, postings) => Array.from({ length: n }, (_, i) => ({
  provider: 'greenhouse', token: `b${i}`, postings: typeof postings === 'function' ? postings(i) : postings,
}))

test('parseRoster reads the roster CSV and drops what cannot be counted', () => {
  const csv = [
    'provider,token,open_postings,board_url,api_url',
    'greenhouse,acme,42,https://x,https://y',
    'lever,zero,0,https://x,https://y',      // a board with no open postings is not a board we can measure
    'ashby,broken,,https://x,https://y',
    ',,,,',
  ].join('\n')
  const rows = parseRoster(csv)
  assert.deepEqual(rows, [{ provider: 'greenhouse', token: 'acme', postings: 42 }])
})

test('the strata partition the roster — every board lands in exactly one, and the weights sum to 1', () => {
  // 1..600 postings covers every cut point including both boundaries of every stratum.
  const rows = roster(600, (i) => i + 1)
  const plan = buildPlan(rows)
  assert.equal(plan.reduce((a, s) => a + s.boards_in_stratum, 0), rows.length)
  assert.equal(
    plan.reduce((a, s) => a + s.postings_in_stratum, 0),
    rows.reduce((a, b) => a + b.postings, 0),
  )
  assert.ok(Math.abs(plan.reduce((a, s) => a + s.weight, 0) - 1) < 1e-12)
})

test('pickSample is deterministic — the same roster always yields the same boards', () => {
  const rows = roster(500, (i) => 500 - i)
  const a = pickSample(rows, 25).map((b) => b.token)
  const b = pickSample([...rows].reverse(), 25).map((x) => x.token)
  // Even fed in the opposite order, the stable sort inside makes the draw identical. Reproducible
  // from the public roster by a stranger is the whole reason this is not Math.random.
  assert.deepEqual(a, b)
  assert.equal(a.length, 25)
})

test('pickSample walks the whole size range of the stratum, not just its head', () => {
  const rows = roster(100, (i) => 100 - i) // postings 100 down to 1
  const picked = pickSample(rows, 4).map((b) => b.postings)
  assert.deepEqual(picked, [100, 75, 50, 25])
})

test('pickSample returns the whole stratum when the target meets or exceeds it — that is a census', () => {
  const rows = roster(30, 5)
  assert.equal(pickSample(rows, 0).length, 30)
  assert.equal(pickSample(rows, 30).length, 30)
  assert.equal(pickSample(rows, 99).length, 30)
})

test('the census strata are the two largest and are marked as such', () => {
  const census = STRATA.filter((s) => s.census).map((s) => s.key)
  assert.deepEqual(census, ['500+', '100-499'])
})

test('a stratum rate is postings-weighted, not the mean of per-board rates', () => {
  // The distinguishing case, and the reason the mean is wrong: one large clean board and one tiny
  // filthy one. Mean of board rates = 25%. Share of postings that are duplicates = 1/1001.
  const boards = [
    { postings: 1000, same_location_extra: 0 },
    { postings: 1, same_location_extra: 1 },
  ]
  assert.ok(Math.abs(stratumRate(boards) - 1 / 1001) < 1e-12)
})

test('combine weights strata by their share of the corpus, not by how many boards were read', () => {
  // Stratum A is 90% of the postings and clean; B is 10% and 50% duplicated. Reading the same
  // number of boards in each must not let B drag the answer to 25%.
  const strata = [
    { weight: 0.9, census: true, boards: [{ postings: 100, same_location_extra: 0 }] },
    { weight: 0.1, census: true, boards: [{ postings: 100, same_location_extra: 50 }] },
  ]
  const { rate, weight_covered } = combine(strata)
  assert.ok(Math.abs(rate - 0.05) < 1e-12)
  assert.ok(Math.abs(weight_covered - 1) < 1e-12)
})

test('combine renormalises over the strata that answered and reports how much it covered', () => {
  const strata = [
    { weight: 0.75, census: true, boards: [{ postings: 100, same_location_extra: 10 }] },
    { weight: 0.25, census: true, boards: [] }, // read nothing
  ]
  const { rate, weight_covered } = combine(strata)
  assert.ok(Math.abs(rate - 0.1) < 1e-12)
  assert.ok(Math.abs(weight_covered - 0.75) < 1e-12)
})

test('a censused stratum contributes no sampling error — its interval has zero width', () => {
  const strata = [{ weight: 1, census: true, boards: roster(20, 10).map((b) => ({ ...b, same_location_extra: 1 })) }]
  const ci = bootstrap(strata, 200)
  assert.equal(ci.lo, ci.hi)
  assert.ok(Math.abs(ci.lo - 0.1) < 1e-12)
})

test('a sampled stratum does produce an interval, and it brackets the point estimate', () => {
  const boards = Array.from({ length: 40 }, (_, i) => ({ postings: 10, same_location_extra: i % 4 === 0 ? 5 : 0 }))
  const strata = [{ weight: 1, census: false, boards }]
  const ci = bootstrap(strata, 1000)
  const point = stratumRate(boards)
  assert.ok(ci.lo < ci.hi, 'a sample must carry uncertainty')
  assert.ok(ci.lo <= point && point <= ci.hi)
})

test('the bootstrap is reproducible — the published interval must not change between runs', () => {
  const strata = [{ weight: 1, census: false, boards: roster(50, 10).map((b, i) => ({ ...b, same_location_extra: i % 3 })) }]
  assert.deepEqual(bootstrap(strata, 500), bootstrap(strata, 500))
  assert.notDeepEqual(lcg(1)(), lcg(2)())
})

test('the corpus rate uses the shipped rule — analyseBoard, not a restatement of it', () => {
  // If this ever needs its own copy of the rule, the published corpus rate stops describing the
  // `dedupe` option it exists to describe. So the arithmetic is checked end to end on rows whose
  // answer is known by hand: 4 postings, "Nurse" twice in Leeds (1 duplicate), "Nurse" in York
  // and "Chef" in Leeds are not.
  const rows = [
    { title: 'Nurse', loc: 'Leeds' },
    { title: 'Nurse', loc: 'Leeds (Hybrid)' },
    { title: 'Nurse', loc: 'York' },
    { title: 'Chef', loc: 'Leeds' },
  ]
  const a = analyseBoard(rows)
  assert.equal(a.postings, 4)
  assert.equal(a.same_location_extra, 1)
  assert.equal(stratumRate([a]), 0.25)
})

test('the corpus rate is a LOWER bound — two spellings of one place read as two places', () => {
  // Found by getting this test wrong on the first attempt, which is the only reason it is here.
  // normLoc strips the noise words that vary between copies ("remote", "hybrid", "usa"), but it
  // resolves nothing: "Leeds" and "Leeds, UK" are different keys, as are "NYC" and "New York".
  // Every such pair is a duplicate the rule declines to merge. So the published corpus rate
  // under-states the defect, and the error has a known direction rather than an unknown one.
  const rows = [{ title: 'Nurse', loc: 'Leeds' }, { title: 'Nurse', loc: 'Leeds, UK' }]
  const a = analyseBoard(rows)
  assert.equal(a.repeated_extra, 1)
  assert.equal(a.same_location_extra, 0, 'an alias is not merged — the rate is conservative')
  assert.equal(a.distinct_location_extra, 1)
})

test('multi-site hiring is never counted as duplication, at any level of the estimator', () => {
  // The failure that would matter most: a retail chain posting one role at seventy stores must not
  // show up as sixty-nine duplicates anywhere in the chain from board to corpus.
  const rows = Array.from({ length: 70 }, (_, i) => ({ title: 'Sales Associate', loc: `Store ${i}` }))
  const a = analyseBoard(rows)
  assert.equal(a.repeated_extra, 69)
  assert.equal(a.same_location_extra, 0)
  const { rate } = combine([{ weight: 1, census: true, boards: [a] }])
  assert.equal(rate, 0)
})
