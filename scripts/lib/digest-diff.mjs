// Diff two dated hiring digests.
//
// This is the only part of the digest that can say something a single run cannot:
// a run counts postings that are open, so on its own it can show hiring starting
// and can never show hiring stopping. Two runs subtract.
//
// It is a pure function over two committed digest JSON files, deliberately — a
// reader can run `node scripts/diff-digests.mjs digests/A.json digests/B.json`
// and get byte-identical output to the section printed inside the digest. Nothing
// in here reaches the network or reads anything the reader does not also have.

const HOUR = 3_600_000

// An issue generated before the roster existed carries only its published top-N
// tables. Comparing those is legitimate but much weaker, because a company can
// leave a top-20 table by being displaced rather than by changing, so the two
// bases are labelled and reported differently rather than blended.
export const BASIS = { ROSTER: 'roster', TOP_LISTS: 'top-lists' }

const key = (r) => `${r.p}:${r.c}`
const byDeltaDesc = (a, b) => b.delta - a.delta || a.company.localeCompare(b.company)

function rosterMap(digest) {
  if (!Array.isArray(digest.boards)) return null
  return new Map(digest.boards.map((r) => [key(r), r]))
}

function failedTokens(digest) {
  return new Set((digest.boards_not_read_detail ?? []).map((f) => `${f.provider}:${f.token}`))
}

function techMap(digest) {
  return new Map((digest.technology ?? []).map((t) => [t.name, t]))
}

function listNames(rows) {
  return new Set((rows ?? []).map((s) => s.company))
}

export function diffDigests(prev, cur, { limit = 15 } = {}) {
  const hours = Math.round(((Date.parse(cur.generated_at) - Date.parse(prev.generated_at)) / HOUR) * 10) / 10
  const techBefore = techMap(prev)

  const head = {
    prev_date: prev.date,
    cur_date: cur.date,
    hours_between: hours,
    run: {
      responded: [prev.stats.responded, cur.stats.responded],
      with_postings: [prev.stats.withPostings, cur.stats.withPostings],
      postings: [prev.stats.postings, cur.stats.postings],
      postings_net: cur.stats.postings - prev.stats.postings,
      opened_7d: [prev.stats.opened7, cur.stats.opened7],
      opened_30d: [prev.stats.opened30, cur.stats.opened30],
    },
    technology: [...techMap(cur).entries()]
      .map(([name, t]) => {
        const before = techBefore.get(name)
        return {
          name,
          companies: [before?.companies ?? null, t.companies],
          delta: before ? t.companies - before.companies : null,
          entered: !before,
        }
      })
      .filter((t) => t.delta !== 0)
      .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0) || a.name.localeCompare(b.name)),
  }

  const a = rosterMap(prev)
  const b = rosterMap(cur)

  if (!a || !b) {
    // Degraded: compare only what both issues published as tables.
    const tables = {}
    for (const [name, field] of [
      ['ramping', 'ramping'],
      ['new_boards', 'new_boards'],
      ['new_functions', 'new_functions'],
      ['executive_openings', 'executive_openings'],
    ]) {
      const before = listNames(prev[field])
      const after = listNames(cur[field])
      tables[name] = {
        entered: [...after].filter((c) => !before.has(c)).sort(),
        left: [...before].filter((c) => !after.has(c)).sort(),
      }
    }
    return { ...head, basis: BASIS.TOP_LISTS, tables }
  }

  const prevFailed = failedTokens(prev)
  const curFailed = failedTokens(cur)

  const grew = []
  const shrank = []
  const became = []
  const stopped = []
  const appeared = []
  const wentQuiet = []
  let gross_up = 0
  let gross_down = 0

  for (const [k, row] of b) {
    const before = a.get(k)
    if (!before) {
      // Absent last time. Only a real appearance if we actually read it last time
      // and it had nothing; otherwise it is an instrument gap and says nothing.
      appeared.push({ company: row.c, provider: row.p, open: row.open, read_last_time: !prevFailed.has(k) })
      continue
    }
    const delta = row.open - before.open
    if (delta > 0) gross_up += delta
    if (delta < 0) gross_down += -delta
    const entry = { company: row.c, provider: row.p, prev: before.open, cur: row.open, delta }
    if (delta > 0) grew.push(entry)
    if (delta < 0) shrank.push(entry)
    if (row.sig === 'ramping' && before.sig !== 'ramping') became.push({ ...entry, was: before.sig })
    if (before.sig === 'ramping' && row.sig !== 'ramping') stopped.push({ ...entry, now: row.sig })
  }

  for (const [k, before] of a) {
    if (b.has(k)) continue
    // Gone from the roster: either it has no open postings at all now, or we
    // could not read it. Those are different facts and the second is not news.
    wentQuiet.push({ company: before.c, provider: before.p, prev: before.open, unread: curFailed.has(k) })
  }

  const common = [...b.keys()].filter((k) => a.has(k)).length
  return {
    ...head,
    basis: BASIS.ROSTER,
    boards: { common, prev_only: a.size - common, cur_only: appeared.length },
    postings: { gross_up, gross_down, net: gross_up - gross_down },
    grew: grew.sort(byDeltaDesc).slice(0, limit),
    shrank: shrank.sort((x, y) => x.delta - y.delta).slice(0, limit),
    became_ramping: became.sort(byDeltaDesc).slice(0, limit),
    stopped_ramping: stopped.sort((x, y) => x.delta - y.delta).slice(0, limit),
    appeared: appeared.filter((x) => x.read_last_time).sort((x, y) => y.open - x.open).slice(0, limit),
    went_quiet: wentQuiet.filter((x) => !x.unread).sort((x, y) => y.prev - x.prev).slice(0, limit),
  }
}

const sign = (n) => (n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US'))
const link = (r) =>
  r.provider === 'greenhouse'
    ? `[${r.company}](https://job-boards.greenhouse.io/${r.company})`
    : r.provider === 'ashby'
      ? `[${r.company}](https://jobs.ashbyhq.com/${r.company})`
      : `[${r.company}](https://jobs.lever.co/${r.company})`

export function renderDiff(d) {
  const md = []
  const w = (s = '') => md.push(s)
  const span = d.hours_between >= 48 ? `${Math.round(d.hours_between / 24)} days` : `${d.hours_between} hours`

  w(`## What changed since ${d.prev_date}`)
  w()
  w(
    `Both issues ran the same board list — the same rule, the same limits, the same committed ` +
      `company index — so the two are subtractable. ${span} apart, computed by ` +
      `[\`scripts/diff-digests.mjs\`](../scripts/diff-digests.mjs) from ` +
      `[\`${d.prev_date}.json\`](./${d.prev_date}.json) and [\`${d.cur_date}.json\`](./${d.cur_date}.json) ` +
      `and from nothing else.`,
  )
  w()
  w(`| | ${d.prev_date} | ${d.cur_date} | Change |`)
  w('|---|---:|---:|---:|')
  const row = (label, [x, y]) =>
    w(`| ${label} | ${x.toLocaleString('en-US')} | ${y.toLocaleString('en-US')} | ${sign(y - x)} |`)
  row('Boards that answered', d.run.responded)
  row('Boards with an open posting', d.run.with_postings)
  row('Open postings', d.run.postings)
  row('Opened in the last 7 days', d.run.opened_7d)
  row('Opened in the last 30 days', d.run.opened_30d)
  w()

  if (d.basis === BASIS.TOP_LISTS) {
    w(
      `**This comparison is limited to the tables both issues published.** The earlier issue ` +
        `predates the per-board roster now written into every digest, so there is no way to ask it ` +
        `what a company outside its top-20 was doing. A company listed as *left* below may simply ` +
        `have been displaced by another; it is not a claim that it stopped. Full per-board diffs ` +
        `begin with the first pair of issues that both carry a roster.`,
    )
    w()
    for (const [name, label] of [
      ['ramping', 'Ramping table'],
      ['new_boards', 'New-board table'],
      ['new_functions', 'New-function table'],
      ['executive_openings', 'Executive-openings table'],
    ]) {
      const t = d.tables[name]
      if (!t.entered.length && !t.left.length) continue
      w(
        `- **${label}** — entered: ${t.entered.length ? t.entered.join(', ') : '—'}; ` +
          `left: ${t.left.length ? t.left.join(', ') : '—'}`,
      )
    }
    w()
    return md
  }

  w(
    `Across the ${d.boards.common.toLocaleString('en-US')} boards read in both issues, open postings ` +
      `rose by ${d.postings.gross_up.toLocaleString('en-US')} and fell by ` +
      `${d.postings.gross_down.toLocaleString('en-US')}, net ${sign(d.postings.net)}. ` +
      `**Both figures are lower bounds:** they are computed per board, so a company that opened ` +
      `three roles and closed three in the same interval contributes zero to each. And a posting ` +
      `that disappeared was filled, cancelled or expired — the board does not say which, and ` +
      `neither does this table.`,
  )
  w()

  const table = (title, rows, cols) => {
    if (!rows.length) return
    w(`### ${title}`)
    w()
    w(`| Company | ${d.prev_date} | ${d.cur_date} | Change |`)
    w('|---|---:|---:|---:|')
    for (const r of rows) w(`| ${link(r)} | ${r.prev} | ${r.cur} | **${sign(r.delta)}** |${cols?.(r) ?? ''}`)
    w()
  }

  table('Biggest increases', d.grew)
  table('Biggest decreases', d.shrank)

  if (d.became_ramping.length) {
    w('### Newly ramping')
    w()
    w('Companies the classifier moved into `ramping` between the two issues, and what they were before.')
    w()
    w('| Company | Was | Open before | Open now |')
    w('|---|---|---:|---:|')
    for (const r of d.became_ramping) w(`| ${link(r)} | ${r.was} | ${r.prev} | ${r.cur} |`)
    w()
  }
  if (d.stopped_ramping.length) {
    w('### No longer ramping')
    w()
    w('| Company | Now | Open before | Open now |')
    w('|---|---|---:|---:|')
    for (const r of d.stopped_ramping) w(`| ${link(r)} | ${r.now} | ${r.prev} | ${r.cur} |`)
    w()
  }
  if (d.appeared.length) {
    w(
      `**Boards that had nothing last issue and have postings now:** ` +
        d.appeared.map((r) => `${link(r)} (${r.open})`).join(', ') +
        '. Boards we failed to read are excluded from this list rather than counted as empty.',
    )
    w()
  }
  if (d.went_quiet.length) {
    w(
      `**Boards that had postings last issue and have none now:** ` +
        d.went_quiet.map((r) => `${link(r)} (was ${r.prev})`).join(', ') +
        '. Again, excluding boards that simply did not answer this time.',
    )
    w()
  }

  const tech = d.technology.filter((t) => t.delta !== null && Math.abs(t.delta) >= 1).slice(0, 10)
  if (tech.length) {
    w(
      'Change in the number of distinct companies naming a technology in the last 30 days: ' +
        tech.map((t) => `**${t.name}** ${sign(t.delta)}`).join(', ') +
        '. This tracks the published table, which is a top-25, so a term can move without appearing here.',
    )
    w()
  }
  return md
}
