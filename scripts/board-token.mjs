#!/usr/bin/env node
// Board-token classification — read the company's industry out of the board token, and audit it
// on false positives before trusting a single row of it.
//
// WHY THIS EXISTS. Cycle 22 shipped a board prior that infers a board's role family from the
// families its own *titles* resolve to. That method has a ceiling it cannot see past: it
// propagates the keyword classifier's mistakes. The worked example was `lever/jetsetpilates`, a
// Pilates studio whose 168 postings titled `Instructor - <city>` read as `education` — correct
// from the title alone, wrong about the company, and invisible to leave-one-out because the truth
// labels are wrong the same way. The word "pilates" appears only in the board token, never in a
// title. The token is public metadata we already ship, and it is exactly what a human reads.
//
// THE TRAP, NAMED IN ADVANCE. A substring in a token is not a fact about a company. `svetness` —
// the largest board in the entire corpus, 4,981 postings — contains `vet` and is a tutoring
// staffing agency. `oneacrefundmalawi` contains `law`. `spacex` contains `spa`. 109 of the 185
// tokens containing `care` contain it only because they end in `careers`. So every key carries an
// explicit blocker list, and this script reports how many matches each blocker killed rather than
// asserting that the list is complete.
//
// TWO USES, AND ONLY ONE OF THEM IS AUDITABLE. Say this plainly because it bounds the result:
//
//   Use 1 — FILL. Assign a family to a board the title prior left blank: 399 of the 500 censused
//     boards have no usable prior, and 9,697 boards were never censused at all. Here the token
//     adds information rather than contradicting any. This is what ships.
//   Use 2 — OVERRIDE. Correct a board where the titles are confidently wrong (jetsetpilates).
//     This is the case the token was wanted for, and it is NOT attempted, because validating it
//     needs ground truth we do not have. Measuring an override against the labels it exists to
//     overrule would score it wrong by construction.
//
// THE AUDIT. For every board a key fires on that also has readable titles, derive the board's
// modal role family from those titles and compare. That measures the one thing worth knowing
// before use 1: is this key a truthful industry signal at all? Titles come from the cached
// 500-board census where available and are otherwise fetched live from the vendors' public APIs
// — local node, same as snapshot-history.mjs, $0.00 on Apify.
//
// PRE-REGISTERED INCLUSION RULE, fixed before the numbers were seen: a key ships only if it
// agrees with the title-derived modal family on >= 70% of audited boards, over >= 5 audited
// boards. Fewer than 5 audited boards is not evidence and the key is held, not shipped.
//
//   node scripts/board-token.mjs --lexical    lexical audit only, no network
//   node scripts/board-token.mjs              full run, fetches titles for unaudited boards
//   node scripts/board-token.mjs --audit-cap=12

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { explain, PROVIDERS, fetchTitles } from './role-census.mjs'
import { boardCounts, predict, junkShare, MAX_NOT_JOB_SHARE } from './board-prior.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROSTER = resolve(ROOT, 'docs/data/all.csv')
const CENSUS = resolve(ROOT, 'data/role-census-titles.json')
const OUT = resolve(ROOT, 'data/board-token.json')
const CSV = resolve(ROOT, 'docs/data/board-industry.csv')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const LEXICAL_ONLY = process.argv.includes('--lexical')
const AUDIT_CAP = Number(arg('audit-cap', 12))     // boards fetched per key, at most
const BUDGET_MS = Number(arg('budget-secs', 600)) * 1000

// Corporate noise that gets stripped from the end of a token before end-anchored keys are
// matched, so `bondvet`, `cityvetinc` and `lansingpetvet` are all reachable by the same key.
const SUFFIXES = [
  'careers', 'career', 'jobs', 'job', 'inc', 'llc', 'llp', 'ltd', 'limited', 'corp', 'co',
  'group', 'usa', 'us', 'uk', 'global', 'holdings', 'company', 'international',
]

// Ordered, first match wins, most specific first.
//
// mode 'sub'  — plain substring anywhere in the token, voided by `block`.
// mode 'end'  — the token must END with the key once corporate suffixes are stripped. Reserved
//               for keys too short to be safe anywhere else: `vet` matches `svetness`,
//               `fivetran`, `truveta` and `resolvetosavelives` as a substring, and matches
//               `bondvet`, `cityvetinc` and `bolingbrookvet` as a suffix.
//
// Keys deliberately NOT here, each for a measured reason (see the lexical audit output):
//   art     205 hits, all noise — `partners`, `smart`, `instacart`, `heartflow`, `carta`.
//   spa     109 hits, all noise — `spacex`, `aerospace`, `squarespace`, `classpass`, `talkspace`.
//   market   35 hits, and they are marketplaces and trading firms, not marketing — `polymarket`,
//            `thrivemarket`, `misfitsmarket`, `gsrmarkets`.
//   partners 68 hits and it names a legal structure, not an industry.
//   fit      noise — `misfitsmarket`, `outfit7`, `nonprofit`, `benefits`, `fitzmark`.
export const TOKEN_KEYS = [
  // ---- healthcare, provider-shaped first ----
  ['healthcare', 'veterinar', 'sub'],
  ['healthcare', 'vet', 'end'],
  ['healthcare', 'hospice', 'sub'],
  ['healthcare', 'dentist', 'sub'],
  ['healthcare', 'dental', 'sub'],
  ['healthcare', 'orthodon', 'sub'],
  ['healthcare', 'pediatric', 'sub'],
  ['healthcare', 'oncology', 'sub'],
  ['healthcare', 'surgical', 'sub'],
  ['healthcare', 'surgery', 'sub'],
  ['healthcare', 'nursing', 'sub'],
  ['healthcare', 'hospital', 'sub'],
  ['healthcare', 'clinic', 'sub'],
  ['healthcare', 'pharmac', 'sub'],
  ['healthcare', 'psychiatr', 'sub'],
  ['healthcare', 'medical', 'sub'],
  ['healthcare', 'healthcare', 'sub'],
  ['healthcare', 'homehealth', 'sub'],
  // `care` is the single most collision-prone key in the list: 185 tokens contain it and 109 of
  // those contain it only inside `careers`. Kept because what survives the blocker is real
  // (`freedomcare`, `skilledwoundcare`, `pomelocare`, `wovencare`), and reported separately.
  // `daycare` and `childcare` are blockers, not collisions: the word `care` is genuinely there and
  // genuinely means care — of children, which is `education`, not `healthcare`. Without them the
  // education key `daycare` sits behind this one and can never fire. Found by the ordering test,
  // not by reading the list, and it is the same ordering class as the Cycle-22 bug that put 194
  // fitness instructors into education. Zero roster tokens contain `daycare` today, so this is a
  // latent bug fixed before it counted anything, which is the only cheap time to fix one.
  ['healthcare', 'care', 'sub', ['career', 'careers', 'daycare', 'childcare']],
  // `health` is the largest key by hits (293) and the most interesting, because it does not mean
  // one thing: `athomehealth` and `missionhealthcare` are care providers, `springhealth`,
  // `cloverhealth` and `nexhealth` are software companies whose postings are engineering and
  // sales. The audit is what decides whether it ships, and it is the key most likely to fail.
  ['healthcare', 'health', 'sub'],

  // ---- fitness ----
  ['fitness_wellness', 'crossfit', 'sub'],
  ['fitness_wellness', 'fitness', 'sub'],
  ['fitness_wellness', 'pilates', 'sub'],
  ['fitness_wellness', 'yoga', 'sub'],
  ['fitness_wellness', 'wellness', 'sub'],
  // `australianenergymarketoperator` contains `gym` — "ener-**gym**-arket". A three-letter key is
  // one letter-boundary away from nonsense in either direction, which is why `vet` is anchored
  // and this one carries a blocker.
  ['fitness_wellness', 'gym', 'sub', ['energym']],

  // ---- education ----
  // Reachable only because `care` blocks on it — see the blocker note above. One roster board
  // today (`greenhouse/thomasvillechildcare`, 2 postings), which without this key would have been
  // silently dropped by the same fix that stopped it being called healthcare.
  ['education', 'childcare', 'sub'],
  ['education', 'montessori', 'sub'],
  ['education', 'preschool', 'sub'],
  ['education', 'daycare', 'sub'],
  ['education', 'charterschool', 'sub'],
  ['education', 'school', 'sub'],
  ['education', 'academy', 'sub'],
  ['education', 'tutor', 'sub'],
  ['education', 'universit', 'sub'],
  ['education', 'college', 'sub'],
  ['education', 'campus', 'sub'],
  ['education', 'education', 'sub'],

  // ---- retail and food ----
  ['retail_food', 'restaurant', 'sub'],
  ['retail_food', 'coffee', 'sub'],
  ['retail_food', 'pizza', 'sub'],
  ['retail_food', 'burger', 'sub'],
  ['retail_food', 'brewing', 'sub'],
  ['retail_food', 'brewery', 'sub'],
  ['retail_food', 'bakery', 'sub'],
  ['retail_food', 'grocery', 'sub'],
  ['retail_food', 'foods', 'sub'],
  ['retail_food', 'retail', 'sub'],
  ['retail_food', 'salon', 'sub'],

  // ---- trades and logistics ----
  ['skilled_trades', 'plumbing', 'sub'],
  ['skilled_trades', 'hvac', 'sub'],
  ['skilled_trades', 'roofing', 'sub'],
  ['skilled_trades', 'landscap', 'sub'],
  ['skilled_trades', 'restoration', 'sub'],
  ['skilled_trades', 'construction', 'sub'],
  ['skilled_trades', 'contractor', 'sub'],
  ['logistics', 'logistics', 'sub'],
  ['logistics', 'freight', 'sub'],
  ['logistics', 'trucking', 'sub'],
  ['logistics', 'courier', 'sub'],
  ['logistics', 'warehouse', 'sub'],

  // ---- corporate / professional services ----
  ['corporate', 'staffing', 'sub'],
  ['corporate', 'recruit', 'sub'],
  ['corporate', 'insurance', 'sub'],
  ['corporate', 'mortgage', 'sub'],
  ['corporate', 'realestate', 'sub'],
  ['corporate', 'realty', 'sub'],
  ['corporate', 'wealth', 'sub'],
  ['corporate', 'accounting', 'sub'],
  ['corporate', 'financial', 'sub'],
  ['corporate', 'capital', 'sub'],
  ['corporate', 'bank', 'sub', ['burbank', 'bankok']],
  ['corporate', 'attorney', 'sub'],
  ['corporate', 'consulting', 'sub'],
  // `law` needs four blockers to be usable at all, and even then it does not separate a law firm
  // (`parnalllaw`, `blbglaw`) from legal software (`everlaw`, `lawmatics`, `rocketlawyer`).
  // Included so the audit can say which way it goes rather than assuming.
  ['corporate', 'law', 'sub', ['malawi', 'delaware', 'claw', 'lawn', 'lawson', 'lawrence']],
  ['corporate', 'legal', 'sub'],

  // ---- the industry-is-not-the-role test group ----
  //
  // These are honest industry markers and that is exactly why they are suspect: a software
  // company's postings are not all engineering, and a board token cannot say what share is.
  // They are in the list so the audit answers the question with a number instead of an opinion.
  ['engineering', 'software', 'sub'],
  ['engineering', 'robotics', 'sub'],
  ['engineering', 'cybersec', 'sub'],
  ['engineering', 'technologies', 'sub'],
  ['engineering', 'labs', 'sub'],
]

// A key match is void if every occurrence of it sits inside an occurrence of a blocker.
export const blocked = (token, key, blockers) => {
  if (!blockers || !blockers.length) return false
  const spans = []
  for (const b of blockers) {
    let i = token.indexOf(b)
    while (i !== -1) { spans.push([i, i + b.length]); i = token.indexOf(b, i + 1) }
  }
  if (!spans.length) return false
  let i = token.indexOf(key)
  while (i !== -1) {
    const j = i + key.length
    if (!spans.some(([s, e]) => i >= s && j <= e)) return false   // one free occurrence is enough
    i = token.indexOf(key, i + 1)
  }
  return true
}

export const stripSuffixes = (token) => {
  let t = token.replace(/[^a-z0-9]/g, '')
  let changed = true
  while (changed) {
    changed = false
    t = t.replace(/[0-9]+$/, (m) => { changed = changed || m.length > 0; return '' })
    for (const s of SUFFIXES) {
      if (t.length > s.length + 2 && t.endsWith(s)) { t = t.slice(0, -s.length); changed = true; break }
    }
  }
  return t
}

// First match wins. Returns the family, the key that fired, and the keys that were blocked on
// the way — the blocked list is what makes the collision audit possible.
export const classifyToken = (rawToken, keys = TOKEN_KEYS) => {
  const token = String(rawToken || '').toLowerCase()
  const stripped = stripSuffixes(token)
  const blockedBy = []
  for (const [family, key, mode, blockers] of keys) {
    if (mode === 'end') {
      if (stripped.endsWith(key)) return { family, key, mode, blockedBy }
      continue
    }
    if (!token.includes(key)) continue
    if (blocked(token, key, blockers)) { blockedBy.push(key); continue }
    return { family, key, mode, blockedBy }
  }
  return { family: null, key: null, mode: null, blockedBy }
}

// The board's modal role family as its own titles report it — the yardstick the token is audited
// against. Same machinery as the Cycle-22 board prior, deliberately: a different one would make
// the two results incomparable.
export const titleFamily = (titles) => {
  const families = titles.map((t) => explain(t).family)
  const junk = junkShare(families)
  if (junk >= MAX_NOT_JOB_SHARE) return { family: null, reason: 'junk_board', junk }
  const p = predict(boardCounts(families))
  if (!p) return { family: null, reason: 'no_resolved_titles', junk }
  return { family: p.family, support: p.support, confidence: p.confidence, junk }
}

const parseRoster = (text) => text.trim().split('\n').slice(1).map((line) => {
  const [provider, token, postings] = line.split(',')
  return { provider, token, postings: Number(postings) }
}).filter((r) => r.provider && r.token && Number.isFinite(r.postings))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchPool(rows, deadline, onResult) {
  const byProvider = new Map()
  for (const r of rows) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, [])
    byProvider.get(r.provider).push(r)
  }
  await Promise.all([...byProvider.entries()].map(async ([provider, list]) => {
    const cfg = PROVIDERS[provider]
    if (!cfg) return
    let i = 0
    const worker = async () => {
      while (i < list.length) {
        if (Date.now() > deadline) return
        const row = list[i++]
        onResult(row, await fetchTitles(provider, row.token))
        if (cfg.delayMs) await sleep(cfg.delayMs)
      }
    }
    await Promise.all(Array.from({ length: cfg.concurrency }, worker))
  }))
}

const MIN_AGREEMENT = 0.70
const MIN_AUDITED = 5

// Wilson score interval. Used rather than the normal approximation because most keys here have
// n in the single digits, where the normal approximation is simply wrong (it happily returns
// [100%, 100%] for 5 of 5).
export const wilson = (k, n, z = 1.96) => {
  if (!n) return [0, 1]
  const p = k / n
  const d = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / d
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, centre - halfWidth), Math.min(1, centre + halfWidth)]
}

const main = async () => {
  const deadline = Date.now() + BUDGET_MS
  const roster = parseRoster(await readFile(ROSTER, 'utf8'))
  const census = JSON.parse(await readFile(CENSUS, 'utf8'))
  const cachedTitles = new Map(census.map((b) => [`${b.p}/${b.t}`, b.titles]))

  // ---- pass 1: lexical. Every board, every key, no network. ----
  const hits = []                       // boards a key fires on
  const perKey = new Map()
  const keyRow = (key) => {
    if (!perKey.has(key)) {
      const spec = TOKEN_KEYS.find((k) => k[1] === key)
      perKey.set(key, {
        key, family: spec[0], mode: spec[2], blockers: spec[3] || [],
        raw_hits: 0, blocked_hits: 0, fired: 0, fired_postings: 0,
        audited: 0, agreed: 0, examples: [], disagreements: [],
      })
    }
    return perKey.get(key)
  }
  for (const [family, key] of TOKEN_KEYS) keyRow(key)

  // Raw substring hits, i.e. what a naive matcher would have taken. Counted separately from what
  // actually fires, because the gap between the two IS the collision damage.
  for (const [, key, mode, blockers] of TOKEN_KEYS) {
    if (mode === 'end') continue
    for (const b of roster) {
      if (!b.token.includes(key)) continue
      keyRow(key).raw_hits++
      if (blocked(b.token, key, blockers)) keyRow(key).blocked_hits++
    }
  }

  let boardsClassified = 0
  let postingsClassified = 0
  for (const b of roster) {
    const c = classifyToken(b.token)
    if (!c.key) continue
    const row = keyRow(c.key)
    row.fired++
    row.fired_postings += b.postings
    if (row.examples.length < 8) row.examples.push(b.token)
    boardsClassified++
    postingsClassified += b.postings
    hits.push({ ...b, ...c })
  }

  const lexical = {
    roster_boards: roster.length,
    roster_postings: roster.reduce((s, b) => s + b.postings, 0),
    boards_classified: boardsClassified,
    boards_classified_share: +(boardsClassified / roster.length).toFixed(4),
    postings_classified: postingsClassified,
  }

  process.stdout.write(`lexical: ${boardsClassified.toLocaleString()} of ${roster.length.toLocaleString()} boards ` +
    `(${(100 * boardsClassified / roster.length).toFixed(1)}%) get a token family, ` +
    `covering ${postingsClassified.toLocaleString()} postings\n`)

  if (LEXICAL_ONLY) {
    await writeFile(OUT, `${JSON.stringify({ lexical, keys: [...perKey.values()] }, null, 2)}\n`)
    process.stdout.write(`wrote ${OUT} (lexical only)\n`)
    return
  }

  // ---- pass 2: audit. Compare the token's family against the board's own titles. ----
  //
  // Cached census boards are free and are always used. Beyond those, up to AUDIT_CAP boards per
  // key are fetched live — capped per key rather than globally so a 293-hit key does not consume
  // the whole budget and leave a 7-hit key unaudited.
  const toFetch = []
  const auditQueue = []
  const perKeyFetch = new Map()
  for (const h of hits) {
    const cached = cachedTitles.get(`${h.provider}/${h.token}`)
    if (cached) { auditQueue.push({ ...h, titles: cached, source: 'census_cache' }); continue }
    const n = perKeyFetch.get(h.key) || 0
    if (n >= AUDIT_CAP) continue
    perKeyFetch.set(h.key, n + 1)
    toFetch.push(h)
  }
  // Biggest boards first: a wrong call on a 4,981-posting board costs more than on a 3-posting one.
  toFetch.sort((a, z) => z.postings - a.postings)

  process.stdout.write(`audit: ${auditQueue.length} boards from the census cache, fetching ${toFetch.length} more\n`)
  let fetched = 0
  let failed = 0
  await fetchPool(toFetch, deadline, (row, out) => {
    if (!out?.ok || !out.titles.length) { failed++; return }
    fetched++
    auditQueue.push({ ...row, titles: out.titles, source: 'live' })
  })
  process.stdout.write(`audit: fetched ${fetched}, ${failed} unreadable\n`)

  const audited = []
  for (const a of auditQueue) {
    const truth = titleFamily(a.titles)
    if (!truth.family) continue
    const row = keyRow(a.key)
    row.audited++
    const agree = truth.family === a.family
    if (agree) row.agreed++
    else if (row.disagreements.length < 8) {
      row.disagreements.push({ board: `${a.provider}/${a.token}`, token_says: a.family, titles_say: truth.family, postings: a.postings })
    }
    audited.push({
      board: `${a.provider}/${a.token}`, key: a.key, token_family: a.family,
      title_family: truth.family, agree, postings: a.postings, source: a.source,
      title_confidence: +truth.confidence.toFixed(3), titles_read: a.titles.length,
    })
  }

  for (const row of perKey.values()) {
    row.agreement = row.audited ? +(row.agreed / row.audited).toFixed(4) : null
    row.ships = Boolean(row.audited >= MIN_AUDITED && row.agreement >= MIN_AGREEMENT)
    row.verdict = row.audited < MIN_AUDITED ? 'held_too_few_audited'
      : row.ships ? 'ships' : 'rejected_low_agreement'

    // Is this number a sample or a census? It decides which uncertainty applies, and getting it
    // wrong in either direction is a real misstatement. `dental` fires on 11 boards in the whole
    // roster and all 11 were audited: there is no sampling error in that 82%, because there was
    // no sampling — but it also carries no guarantee for a dental board added next month. Where
    // only a fraction was audited, the Wilson interval is the honest width.
    row.audited_share_of_fired = row.fired ? +(row.audited / row.fired).toFixed(3) : 0
    row.basis = row.fired && row.audited >= row.fired ? 'population_census' : 'sample'
    const [lo, hi] = wilson(row.agreed, row.audited)
    row.agreement_ci95 = row.audited ? [+lo.toFixed(3), +hi.toFixed(3)] : null
    // Only meaningful for a sample. Reported for both so nobody has to recompute it, but the
    // `basis` field says whether it is the right question to ask.
    row.ci_lower_clears_bar = Boolean(row.audited && lo >= MIN_AGREEMENT)
  }

  const keys = [...perKey.values()].sort((a, z) => z.fired - a.fired)
  const shipping = new Set(keys.filter((k) => k.ships).map((k) => k.key))

  // What the surviving keys actually buy, which is the only number that matters.
  const shippedKeys = TOKEN_KEYS.filter(([, k]) => shipping.has(k))
  const auditByBoard = new Map(audited.map((a) => [a.board, a]))
  let boardsShipped = 0
  let postingsShipped = 0
  const byFamily = new Map()
  const csvRows = []
  for (const b of roster) {
    const c = classifyToken(b.token, shippedKeys)
    if (!c.key) continue
    boardsShipped++
    postingsShipped += b.postings
    byFamily.set(c.family, (byFamily.get(c.family) || 0) + 1)
    // Every published row carries what checking it produced, including when checking contradicted
    // it. A row we know disagrees with its own board's titles is more useful labelled than dropped
    // — dropping it would quietly raise the CSV's apparent accuracy by hiding the misses.
    const a = auditByBoard.get(`${b.provider}/${b.token}`)
    csvRows.push({
      provider: b.provider,
      token: b.token,
      open_postings: b.postings,
      industry_family: c.family,
      matched_key: c.key,
      title_family: a ? a.title_family : '',
      checked: a ? (a.agree ? 'agrees' : 'disagrees') : 'unchecked',
    })
  }

  const overallAudited = keys.reduce((s, k) => s + k.audited, 0)
  const overallAgreed = keys.reduce((s, k) => s + k.agreed, 0)

  const result = {
    generated_at: new Date().toISOString(),
    source: 'docs/data/all.csv (10,197 boards) + data/role-census-titles.json + live vendor APIs',
    question: 'does a board token predict the role family of that board\'s postings',
    method: {
      matching: 'ordered keyword list, first match wins; substring or end-anchored, with an explicit per-key blocker list',
      yardstick: 'the modal role family of the board\'s own titles, via the same predict() the Cycle-22 board prior uses',
      inclusion_rule: `pre-registered before the numbers were seen: agreement >= ${MIN_AGREEMENT} over >= ${MIN_AUDITED} audited boards`,
      limit_use_1_only: 'this validates FILLING a board with no title evidence; it does NOT validate OVERRIDING a confident title prior, which is the jetsetpilates case the token was wanted for. Measuring an override against the labels it exists to overrule would score it wrong by construction.',
      limit_yardstick_is_not_truth: 'the yardstick is the keyword classifier\'s own modal label, so agreement is agreement, not correctness — the same caveat that applies to the board prior',
    },
    lexical,
    audit: {
      boards_audited: overallAudited,
      agreement_overall: overallAudited ? +(overallAgreed / overallAudited).toFixed(4) : null,
      from_census_cache: audited.filter((a) => a.source === 'census_cache').length,
      fetched_live: audited.filter((a) => a.source === 'live').length,
      unreadable: failed,
    },
    shipped: {
      keys: [...shipping],
      keys_rejected: keys.filter((k) => k.verdict === 'rejected_low_agreement').map((k) => k.key),
      keys_held: keys.filter((k) => k.verdict === 'held_too_few_audited').map((k) => k.key),
      boards: boardsShipped,
      boards_share: +(boardsShipped / roster.length).toFixed(4),
      postings: postingsShipped,
      by_family: Object.fromEntries([...byFamily.entries()].sort((a, z) => z[1] - a[1])),
    },
    keys,
    audited,
  }
  await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`)

  // Public artifact. Deliberately NOT one row per roster board: 10,197 rows of which 10,010 are
  // blank would overstate what this method reaches. Only the boards a surviving key fires on,
  // each with the key that fired and what checking it against the board's own titles produced.
  const header = 'provider,token,open_postings,industry_family,matched_key,title_family,checked'
  csvRows.sort((a, z) => z.open_postings - a.open_postings)
  await writeFile(CSV, `${[header, ...csvRows.map((r) => Object.values(r).join(','))].join('\n')}\n`)

  process.stdout.write('\nkey            family            fired  raw  blkd  audit  agree  ci95        basis      verdict\n')
  for (const k of keys) {
    if (!k.fired && !k.raw_hits) continue
    const ci = k.agreement_ci95 ? `[${(100 * k.agreement_ci95[0]).toFixed(0)}-${(100 * k.agreement_ci95[1]).toFixed(0)}%]` : '-'
    process.stdout.write(
      `${k.key.padEnd(14)} ${k.family.padEnd(17)} ${String(k.fired).padStart(5)} ` +
      `${String(k.raw_hits).padStart(4)} ${String(k.blocked_hits).padStart(5)} ` +
      `${String(k.audited).padStart(6)} ${k.agreement === null ? '    - ' : `${(100 * k.agreement).toFixed(0).padStart(5)}%`} ` +
      `${ci.padEnd(11)} ${(k.basis === 'population_census' ? 'census' : 'sample').padEnd(10)} ${k.verdict}\n`)
  }
  process.stdout.write(`\noverall agreement ${(100 * overallAgreed / overallAudited).toFixed(1)}% over ${overallAudited} audited boards\n`)
  process.stdout.write(`shipping ${shipping.size} of ${keys.length} keys -> ${boardsShipped} boards ` +
    `(${(100 * boardsShipped / roster.length).toFixed(2)}% of the roster), ${postingsShipped.toLocaleString()} postings\n`)
  process.stdout.write(`wrote ${OUT}\nwrote ${CSV} (${csvRows.length} rows)\n`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
