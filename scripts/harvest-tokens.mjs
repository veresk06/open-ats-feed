#!/usr/bin/env node
// Harvest ATS job-board tokens from the Common Crawl URL index.
//
// Every public ATS board puts the company's board token in the URL path:
//   boards.greenhouse.io/{token}      jobs.lever.co/{token}      jobs.ashbyhq.com/{token}
// So a CDX query for those host prefixes yields a company->token index for free,
// without crawling anything ourselves.
//
// Output: data/tokens.json  { greenhouse: [...], lever: [...], ashby: [...] }

// NOTE: index.commoncrawl.org is a single application server and it went fully
// unreachable mid-sweep, costing a cycle. harvest-s3.mjs reads the same index from
// the S3 bucket instead and has no such dependency. Prefer it; keep this for the
// cases where the CDX API's query interface is genuinely more convenient.
import { SOURCES, tokenFromUrl, snapshot, save, load, OUT } from './lib/tokens.mjs'

// How many recent Common Crawl monthly indices to sweep. Each covers ~2 weeks of
// crawling, so more indices = more companies, with heavy overlap after the first few.
const CRAWLS = Number(process.env.CRAWLS ?? 4)
// Skip the first N indices. A later, deeper pass resumes from the checkpoint but
// would otherwise re-fetch every crawl the earlier pass already swept.
const CRAWL_OFFSET = Number(process.env.CRAWL_OFFSET ?? 0)

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
  // getJson throws once its retries are exhausted. The index server does fall
  // over under sustained load (we have seen 502s and 504s), and one host that
  // stays down must not take the whole sweep with it — a crash here loses every
  // index after this point, which is exactly what happened on CC-MAIN-2026-04.
  let body
  try {
    body = await getJson(url)
  } catch (err) {
    console.error(`  ! ${crawl} ${host}: page count failed (${err.message}), skipping host`)
    return 0
  }
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
