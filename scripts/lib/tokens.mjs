// Shared between the two harvesters: how a board URL becomes a company token, and
// how a partial harvest is checkpointed. Both harvesters write the same file, so a
// run of one can resume a run of the other.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const OUT = resolve(ROOT, 'data/tokens.json')

export const SOURCES = [
  { provider: 'greenhouse', host: 'boards.greenhouse.io' },
  { provider: 'greenhouse', host: 'job-boards.greenhouse.io' },
  { provider: 'greenhouse', host: 'boards.eu.greenhouse.io' },
  { provider: 'greenhouse', host: 'job-boards.eu.greenhouse.io' },
  { provider: 'lever', host: 'jobs.lever.co' },
  { provider: 'lever', host: 'jobs.eu.lever.co' },
  { provider: 'ashby', host: 'jobs.ashbyhq.com' },
]

// First path segments that are platform routes, not company tokens.
const NOT_A_TOKEN = new Set([
  'embed', 'api', 'v1', 'v0', 'jobs', 'job', 'static', 'assets', 'favicon.ico',
  'robots.txt', 'sitemap.xml', 'error', '404', 'index.html', 'apply', 'search',
  'postings', 'boards', 'company', 'companies', 'auth', 'login', 'signup',
])

export function tokenFromUrl(raw) {
  let u
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const seg = u.pathname.split('/').filter(Boolean)[0]
  if (!seg) return null
  let token
  try {
    token = decodeURIComponent(seg).trim().toLowerCase()
  } catch {
    return null
  }
  if (!token || token.length > 100) return null
  if (NOT_A_TOKEN.has(token)) return null
  // Board tokens are slugs. Pure digits are job ids that leaked into position 0.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(token)) return null
  if (/^\d+$/.test(token)) return null
  return token
}

export function snapshot(byProvider) {
  return Object.fromEntries(
    Object.entries(byProvider).map(([k, v]) => [k, [...v].sort()]),
  )
}

// The first run of this was killed mid-sweep and lost every token, because the
// output was only written at the end. Checkpoint after each host instead, and
// reload the checkpoint on start so a kill costs one host, not the whole sweep.
export async function save(byProvider) {
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(snapshot(byProvider), null, 2))
}

export async function load(byProvider) {
  try {
    const prev = JSON.parse(await readFile(OUT, 'utf8'))
    for (const [k, v] of Object.entries(prev)) {
      if (byProvider[k]) for (const t of v) byProvider[k].add(t)
    }
    const n = Object.values(byProvider).reduce((a, v) => a + v.size, 0)
    if (n) console.log(`Resuming from checkpoint: ${n} tokens already known\n`)
  } catch {
    // No checkpoint yet.
  }
}
