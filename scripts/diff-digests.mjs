// Print the "What changed" section for any two committed digests.
//
//   node scripts/diff-digests.mjs digests/2026-09-03.json digests/2026-09-04.json
//
// The later issue embeds this same section, produced by this same code. Running
// it here is how a reader checks that what the digest claims changed is what the
// two JSON files actually say changed — without trusting either document, and
// without a network call.

import { readFile } from 'node:fs/promises'

import { diffDigests, renderDiff } from './lib/digest-diff.mjs'

const [a, b] = process.argv.slice(2)
if (!a || !b) {
  process.stderr.write('usage: node scripts/diff-digests.mjs <earlier.json> <later.json>\n')
  process.exit(2)
}

const prev = JSON.parse(await readFile(a, 'utf8'))
const cur = JSON.parse(await readFile(b, 'utf8'))
if (Date.parse(cur.generated_at) < Date.parse(prev.generated_at)) {
  process.stderr.write(`refusing: ${b} was generated before ${a}. Pass the earlier issue first.\n`)
  process.exit(2)
}

process.stdout.write(`${renderDiff(diffDigests(prev, cur)).join('\n')}\n`)
