// Point lookups against the Common Crawl index on S3.
//
// data.commoncrawl.org is the bucket behind a CDN; index.commoncrawl.org is a single
// application server that has already failed us once mid-sweep (see harvest-s3.mjs).
// So we binary-search cluster.idx over HTTP ranges instead of asking a query service.
//
// harvest-s3.mjs keeps its own copy of this search, specialised for sweeping every
// tenant under a vendor prefix and folding results into a token checkpoint. This
// module is the general form: give it a SURT prefix, get back the raw index records.
// The two are not merged because harvest-s3.mjs is load-bearing for the roster and
// this module was written for an audit tool; merging them is a refactor to do when
// something actually needs it, not on the way past.

import { gunzipSync } from 'node:zlib'

export const BASE = 'https://data.commoncrawl.org/cc-index/collections'
export const DATA = 'https://data.commoncrawl.org'

// Newest first. An audit wants the most recent statement of a rule, then an older one
// to prove the rule was stable rather than a one-off.
export const CRAWLS = [
  'CC-MAIN-2026-04', 'CC-MAIN-2025-51', 'CC-MAIN-2025-47', 'CC-MAIN-2025-43',
  'CC-MAIN-2025-38', 'CC-MAIN-2025-33', 'CC-MAIN-2025-30', 'CC-MAIN-2025-26',
  'CC-MAIN-2025-21', 'CC-MAIN-2025-18', 'CC-MAIN-2025-13', 'CC-MAIN-2025-08',
  'CC-MAIN-2025-05',
]

const PROBE = 64 * 1024
const SCAN = 1024 * 1024
const UA = 'open-ats-feed/robots-audit (+https://github.com/veresk06/open-ats-feed)'

export async function fetchRange(url, start, end, { retries = 4 } = {}) {
  const headers = { 'user-agent': UA }
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

export async function sizeOf(url) {
  const res = await fetch(url, {
    method: 'HEAD',
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) return 0
  return Number(res.headers.get('content-length') ?? 0)
}

// boards-api.greenhouse.io -> io,greenhouse,boards-api)/
// Pass `subdomain: true` to stop one comma short, matching every tenant under the
// vendor: breezy.hr -> hr,breezy, — which also excludes the vendor's own apex host.
export function surtPrefix(host, { subdomain = false } = {}) {
  const reversed = host.split('.').reverse().join(',')
  return subdomain ? `${reversed},` : `${reversed})/`
}

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

// Every cdx block whose key range can hold `prefix`. cluster.idx keys are block *start*
// keys, so the block that begins just below the prefix usually contains it too.
export async function blocksFor(url, size, prefix) {
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
    const lastNl = text.lastIndexOf('\n')
    carry = lastNl === -1 ? text : text.slice(lastNl + 1)
    text = lastNl === -1 ? '' : text.slice(0, lastNl)

    for (const line of text.split('\n')) {
      if (!atLineStart) {
        atLineStart = true
        continue
      }
      if (!line) continue
      const parts = line.split('\t')
      if (parts.length < 4) continue
      const key = parts[0]
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
      if (!started && prev) blocks.push(prev)
      return blocks
    }
  }
  if (!started && prev) blocks.push(prev)
  return blocks
}

// Parsed index records under `prefix`, optionally narrowed by `match(record)`.
export async function recordsIn(crawl, block, prefix, match = () => true) {
  const url = `${BASE}/${crawl}/indexes/${block.file}`
  let buf
  try {
    buf = await fetchRange(url, block.offset, block.offset + block.length - 1)
  } catch {
    return []
  }
  if (!buf) return []
  let text
  try {
    text = gunzipSync(buf).toString('utf8')
  } catch {
    return []
  }
  const out = []
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
    // A cdxj line is `surt_key timestamp {json}` — the capture time lives in the line,
    // not in the JSON, and reading it off the object silently yields undefined.
    rec.timestamp = line.slice(0, brace).trim().split(/\s+/)[1] ?? null
    if (match(rec)) out.push(rec)
  }
  return out
}

// The archived response body for an index record, via one range request into the WARC.
// Returns { headers, body } — the WARC record is warc-headers, http-headers, body,
// separated by blank lines.
export async function warcPayload(rec) {
  const buf = await fetchRange(
    `${DATA}/${rec.filename}`,
    Number(rec.offset),
    Number(rec.offset) + Number(rec.length) - 1,
  )
  if (!buf) return null
  let raw
  try {
    raw = gunzipSync(buf).toString('utf8')
  } catch {
    return null
  }
  // WARC header block, then the HTTP response, then the body.
  const afterWarc = raw.indexOf('\r\n\r\n')
  if (afterWarc === -1) return null
  const http = raw.slice(afterWarc + 4)
  const afterHttp = http.indexOf('\r\n\r\n')
  if (afterHttp === -1) return null
  return { headers: http.slice(0, afterHttp), body: http.slice(afterHttp + 4) }
}
