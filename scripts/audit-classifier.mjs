#!/usr/bin/env node
// Audit the role classifier against the cached corpus: for a given family, print which keyword
// actually fired and how often, plus example titles per keyword.
//
// This exists because run 2 added a bare `engineer` / `developer` catch at the bottom of the
// keyword list, and a bare catch is exactly the kind of change that quietly inflates the one
// number we quote publicly. A classifier you cannot interrogate is a classifier you should not
// publish numbers from.
//
//   node scripts/audit-classifier.mjs engineering
//   node scripts/audit-classifier.mjs engineering --key=engineer --examples=25
//
// Reads data/role-census-titles.json. No network, $0.00.

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { explain } from './role-census.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = resolve(ROOT, 'data/role-census-titles.json')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const FAMILY = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'engineering'
const ONLY_KEY = arg('key', null)
const EXAMPLES = Number(arg('examples', 6))

const cached = JSON.parse(await readFile(CACHE, 'utf8'))
const byKey = new Map()
let total = 0

for (const entry of cached) {
  for (const title of entry.titles) {
    const { family, key } = explain(title)
    if (family !== FAMILY) continue
    total++
    const k = key ?? '(none)'
    if (!byKey.has(k)) byKey.set(k, { n: 0, examples: [] })
    const rec = byKey.get(k)
    rec.n++
    if (rec.examples.length < EXAMPLES) rec.examples.push(String(title))
  }
}

const rows = [...byKey.entries()].sort((a, b) => b[1].n - a[1].n)
process.stdout.write(`${FAMILY}: ${total} titles, ${rows.length} distinct keys fired\n\n`)
for (const [key, rec] of rows) {
  if (ONLY_KEY && key !== ONLY_KEY) continue
  process.stdout.write(`${String(rec.n).padStart(7)}  ${key}\n`)
  if (ONLY_KEY || rec.n >= 500) {
    for (const ex of rec.examples) process.stdout.write(`         · ${ex}\n`)
  }
}
