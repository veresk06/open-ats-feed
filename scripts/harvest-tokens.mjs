#!/usr/bin/env node
// Harvest ATS job-board tokens from the Common Crawl URL index.
//
// Every public ATS board puts the company's board token in the URL path:
//   boards.greenhouse.io/{token}      jobs.lever.co/{token}      jobs.ashbyhq.com/{token}
// So a CDX query for those host prefixes yields a company->token index for free,
// without crawling anything ourselves.
//
// Output: data/tokens.json  { greenhouse: [...], lever: [...], ashby: [...] }

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'data/tokens.json')

// How many recent Common Crawl monthly indices to sweep. Each covers ~2 weeks of
// crawling, so more indices = more companies, with heavy overlap after the first few.
const CRAWLS = Number(process.env.CRAWLS ?? 4)
// Skip the first N indices. A later, deeper pass resumes from the checkpoint but
// would otherwise re-fetch every crawl the earlier pass already swept.
const CRAWL_OFFSET = Number(process.env.CRAWL_OFFSET ?? 0)

const SOURCES = [
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

function tokenFromUrl(raw) {
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

async function getJson(url, { retries = 4 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(180_000),
        headers: { 'user-agent': 'open-ats-feed/coverage-test (+contact via github)' },
      })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (attempt === retries) throw err
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt))
    }
  }
}

async function listCrawls() {
  const body = await getJson('https://index.commoncrawl.org/collinfo.json')
  return JSON.parse(body).slice(CRAWL_OFFSET, CRAWL_OFFSET + CRAWLS).map((c) => c.id)
}

async function pageCount(crawl, host) {
  const url = `https://index.commoncrawl.org/${crawl}-index?url=${encodeURIComponent(host + '/*')}&output=json&showNumPages=true`
  const body = await getJson(url)
  if (!body) return 0
  try {
    return JSON.parse(body).pages ?? 0
  } catch {
    return 0
  }
}

async function harvestPage(crawl, host, page, found) {
  const url = `https://index.commoncrawl.org/${crawl}-index?url=${encodeURIComponent(host + '/*')}&output=json&fl=url&page=${page}`
  let body
  try {
    body = await getJson(url)
  } catch (err) {
    console.error(`  ! ${crawl} ${host} page ${page}: ${err.message}`)
    return 0
  }
  if (!body) return 0
  let n = 0
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const token = tokenFromUrl(rec.url)
    if (token) {
      if (!found.has(token)) n++
      found.add(token)
    }
  }
  return n
}

function snapshot(byProvider) {
  return Object.fromEntries(
    Object.entries(byProvider).map(([k, v]) => [k, [...v].sort()]),
  )
}

// The first run of this was killed mid-sweep and lost every token, because the
// output was only written at the end. Checkpoint after each host instead, and
// reload the checkpoint on start so a kill costs one host, not the whole sweep.
async function save(byProvider) {
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(snapshot(byProvider), null, 2))
}

async function load(byProvider) {
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

async function main() {
  const crawls = await listCrawls()
  console.log(`Sweeping ${crawls.length} Common Crawl indices: ${crawls.join(', ')}\n`)

  const byProvider = { greenhouse: new Set(), lever: new Set(), ashby: new Set() }
  await load(byProvider)

  for (const crawl of crawls) {
    for (const { provider, host } of SOURCES) {
      const pages = await pageCount(crawl, host)
      if (!pages) {
        console.log(`${crawl} ${host}: no index entries`)
        continue
      }
      let added = 0
      for (let p = 0; p < pages; p++) {
        added += await harvestPage(crawl, host, p, byProvider[provider])
      }
      console.log(`${crawl} ${host}: ${pages} pages -> +${added} new tokens (${provider} total ${byProvider[provider].size})`)
      await save(byProvider)
    }
  }

  await save(byProvider)
  const out = snapshot(byProvider)
  const total = Object.values(out).reduce((a, v) => a + v.length, 0)
  console.log(`\nCandidate tokens: greenhouse ${out.greenhouse.length}, lever ${out.lever.length}, ashby ${out.ashby.length} (total ${total})`)
  console.log(`Wrote ${OUT}`)
}

await main()
