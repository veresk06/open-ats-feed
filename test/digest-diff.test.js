// node --test test
//
// The diff is the one part of the digest that makes a claim about *change*, which
// is the one kind of claim that cannot be checked by re-reading a board today. So
// it is tested against constructed pairs, where the right answer is known before
// the code runs.
//
// The case that matters most is the one that is not about arithmetic: a board we
// failed to read must never be reported as a company that stopped hiring. That
// confusion is the exact defect the digest generator already shipped once, when a
// dropped connection was counted as "this company has no postings".

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { BASIS, diffDigests, renderDiff } from '../scripts/lib/digest-diff.mjs'

function digest(date, generated_at, { boards, unread = [], tech = [], lists = {} } = {}) {
  const d = {
    date,
    generated_at,
    stats: {
      attempted: 10,
      responded: boards ? boards.length + unread.length : 10,
      withPostings: boards ? boards.length : 10,
      postings: boards ? boards.reduce((n, b) => n + b.open, 0) : 0,
      dated: 0,
      opened7: 0,
      opened30: 0,
    },
    boards_not_read_detail: unread,
    technology: tech,
    ramping: [],
    new_boards: [],
    new_functions: [],
    executive_openings: [],
    ...lists,
  }
  if (boards) d.boards = boards
  return d
}

const b = (c, open, sig = 'steady', p = 'greenhouse') => ({ c, p, open, dated: open, d7: 0, d30: 0, sig, ratio: null })

const T0 = '2026-09-03T01:00:00.000Z'
const T1 = '2026-09-04T01:00:00.000Z'

test('counts increases and decreases separately, and states them as lower bounds', () => {
  const d = diffDigests(
    digest('2026-09-03', T0, { boards: [b('acme', 100), b('globex', 50), b('initech', 20)] }),
    digest('2026-09-04', T1, { boards: [b('acme', 130), b('globex', 40), b('initech', 20)] }),
  )
  assert.equal(d.basis, BASIS.ROSTER)
  assert.equal(d.hours_between, 24)
  assert.equal(d.postings.gross_up, 30)
  assert.equal(d.postings.gross_down, 10)
  assert.equal(d.postings.net, 20)
  assert.equal(d.boards.common, 3)
  assert.deepEqual(d.grew.map((r) => r.company), ['acme'])
  assert.deepEqual(d.shrank.map((r) => r.company), ['globex'])

  const md = renderDiff(d).join('\n')
  assert.match(md, /Both figures are lower bounds/)
  assert.match(md, /net \+20/)
})

test('a board we failed to read is not a company that went quiet', () => {
  const d = diffDigests(
    digest('2026-09-03', T0, { boards: [b('acme', 100), b('globex', 50)] }),
    digest('2026-09-04', T1, {
      boards: [b('acme', 100)],
      unread: [{ provider: 'greenhouse', token: 'globex', why: 'ECONNRESET' }],
    }),
  )
  assert.deepEqual(d.went_quiet, [])
  assert.doesNotMatch(renderDiff(d).join('\n'), /globex/)
})

test('a board that really emptied is reported', () => {
  const d = diffDigests(
    digest('2026-09-03', T0, { boards: [b('acme', 100), b('globex', 50)] }),
    digest('2026-09-04', T1, { boards: [b('acme', 100)] }),
  )
  assert.deepEqual(d.went_quiet.map((r) => [r.company, r.prev]), [['globex', 50]])
  assert.match(renderDiff(d).join('\n'), /had postings last issue and have none now.*globex/s)
})

test('a board that appears is only news if we read it last time and it was empty', () => {
  const d = diffDigests(
    digest('2026-09-03', T0, {
      boards: [b('acme', 100)],
      unread: [{ provider: 'greenhouse', token: 'hooli', why: 'ECONNRESET' }],
    }),
    digest('2026-09-04', T1, { boards: [b('acme', 100), b('hooli', 12), b('umbrella', 7)] }),
  )
  assert.deepEqual(d.appeared.map((r) => r.company), ['umbrella'])
})

test('classifier movements are reported in both directions', () => {
  const d = diffDigests(
    digest('2026-09-03', T0, { boards: [b('acme', 100, 'steady'), b('globex', 80, 'ramping')] }),
    digest('2026-09-04', T1, { boards: [b('acme', 160, 'ramping'), b('globex', 70, 'steady')] }),
  )
  assert.deepEqual(d.became_ramping.map((r) => [r.company, r.was]), [['acme', 'steady']])
  assert.deepEqual(d.stopped_ramping.map((r) => [r.company, r.now]), [['globex', 'steady']])
})

test('technology is compared by distinct companies, and terms that did not move are dropped', () => {
  const d = diffDigests(
    digest('2026-09-03', T0, {
      boards: [b('acme', 1)],
      tech: [{ name: 'Python', companies: 100 }, { name: 'Rust', companies: 10 }, { name: 'Java', companies: 50 }],
    }),
    digest('2026-09-04', T1, {
      boards: [b('acme', 1)],
      tech: [{ name: 'Python', companies: 104 }, { name: 'Rust', companies: 9 }, { name: 'Java', companies: 50 }],
    }),
  )
  assert.deepEqual(d.technology.map((t) => [t.name, t.delta]), [['Python', 4], ['Rust', -1]])
})

test('a term absent from the earlier issue is marked as entering, not as a rise from zero', () => {
  const d = diffDigests(
    digest('2026-09-03', T0, { boards: [b('acme', 1)], tech: [{ name: 'Python', companies: 100 }] }),
    digest('2026-09-04', T1, {
      boards: [b('acme', 1)],
      tech: [{ name: 'Python', companies: 100 }, { name: 'CUDA', companies: 6 }],
    }),
  )
  const cuda = d.technology.find((t) => t.name === 'CUDA')
  assert.equal(cuda.entered, true)
  assert.equal(cuda.delta, null)
  assert.doesNotMatch(renderDiff(d).join('\n'), /CUDA/)
})

test('without a roster on both sides it degrades to published tables and says so', () => {
  const prev = digest('2026-09-03', T0, {
    lists: { ramping: [{ company: 'acme' }, { company: 'globex' }] },
  })
  delete prev.boards
  const d = diffDigests(
    prev,
    digest('2026-09-04', T1, {
      boards: [b('acme', 100)],
      lists: { ramping: [{ company: 'acme' }, { company: 'hooli' }] },
    }),
  )
  assert.equal(d.basis, BASIS.TOP_LISTS)
  assert.deepEqual(d.tables.ramping.entered, ['hooli'])
  assert.deepEqual(d.tables.ramping.left, ['globex'])

  const md = renderDiff(d).join('\n')
  assert.match(md, /limited to the tables both issues published/)
  assert.match(md, /may simply\s+have been displaced/)
})

test('run totals are compared even when the per-board basis is unavailable', () => {
  const prev = digest('2026-09-03', T0)
  prev.stats.postings = 155_490
  const cur = digest('2026-09-04', T1, { boards: [b('acme', 1)] })
  cur.stats.postings = 156_000
  const d = diffDigests(prev, cur)
  assert.equal(d.run.postings_net, 510)
  assert.match(renderDiff(d).join('\n'), /\| Open postings \| 155,490 \| 156,000 \| \+510 \|/)
})

test('an interval of days is described in days, not hours', () => {
  const d = diffDigests(
    digest('2026-09-03', T0, { boards: [b('acme', 1)] }),
    digest('2026-09-10', '2026-09-10T01:00:00.000Z', { boards: [b('acme', 1)] }),
  )
  assert.equal(d.hours_between, 168)
  assert.match(renderDiff(d).join('\n'), /7 days apart/)
})
