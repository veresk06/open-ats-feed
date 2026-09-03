#!/usr/bin/env node
// Push the directory's URLs to Bing and Yandex via IndexNow.
//
// Why this exists: the site is the only distribution channel nobody can close, but a brand-new
// GitHub Pages subdirectory is not in anyone's crawl queue. Waiting to be discovered is not a
// plan. IndexNow is the one submission API that needs no account, no verification and no human
// — the proof of ownership is a public key file served from the same directory as the URLs.
//
// Google does not participate in IndexNow. This buys Bing, Yandex, Seznam and Naver, which is
// two of the engines a buyer might plausibly use and zero of the one they probably use. It is
// worth doing because it costs nothing and it is measurable; it is not a substitute for Google,
// and Google needs Search Console, which needs the operator.
//
// The key file lives at docs/<key>.txt and is served from the site root path. IndexNow scopes a
// key to the directory it is served from and below, so a key under /open-ats-feed/ authorises
// exactly our URLs on the shared veresk06.github.io host and nothing else. build-site.mjs does
// not clear it — it removes only the files it writes.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = 'veresk06.github.io'
const KEY = '459511ab79549efefdc61ce2d6433073'
const KEY_LOCATION = `https://${HOST}/open-ats-feed/${KEY}.txt`

// Endpoints share one network — submitting to any participating engine propagates to the rest —
// but they are listed separately so a single engine being down is visible rather than silent.
const ENDPOINTS = ['https://api.indexnow.org/indexnow', 'https://yandex.com/indexnow']

const sitemap = readFileSync(join(ROOT, 'docs/sitemap.xml'), 'utf8')
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
if (urlList.length === 0) throw new Error('sitemap.xml contained no <loc> entries')

// Refuse to submit URLs the key does not cover — a mismatch is rejected as 403 and, worse,
// repeated 403s are how a key gets distrusted.
const prefix = KEY_LOCATION.slice(0, KEY_LOCATION.lastIndexOf('/') + 1)
const outside = urlList.filter((u) => !u.startsWith(prefix))
if (outside.length) throw new Error(`URLs outside the key's scope ${prefix}: ${outside.join(', ')}`)

// The key file must already be live: the engine fetches it to verify ownership. Checking here
// turns "submitted, silently rejected later" into a failure we can read.
const keyRes = await fetch(KEY_LOCATION)
const keyBody = keyRes.ok ? (await keyRes.text()).trim() : ''
if (keyBody !== KEY) {
  throw new Error(`key file not live at ${KEY_LOCATION} — HTTP ${keyRes.status}, body ${JSON.stringify(keyBody.slice(0, 40))}. Push docs/ first.`)
}
console.log(`key verified live: ${KEY_LOCATION}`)

const payload = JSON.stringify({ host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList })

let failed = 0
for (const endpoint of ENDPOINTS) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: payload,
    })
    const body = (await res.text()).trim()
    // 200 = accepted, 202 = accepted, key validation pending. Anything else is a real failure.
    const ok = res.status === 200 || res.status === 202
    if (!ok) failed++
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${res.status} ${endpoint}${body ? ` — ${body.slice(0, 200)}` : ''}`)
  } catch (err) {
    failed++
    console.log(`FAIL ---  ${endpoint} — ${err.message}`)
  }
}

console.log(`${urlList.length} URLs submitted to ${ENDPOINTS.length - failed}/${ENDPOINTS.length} endpoints`)
process.exit(failed === ENDPOINTS.length ? 1 : 0)
