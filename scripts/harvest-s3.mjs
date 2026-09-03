#!/usr/bin/env node
// Harvest ATS board tokens straight from the Common Crawl index files on S3.
//
// Why this exists alongside harvest-tokens.mjs: that script talks to the CDX API at
// index.commoncrawl.org, which is a single application server and is the thing that
// killed the Cycle-2 sweep — it went from 504s to refusing TLS entirely, and 13 of 17
// planned indices were never fetched. data.commoncrawl.org is the S3 bucket behind a
// CDN and stays up when the API does not.
//
// The bucket has no query interface, but it does not need one. Each crawl ships a
// cluster.idx: ~110 MB of plain text, one line per compressed cdx block, sorted by
// SURT. Since it is sorted and HTTP supports ranges, it is a binary-searchable index
// over the whole crawl. Find the blocks covering `io,greenhouse,boards)/`, range-fetch
// just those, and the 110 MB file costs about 700 KB to search.
//
// Output: data/tokens.json — same file and format as harvest-tokens.mjs, so the two
// share a checkpoint and either can resume the other.

import { gunzipSync } from 'node:zlib'
import { SOURCES, PROVIDER_NAMES, tokenFromUrl, snapshot, save, load, OUT } from './lib/tokens.mjs'

const BASE = 'https://data.commoncrawl.org/cc-index/collections'

// The indices the CDX-API sweep never reached, newest first. Overridable so a later
// pass can go deeper without re-fetching what this one covered.
const DEFAULT_CRAWLS = [
  'CC-MAIN-2026-04', 'CC-MAIN-2025-51', 'CC-MAIN-2025-47', 'CC-MAIN-2025-43',
  'CC-MAIN-2025-38', 'CC-MAIN-2025-33', 'CC-MAIN-2025-30', 'CC-MAIN-2025-26',
  'CC-MAIN-2025-21', 'CC-MAIN-2025-18', 'CC-MAIN-2025-13', 'CC-MAIN-2025-08',
  'CC-MAIN-2025-05',
]
const CRAWLS = (process.env.CRAWLS ?? '').trim()
  ? process.env.CRAWLS.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_CRAWLS

// Restricts the sweep to named hosts. Adding a provider does not mean re-walking the
// ones already harvested — the checkpoint is still loaded and rewritten in full, so a
// targeted run adds to the roster rather than replacing it.
const ONLY_HOSTS = (process.env.HOSTS ?? '').trim()
  ? new Set(process.env.HOSTS.split(',').map((s) => s.trim()).filter(Boolean))
  : null

const PROBE = 64 * 1024 // binary-search probe window
const SCAN = 1024 * 1024 // linear-scan window once the search has narrowed

// boards.greenhouse.io -> io,greenhouse,boards)/
//
// For a subdomain vendor the token is the label we are searching *for*, so the prefix
// stops one comma short: breezy.hr -> hr,breezy, which matches every tenant and, by
// leaving off the `)/`, deliberately excludes the vendor's own apex host.
function surtPrefix(host, tokenFrom) {
  const reversed = host.split('.').reverse().join(',')
  return tokenFrom === 'subdomain' ? `${reversed},` : `${reversed})/`
}

async function fetchRange(url, start, end, { retries = 5 } = {}) {
  const headers = { 'user-agent': 'open-ats-feed/coverage-test (+contact via github)' }
  if (start !== undefined) headers.range = `bytes=${start}-${end}`
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
      if (res.status === 404) return null
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (attempt === retries) throw err
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
    }
  }
}

async function sizeOf(url) {
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(60_000) })
  if (!res.ok) return 0
  return Number(res.headers.get('content-length') ?? 0)
}

// Key of the first line that starts at or after `pos`, plus where that line starts.
// Anywhere but offset 0 we land mid-line, so the partial leading line is discarded.
async function firstKeyAt(url, pos, size) {
  const buf = await fetchRange(url, pos, Math.min(pos + PROBE, size) - 1)
  if (!buf) return null
  const text = buf.toString('utf8')
  const from = pos === 0 ? 0 : text.indexOf('\n') + 1
  if (from === 0 && pos !== 0) return null
  const end = text.indexOf('\n', from)
  if (end === -1) return null
  return { key: text.slice(from, end).split('\t')[0], at: pos + from }
}

// Byte offset of the last cluster.idx line whose key is still below `prefix`.
// Starting the scan one line early matters: cluster.idx keys are block *start*
// keys, so the first block containing our prefix is usually the one that begins
// just before it.
async function seek(url, size, prefix) {
  let lo = 0
  let hi = size
  while (hi - lo > PROBE) {
    const mid = Math.floor((lo + hi) / 2)
    const probe = await firstKeyAt(url, mid, size)
    if (!probe) {
      hi = mid
      continue
    }
    if (probe.key < prefix) lo = mid
    else hi = mid
  }
  return lo
}

// Every cdx block whose key range can hold `prefix`, as {file, offset, length}.
async function blocksFor(url, size, prefix) {
  const blocks = []
  let pos = await seek(url, size, prefix)
  let prev = null
  let started = false
  let carry = ''
  let atLineStart = pos === 0

  while (pos < size) {
    const buf = await fetchRange(url, pos, Math.min(pos + SCAN, size) - 1)
    if (!buf) break
    let text = carry + buf.toString('utf8')
    pos += buf.length
    // A window boundary can split a line; hold the tail back for the next window.
    const lastNl = text.lastIndexOf('\n')
    carry = lastNl === -1 ? text : text.slice(lastNl + 1)
    text = lastNl === -1 ? '' : text.slice(0, lastNl)

    for (const line of text.split('\n')) {
      if (!atLineStart) {
        // First line of the very first window is a fragment. Skip it once.
        atLineStart = true
        continue
      }
      if (!line) continue
      const parts = line.split('\t')
      const key = parts[0]
      if (parts.length < 4) continue
      const block = { file: parts[1], offset: Number(parts[2]), length: Number(parts[3]) }
      if (key < prefix) {
        prev = block
        continue
      }
      if (key.startsWith(prefix)) {
        if (!started) {
          started = true
          if (prev) blocks.push(prev)
        }
        blocks.push(block)
        continue
      }
      // Past the prefix. If nothing matched, the straddling block still might.
      if (!started && prev) blocks.push(prev)
      return blocks
    }
  }
  if (!started && prev) blocks.push(prev)
  return blocks
}

async function readBlock(crawl, block, prefix, found, opts = {}) {
  const url = `${BASE}/${crawl}/indexes/${block.file}`
  let buf
  try {
    buf = await fetchRange(url, block.offset, block.offset + block.length - 1)
  } catch (err) {
    console.error(`  ! ${crawl} ${block.file}@${block.offset}: ${err.message}`)
    return 0
  }
  if (!buf) return 0
  let text
  try {
    text = gunzipSync(buf).toString('utf8')
  } catch (err) {
    console.error(`  ! ${crawl} ${block.file}@${block.offset}: gunzip failed (${err.message})`)
    return 0
  }
  let n = 0
  for (const line of text.split('\n')) {
    if (!line.startsWith(prefix)) continue
    const brace = line.indexOf('{')
    if (brace === -1) continue
    let rec
    try {
      rec = JSON.parse(line.slice(brace))
    } catch {
      continue
    }
    if (!rec.url) continue
    const token = tokenFromUrl(rec.url, opts)
    if (token) {
      if (!found.has(token)) n++
      found.add(token)
    }
  }
  return n
}

async function main() {
  console.log(`Sweeping ${CRAWLS.length} Common Crawl indices from S3: ${CRAWLS.join(', ')}\n`)

  // Derived from SOURCES, not listed by hand: a provider added there but forgotten
  // here would have its tokens dropped on the floor by readBlock and, worse, wiped
  // from tokens.json by the save() below, which writes the whole file.
  const byProvider = Object.fromEntries(PROVIDER_NAMES.map((p) => [p, new Set()]))
  await load(byProvider)
  const before = Object.fromEntries(
    Object.entries(byProvider).map(([k, v]) => [k, v.size]),
  )

  for (const crawl of CRAWLS) {
    const idxUrl = `${BASE}/${crawl}/indexes/cluster.idx`
    const size = await sizeOf(idxUrl)
    if (!size) {
      console.log(`${crawl}: no cluster.idx, skipping`)
      continue
    }
    for (const { provider, host, caseSensitive, tokenFrom } of SOURCES) {
      if (ONLY_HOSTS && !ONLY_HOSTS.has(host)) continue
      const prefix = surtPrefix(host, tokenFrom)
      let blocks
      try {
        blocks = await blocksFor(idxUrl, size, prefix)
      } catch (err) {
        console.error(`  ! ${crawl} ${host}: index search failed (${err.message}), skipping host`)
        continue
      }
      if (!blocks.length) {
        console.log(`${crawl} ${host}: no index entries`)
        continue
      }
      let added = 0
      for (const block of blocks) {
        added += await readBlock(crawl, block, prefix, byProvider[provider], {
          caseSensitive,
          tokenFrom,
          host,
        })
      }
      console.log(`${crawl} ${host}: ${blocks.length} blocks -> +${added} new tokens (${provider} total ${byProvider[provider].size})`)
      await save(byProvider)
    }
  }

  await save(byProvider)
  const out = snapshot(byProvider)
  const total = Object.values(out).reduce((a, v) => a + v.length, 0)
  const per = Object.entries(out).map(([k, v]) => `${k} ${v.length}`).join(', ')
  console.log(`\nCandidate tokens: ${per} (total ${total})`)
  for (const k of Object.keys(out)) {
    console.log(`  ${k}: +${out[k].length - (before[k] ?? 0)} new this run`)
  }
  console.log(`Wrote ${OUT}`)
}

await main()
