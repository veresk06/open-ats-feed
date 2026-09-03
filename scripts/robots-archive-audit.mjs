#!/usr/bin/env node
// Re-check every shipped provider's robots.txt against the Common Crawl archive, not
// just the live host.
//
// Cycle 38 refused Personio because its tenants served `Disallow: /xml` — the exact path
// we would have read. That file 404s today: Personio moved the career site to a new stack
// and robots.txt did not come with it. A live-only check would have returned "permitted"
// and we would have shipped a vendor that had explicitly refused us.
//
// Our six shipped providers were all cleared on live-only checks. The trap runs in this
// direction too: a vendor that permitted us when we looked may have disallowed since, and
// a vendor whose robots.txt has simply gone missing is not thereby granting permission.
// This script answers that question with evidence rather than assumption, for every
// provider at once, and writes the result to data/robots-audit.json.
//
// Usage: node scripts/robots-archive-audit.mjs [--provider=greenhouse,lever]

import { writeFileSync, readFileSync } from 'node:fs'
import {
  BASE, CRAWLS, sizeOf, surtPrefix, blocksFor, recordsIn, warcPayload,
} from './lib/cc-index.mjs'
import { isAllowed } from './lib/robots.mjs'

// The user-agent the Actor actually sends. Group selection depends on it, so it is read
// from one place and not retyped.
const PRODUCT_TOKEN = 'open-ats-feed'
const OUT = 'data/robots-audit.json'

// host: the host we issue the read against, which for a subdomain vendor is a tenant and
// is resolved at run time. path: the exact path-and-query the Actor fetches.
const TARGETS = [
  {
    provider: 'greenhouse',
    host: 'boards-api.greenhouse.io',
    path: '/v1/boards/{token}/jobs?content=true',
    probe: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`,
  },
  {
    provider: 'ashby',
    host: 'api.ashbyhq.com',
    path: '/posting-api/job-board/{token}?includeCompensation=true',
    probe: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`,
  },
  {
    provider: 'lever',
    host: 'api.lever.co',
    path: '/v0/postings/{token}?mode=json',
    probe: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
  },
  {
    provider: 'breezy',
    vendorHost: 'breezy.hr',
    subdomain: true,
    path: '/json',
    probe: (t) => `https://${t}.breezy.hr/json`,
  },
  {
    provider: 'recruitee',
    vendorHost: 'recruitee.com',
    subdomain: true,
    path: '/api/offers/',
    probe: (t) => `https://${t}.recruitee.com/api/offers/`,
  },
  {
    provider: 'teamtailor',
    vendorHost: 'teamtailor.com',
    subdomain: true,
    path: '/jobs.json',
    probe: (t) => `https://${t}.teamtailor.com/jobs.json`,
  },
]

const only = (process.argv.find((a) => a.startsWith('--provider=')) ?? '')
  .split('=')[1]
const ONLY = only ? new Set(only.split(',').map((s) => s.trim())) : null

const UA = `${PRODUCT_TOKEN}/robots-audit (+https://github.com/veresk06/open-ats-feed)`

async function get(url, { timeout = 30_000 } = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    })
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? null,
      location: res.headers.get('location') ?? null,
      body: await res.text(),
    }
  } catch (err) {
    return { status: null, error: err.message, body: '' }
  }
}

// A tenant that is actually serving. tokens.mjs already records why this matters: a dead
// Recruitee token 301s to the marketing host, so robots.txt read through one silently
// answers for the wrong site.
async function liveTenant(target, tokens) {
  for (const token of tokens.slice(0, 40)) {
    const res = await get(target.probe(token), { timeout: 20_000 })
    if (res.status === 200) return token
  }
  return null
}

// Archived robots.txt records for this target, newest crawl first. Stops once it has
// enough to show whether a rule is stable, so an audit costs a handful of range requests
// rather than a sweep.
// maxCrawls only bites when the archive is coming up empty, since a vendor that serves
// robots.txt is usually satisfied by the newest crawl alone. Setting it high therefore
// costs nothing except in the one case where the extra searching is the whole point.
async function archived(target, tenant, { want = 3, maxCrawls = 10 } = {}) {
  const host = target.subdomain ? target.vendorHost : target.host
  const prefix = target.subdomain
    ? surtPrefix(host, { subdomain: true })
    : `${surtPrefix(host)}robots.txt`
  const found = []
  const hosts = new Set()
  // "Never crawled" and "crawled, never served a robots.txt" are different findings.
  // The first says the archive cannot answer; the second is the archive agreeing with a
  // live host that has no file to serve.
  const nonOk = []
  let crawlsTried = 0

  for (const crawl of CRAWLS) {
    if (found.length >= want || crawlsTried >= maxCrawls) break
    const idxUrl = `${BASE}/${crawl}/indexes/cluster.idx`
    let size
    try {
      size = await sizeOf(idxUrl)
    } catch {
      continue
    }
    if (!size) continue
    crawlsTried++

    let blocks
    try {
      blocks = await blocksFor(idxUrl, size, prefix)
    } catch (err) {
      console.error(`  ! ${crawl} ${host}: index search failed (${err.message})`)
      continue
    }

    for (const block of blocks) {
      if (found.length >= want) break
      const recs = await recordsIn(crawl, block, prefix, (rec) => {
        if (!/\/robots\.txt$/.test(new URL(rec.url).pathname)) return false
        if (rec.status !== '200') {
          nonOk.push({ url: rec.url, crawl, crawled: rec.timestamp, http_status: rec.status })
          return false
        }
        return true
      })
      // Prefer the tenant we probed live, so live and archive describe the same host
      // wherever the crawl happens to contain it.
      recs.sort((a, b) => {
        const ah = new URL(a.url).hostname.startsWith(`${tenant}.`) ? 0 : 1
        const bh = new URL(b.url).hostname.startsWith(`${tenant}.`) ? 0 : 1
        return ah - bh
      })
      for (const rec of recs) {
        if (found.length >= want) break
        const recHost = new URL(rec.url).hostname
        if (hosts.has(recHost) && found.length) continue
        const payload = await warcPayload(rec)
        if (!payload) continue
        hosts.add(recHost)
        found.push({
          url: rec.url,
          crawl,
          crawled: rec.timestamp,
          http_status: rec.status,
          warc: rec.filename,
          offset: Number(rec.offset),
          length: Number(rec.length),
          body: payload.body,
        })
      }
    }
  }
  found.nonOk = nonOk
  found.crawlsTried = crawlsTried
  return found
}

function verdictFor(body, path) {
  const v = isAllowed(body, path, PRODUCT_TOKEN)
  return { allowed: v.allowed, reason: v.reason }
}

async function auditOne(target, tokens) {
  const label = target.provider
  process.stdout.write(`${label}: `)

  const tenant = target.subdomain
    ? await liveTenant(target, tokens)
    : tokens[0]
  if (target.subdomain && !tenant) {
    console.log('no live tenant found in the first 40 tokens — cannot check')
    return { provider: label, error: 'no live tenant' }
  }
  const host = target.subdomain ? `${tenant}.${target.vendorHost}` : target.host
  const path = target.path.replace('{token}', tenant)

  // Live.
  const live = await get(`https://${host}/robots.txt`)
  const liveIsRobots =
    live.status === 200 && (live.contentType ?? '').includes('text/plain')
  const liveVerdict = liveIsRobots
    ? verdictFor(live.body, path)
    : { allowed: true, reason: `no robots.txt served (HTTP ${live.status})` }

  // Archive.
  const records = await archived(target, tenant)
  const archiveVerdicts = records.map((r) => ({
    url: r.url,
    crawl: r.crawl,
    crawled: r.crawled,
    warc: r.warc,
    offset: r.offset,
    length: r.length,
    bytes: r.body.length,
    ...verdictFor(r.body, path),
  }))

  const archiveDisallows = archiveVerdicts.filter((v) => !v.allowed)
  // The Personio shape: the archive refused us and the live host no longer says so.
  const trap = archiveDisallows.length > 0 && liveVerdict.allowed
  // The mirror shape: we cleared this vendor live once, and it refuses us now.
  const regressed = !liveVerdict.allowed

  let status
  if (regressed) status = 'STOP-LIVE-DISALLOWS'
  else if (trap) status = 'STOP-ARCHIVE-DISALLOWS'
  // The archive was crawled and the host refused it there too. That corroborates the
  // live absence instead of leaving it unexplained, and it is the exact inverse of the
  // Personio shape, where the archive served 200 with a rule against us.
  else if (!records.length && records.nonOk.length) status = 'OK-NEVER-SERVED'
  else if (!records.length) status = 'UNVERIFIED-NO-ARCHIVE'
  else if (!liveIsRobots) status = 'OK-NO-LIVE-FILE'
  else status = 'OK'

  console.log(
    `${status} — live ${liveIsRobots ? `200, ${liveVerdict.allowed ? 'allows' : 'DISALLOWS'}` : `no file (${live.status})`}` +
      `, archive ${records.length} record(s) over ${records.crawlsTried} crawl(s), ` +
      `${archiveDisallows.length} disallowing`,
  )
  for (const v of archiveVerdicts) {
    console.log(`    ${v.crawled} ${v.url} → ${v.allowed ? 'allow' : 'DISALLOW'} (${v.reason})`)
  }
  if (!records.length && records.nonOk.length) {
    const codes = [...new Set(records.nonOk.map((r) => r.http_status))].join(', ')
    console.log(`    archive holds ${records.nonOk.length} capture(s), none served 200 (${codes})`)
  }

  return {
    provider: label,
    status,
    tenant_checked: tenant,
    host,
    path_read: path,
    product_token: PRODUCT_TOKEN,
    live: {
      url: `https://${host}/robots.txt`,
      http_status: live.status,
      content_type: live.contentType ?? null,
      served_robots_txt: liveIsRobots,
      ...liveVerdict,
      body: liveIsRobots ? live.body.slice(0, 4000) : null,
    },
    archive: archiveVerdicts,
    archive_crawls_searched: records.crawlsTried,
    archive_non_200: records.nonOk,
    archive_bodies: Object.fromEntries(records.map((r) => [r.url, r.body.slice(0, 4000)])),
  }
}

async function main() {
  const tokens = JSON.parse(readFileSync('data/tokens.json', 'utf8'))
  const results = []

  console.log(
    `Auditing robots.txt live + archive for user-agent "${PRODUCT_TOKEN}"\n` +
      `Archive: Common Crawl index on S3, newest first.\n`,
  )

  for (const target of TARGETS) {
    if (ONLY && !ONLY.has(target.provider)) continue
    try {
      results.push(await auditOne(target, tokens[target.provider] ?? []))
    } catch (err) {
      console.error(`${target.provider}: audit failed — ${err.message}`)
      results.push({ provider: target.provider, status: 'ERROR', error: err.message })
    }
  }

  const blocking = results.filter((r) => (r.status ?? '').startsWith('STOP'))
  const unverified = results.filter((r) => r.status === 'UNVERIFIED-NO-ARCHIVE')

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        as_of: new Date().toISOString().slice(0, 10),
        product_token: PRODUCT_TOKEN,
        method:
          'Live robots.txt plus archived copies from the Common Crawl index on S3, ' +
          'evaluated per RFC 9309 against the exact path the Actor fetches.',
        providers: results,
      },
      null,
      2,
    )}\n`,
  )

  console.log(`\nwrote ${OUT}`)
  console.log(
    `${results.length} provider(s): ${blocking.length} blocking, ${unverified.length} unverified, ` +
      `${results.length - blocking.length - unverified.length} clear`,
  )
  if (blocking.length) {
    console.log(`BLOCKING: ${blocking.map((b) => `${b.provider} (${b.status})`).join(', ')}`)
    process.exit(10)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
