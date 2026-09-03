// Regenerate digests/README.md from the committed issues.
//
// Generated rather than hand-maintained, so the index cannot claim an issue that
// is not there, or miss one that is. Run standalone with:
//
//   node scripts/build-digest.mjs --index-only

import { readdir, readFile, writeFile } from 'node:fs/promises'

const ISSUE = /^\d{4}-\d{2}-\d{2}\.json$/

export async function issueFiles(dir) {
  return (await readdir(dir)).filter((f) => ISSUE.test(f)).sort()
}

export async function writeIndex(dir) {
  const issues = []
  for (const f of (await issueFiles(dir)).reverse()) {
    issues.push(JSON.parse(await readFile(new URL(f, dir), 'utf8')))
  }

  const md = []
  const w = (s = '') => md.push(s)

  w('# Hiring digests')
  w()
  w(
    'A dated series, one issue per date, measured from the live public job APIs of Greenhouse, Ashby ' +
      'and Lever. Each issue is two files: a `.md` written for a person and a `.json` carrying every ' +
      'number in it. Nothing is projected, estimated or back-filled, and no issue is edited after it is ' +
      'committed — a correction goes in the next one, where you can see it.',
  )
  w()
  w('| Issue | Boards read | Open postings | Opened in 7 days | Ramping | Data |')
  w('|---|---:|---:|---:|---:|---|')
  for (const p of issues) {
    w(
      `| [${p.date}](./${p.date}.md) | ${p.stats.withPostings.toLocaleString('en-US')} | ` +
        `${p.stats.postings.toLocaleString('en-US')} | ${p.stats.opened7.toLocaleString('en-US')} | ` +
        `${p.signal_breakdown?.ramping ?? '—'} | [json](./${p.date}.json) |`,
    )
  }
  w()
  w('## Why there is more than one')
  w()
  w(
    'A single issue counts postings that are **open**. That is enough to see hiring start and ' +
      'structurally unable to see hiring stop: a role filled last week is not on the board to be ' +
      'counted. Every ramp figure in a single issue is therefore an upper bound, and each issue says so ' +
      'in its own body rather than in a footnote.',
  )
  w()
  w(
    'Two issues subtract. From the second one onward each carries a **What changed** section computed ' +
      'from the two JSON files and from nothing else, so a reader can reproduce it without trusting ' +
      'either document and without a network call:',
  )
  w()
  w('```')
  w('node scripts/diff-digests.mjs digests/<earlier>.json digests/<later>.json')
  w('```')
  w()
  w(
    'That section is the only thing here a competitor starting today cannot reproduce, because it needs ' +
      'a yesterday. It is also where the honest ambiguity lives: a posting that disappeared was filled, ' +
      'cancelled or expired, and the board does not say which. The diff reports increases and decreases ' +
      'separately and calls both lower bounds, because they are computed per board — a company that ' +
      'opened three roles and closed three in the same interval contributes zero to each.',
  )
  w()
  w('## Reproducing an issue')
  w()
  w(
    'Each issue prints the exact command that produced it. The sample is deterministic — the N largest ' +
      'boards per provider in the order of the committed company index — so the same command on the same ' +
      'index reads the same boards, which is what makes two dates comparable at all. Re-running it on a ' +
      'later date will not reproduce the numbers, because the boards will have changed; that is the point.',
  )
  w()
  w(
    'Two runs 12 minutes apart over the same 650 boards differed by 6 postings out of 155,490 — 0.004%. ' +
      'The instrument contributes essentially nothing to a day-over-day delta, so what a diff shows is ' +
      'the market moving, not the measurement wobbling.',
  )
  w()
  w(
    'The same classifier runs over the whole index as an Apify Actor: ' +
      '[open-ats-jobs-feed](https://apify.com/sharp_malachite/open-ats-jobs-feed), `outputMode: "signals"`.',
  )
  w()

  await writeFile(new URL('README.md', dir), `${md.join('\n')}`)
  return issues.length
}
