#!/usr/bin/env node
// Role census — what is actually *in* the feed.
//
// We have measured the roster to death (10,197 live boards, 291,507 open postings) and never
// once measured what those postings are. The head of our own distribution is `svetness` (4,981,
// tutoring staffing), `boxlunch`, `eosfitness`, `bayada`, `liquidpersonnel` — staffing, retail
// and healthcare. So the headline number is far less developer-facing than "ATS job feed"
// implies, and the positioning follows from a fact nobody has checked.
//
// Design: stratified, not random. Board size is extremely skewed (top 500 boards = 50.7% of
// postings, median board = 9), so a uniform sample would be dominated by nine-posting boards
// and would answer a different question than "what is in the feed".
//
//   Stratum HEAD — the top --head boards by open_postings. Censused, not sampled: every
//     posting in this stratum is read, so its contribution carries no sampling error.
//   Stratum TAIL — a deterministic sample of --tail boards from everything below the head,
//     weighted up by (tail_postings_total / tail_postings_sampled).
//
// Classification is keyword-on-title, first match wins, order matters (see FAMILIES). It is
// deliberately coarse and deliberately auditable: every unmatched title lands in `other` and
// the top unmatched titles are printed so the next run can close the gap. A title classifier
// that silently buckets everything is worse than one that admits what it missed.
//
//   node scripts/role-census.mjs                       head 300, tail 300
//   node scripts/role-census.mjs --head=500 --tail=500 --budget-secs=900
//
// Writes data/role-census.json. Costs $0.00 on Apify — this is local node against the
// vendors' public APIs, same as snapshot-history.mjs.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROSTER = resolve(ROOT, 'docs/data/all.csv')
const OUT = resolve(ROOT, 'data/role-census.json')
const CACHE = resolve(ROOT, 'data/role-census-titles.json')
const ENG_CSV = resolve(ROOT, 'docs/data/engineering.csv')
const FROM_CACHE = process.argv.includes('--from-cache')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const HEAD_N = Number(arg('head', 300))
const TAIL_N = Number(arg('tail', 300))
const BUDGET_MS = Number(arg('budget-secs', 900)) * 1000
const started = Date.now()
const budgetLeft = () => BUDGET_MS - (Date.now() - started)

// First match wins. Ordering is load-bearing: "software engineer" must beat the bare "engineer"
// that also catches "maintenance engineer", and clinical titles must beat "technician".
export const FAMILIES = [
  // Deliberately first. These are not a job family, they are a data-quality finding: the ATS
  // corpus carries open-ended "work from home / be your own boss" recruitment ads, which are
  // the classic MLM and commission-only signature. A buyer filtering for real openings needs
  // them named, and no competitor in this category publishes the fact that they are in there.
  ['suspect_recruitment_ad', [
    'work from home', 'work at home', 'be your own boss', 'unlimited income',
    'income being capped', 'someone else s dream', 'break free of the 9 5', 'another way',
    'burned out from the 9 5', 'take back control of your time', 'remote opportunity',
    'no experience necessary', 'earn from home', 'financial freedom',
  ]],
  // Second data-quality finding, run 2: the corpus carries **unpaid** listings on real ATS
  // boards — "hospice volunteer (unpaid)", "private equity event volunteer". A buyer paying per
  // delivered row is paying for rows that are not jobs. Named for the same reason as the ads.
  ['volunteer_unpaid', [
    'volunteer', 'unpaid intern', 'pro bono',
  ]],
  ['engineering', [
    'software engineer', 'software developer', 'backend', 'back end', 'back-end', 'frontend',
    'front end', 'front-end', 'full stack', 'fullstack', 'full-stack', 'devops', 'site reliability',
    ' sre', 'platform engineer', 'data engineer', 'machine learning', ' ml ', 'ai engineer',
    'data scientist', 'security engineer', 'qa engineer', 'test engineer', 'automation engineer',
    'mobile engineer', 'ios engineer', 'android engineer', 'ios developer', 'android developer',
    'web developer', 'programmer', 'software architect', 'solutions architect', 'cloud engineer',
    'infrastructure engineer', 'systems engineer', 'network engineer', 'firmware', 'embedded',
    'developer advocate', 'engineering manager', 'staff engineer', 'principal engineer',
    'senior engineer', 'software qa', 'sdet', 'database administrator', 'data analyst',
    'analytics engineer', 'application engineer', 'integration engineer', 'api engineer',
    // Run 2. The largest single thing left in `other` was software work that never says
    // "software": named stacks, and lead titles that drop the noun entirely.
    'laravel', 'react', 'angular', 'vue ', 'node js', 'nodejs', 'python', 'golang', ' java ',
    'javascript', 'typescript', 'ruby on rails', ' rails ', ' php ', ' net ', 'kotlin',
    'salesforce', 'sharepoint', 'servicenow',
    'engineering lead', 'technical lead', 'tech lead', 'lead engineer', 'lead developer',
    'product engineer', 'principal software', 'staff software', 'software qa', 'sre ',
    'devsecops', 'data platform', 'bioinformatic', 'computer vision', 'nlp ', 'llm ',
    'cybersecurity', 'cyber security', 'penetration test', 'blockchain', 'smart contract',
    'game developer', 'unity developer', 'unreal', 'technical program manager',
    'technical writer', 'solution engineer', 'forward deployed',
  ]],
  // Run 2, and it makes the headline *smaller*, which is the point. `engineering` is used as a
  // proxy for "developer-facing", so physical-world engineering must not be counted into it.
  // Must be matched before the bare `engineer` / `developer` catch at the bottom of this list.
  ['engineering_nonsoftware', [
    'electrical engineer', 'mechanical engineer', 'civil engineer', 'structural engineer',
    'chemical engineer', 'industrial engineer', 'manufacturing engineer', 'process engineer',
    'quality engineer', 'environmental engineer', 'geotechnical', 'petroleum engineer',
    'mining engineer', 'aerospace engineer', 'field engineer', 'service engineer',
    'maintenance engineer', 'project engineer', 'design engineer', 'packaging engineer',
    'facilities engineer', 'sales engineer', 'stationary engineer', 'building engineer',
    'controls engineer', 'safety engineer', 'engineering technician', 'cad ', 'drafter',
    'surveyor', 'architect -', 'estimator',
  ]],
  ['healthcare', [
    'nurse', ' rn ', 'rn -', 'lpn', 'cna ', 'certified nursing', 'physician', 'clinician',
    'clinical', 'therapist', 'therapy', 'caregiver', 'care giver', 'home health', 'hha',
    'medical assistant', 'pharmac', 'dental', 'dentist', 'radiolog', 'phlebotom', 'sonograph',
    'respiratory', 'surgical tech', 'patient care', 'behavioral health', 'social worker',
    'psychiatr', 'psycholog', 'veterinar', 'paramedic', 'emt', 'midwife', 'optometr',
    'occupational health', 'speech language', 'dietitian', 'nursing',
  ]],
  ['education', [
    'tutor', 'teacher', 'teaching', 'instructor', 'educator', 'paraprofessional', 'professor',
    'lecturer', 'curriculum', 'substitute', 'preschool', 'childcare', 'child care',
    'school psycholog', 'principal -', 'academic',
  ]],
  ['skilled_trades', [
    'technician', 'electrician', 'plumber', 'hvac', 'welder', 'mechanic', 'machinist',
    'maintenance', 'installer', 'carpenter', 'construction', 'foreman', 'lineman', 'millwright',
    'field service', 'laborer', 'painter', 'roofer',
  ]],
  ['logistics', [
    'driver', 'cdl', 'warehouse', 'forklift', 'delivery', 'courier', 'picker', 'packer',
    'dispatcher', 'logistics', 'supply chain', 'fulfillment', 'material handler', 'loader',
    'shipping', 'freight', 'yard ',
  ]],
  ['retail_food', [
    'sales associate', 'cashier', 'store manager', 'retail', 'barista', 'cook', 'server -',
    'waiter', 'waitress', 'bartender', 'restaurant', 'shift lead', 'shift supervisor', 'busser',
    'dishwasher', 'host/hostess', 'crew member', 'team member', 'stocker', 'merchandiser',
    'housekeep', 'janitor', 'custodian', 'security officer', 'security guard', 'front desk',
    'concierge', 'valet', 'kitchen',
  ]],
  ['sales_marketing', [
    'account executive', 'sales', 'business development', 'bdr', 'sdr', 'marketing', 'growth',
    'account manager', 'customer success', 'partnerships', 'brand ', 'content strategist',
    'seo', 'demand generation', 'revenue operations', 'solutions consultant', 'pre-sales',
    'copywriter', 'communications', 'public relations',
  ]],
  ['product_design', [
    'product manager', 'product owner', 'designer', ' ux', 'ux ', ' ui', 'user experience',
    'user research', 'product design', 'graphic design', 'creative director', 'art director',
    'illustrator', 'motion design',
  ]],
  ['corporate', [
    'accountant', 'accounting', 'finance', 'controller', 'auditor', 'tax ', 'payroll',
    'recruiter', 'talent acquisition', 'human resources', ' hr ', 'people operations',
    'legal', 'counsel', 'paralegal', 'compliance', 'procurement', 'office manager',
    'executive assistant', 'administrative assistant', 'operations manager', 'project manager',
    'program manager', 'business analyst', 'consultant', 'strategy', 'chief ', 'president',
    'vice president', 'director of', 'coordinator', 'specialist', 'analyst',
  ]],
  ['support', [
    'customer support', 'customer service', 'support engineer', 'technical support',
    'help desk', 'helpdesk', 'call center', 'contact center', 'client services',
  ]],
  // Added after run 1: `personal trainer` alone was 4,539 titles and the single largest thing
  // in `other`. One board (`eosfitness`) carries most of it.
  ['fitness_wellness', [
    'personal trainer', 'personal training', 'fitness', 'kids club', 'gym ', 'membership advisor',
    'member experience', 'spa ', 'yoga', 'pilates', 'wellness', 'massage',
  ]],
  // Also added after run 1: generic store-management titles that carry no industry word.
  // "part-time assistant manager - level 1" was 901 titles on its own.
  ['retail_food_generic', [
    'assistant manager', 'general manager', 'store associate', 'service associate',
    'sales representative', 'seasonal', 'product guide', 'car detailer',
  ]],
  // The roster is not English-only and pretending otherwise inflates `other`. This is a
  // partial French pass covering what run 1 actually surfaced, not a real i18n classifier —
  // labelled `non_english` rather than folded into the English families, so the limitation
  // stays visible in the output instead of being hidden by it.
  ['non_english', [
    'h f', 'temps plein', 'temps partiel', 'vendeur', 'vendeuse', 'auxiliaire de vie',
    'aide a domicile', 'chargé', 'charge de', 'responsable', 'stage ', 'alternance',
    'conseiller', 'assistante', 'technicien', 'ingénieur', 'ingenieur',
    // Run 2: the tail is not only French. Portuguese, Spanish and Italian all showed up in the
    // unmatched list — `consultor(a) comercial externo`, `agente di commercio`, `vaga afirmativa`.
    'consultor', 'comercial', 'vaga', 'analista', 'gerente', 'auxiliar', 'estagi',
    'agente di', 'commercio', 'addetto', 'impiegat', 'operaio', 'stagista',
    'gestor', 'atendimento', 'desenvolvedor', 'ventas', 'asesor', 'mitarbeiter',
    'praktikum', 'ausbildung', 'werkstudent', 'medewerker', 'stagiair',
  ]],
  // Run 2, deliberately last: the bare nouns. Everything above has had its shot, so a title
  // still reading `engineer` or `developer` here is not a nurse, a driver or an electrician.
  // Same family label as `engineering` above — the counts merge.
  ['engineering', [
    'engineer', 'developer', 'programmer', ' devops', 'software',
  ]],
  // Also last: generic seniority-only titles that name a level and nothing else. These are the
  // honest residue — we can say they are jobs, we cannot say what kind.
  ['unclassifiable_generic', [
    'associate', 'coordinator', 'specialist', 'assistant', 'manager', 'supervisor',
    'representative', 'lead', 'intern', 'apprentice', 'trainee', 'clerk', 'agent',
    'officer', 'administrator', 'operator', 'attendant', 'aide', 'advisor', 'adviser',
  ]],
]

export const classify = (rawTitle) => {
  const t = ` ${String(rawTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
  for (const [family, keys] of FAMILIES) {
    for (const k of keys) {
      // Keys carrying their own spacing are matched verbatim; the rest are matched loosely.
      const needle = k.includes(' ') ? k.replace(/[^a-z0-9]+/g, ' ') : k.trim()
      if (t.includes(needle)) return family
    }
  }
  return 'other'
}

// Same walk, but reports which key fired. Used by scripts/audit-classifier.mjs: a keyword
// classifier that cannot say *why* it matched cannot be audited, and run 2 added a bare
// `engineer` / `developer` catch that has to be checked rather than trusted.
export const explain = (rawTitle) => {
  const t = ` ${String(rawTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
  for (const [family, keys] of FAMILIES) {
    for (const k of keys) {
      const needle = k.includes(' ') ? k.replace(/[^a-z0-9]+/g, ' ') : k.trim()
      if (t.includes(needle)) return { family, key: k }
    }
  }
  return { family: 'other', key: null }
}

const PROVIDERS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs`,
    titles: (j) => (Array.isArray(j?.jobs) ? j.jobs.map((x) => x?.title) : null),
    concurrency: 12,
    delayMs: 0,
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    titles: (j) => (Array.isArray(j?.jobs) ? j.jobs.map((x) => x?.title) : null),
    concurrency: 12,
    delayMs: 0,
  },
  lever: {
    // api.lever.co/robots.txt asks for Crawl-delay: 1. Honoured here as it is in
    // snapshot-history.mjs — one request per second, single flight.
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    titles: (j) => (Array.isArray(j) ? j.map((x) => x?.text) : null),
    concurrency: 1,
    delayMs: 1000,
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One retry, because Cycle 18 measured this exact failure: `mozilla` and `vanta` both failed a
// first probe on timeout and passed on retry with 90 and 110 live postings. A single-shot probe
// silently drops good boards, and a census that drops the good ones is worse than no census.
async function fetchTitles(provider, token) {
  const cfg = PROVIDERS[provider]
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 20000)
      const res = await fetch(cfg.url(token), {
        signal: ctl.signal,
        headers: { 'user-agent': 'open-ats-feed/role-census (+https://github.com/veresk06/open-ats-feed)' },
      })
      clearTimeout(timer)
      if (!res.ok) return { ok: false, reason: `http_${res.status}` }
      const titles = cfg.titles(await res.json())
      if (titles === null) return { ok: false, reason: 'shape' }
      return { ok: true, titles }
    } catch (err) {
      if (attempt === 1) return { ok: false, reason: err.name === 'AbortError' ? 'timeout' : 'error' }
      await sleep(500)
    }
  }
}

async function runPool(rows, onResult) {
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
        if (budgetLeft() < 20000) return
        const row = list[i++]
        const out = await fetchTitles(provider, row.token)
        onResult(row, out)
        if (cfg.delayMs) await sleep(cfg.delayMs)
      }
    }
    await Promise.all(Array.from({ length: cfg.concurrency }, worker))
  }))
}

const parseCsv = (text) => {
  const lines = text.trim().split('\n')
  return lines.slice(1).map((line) => {
    const [provider, token, open_postings] = line.split(',')
    return { provider, token, postings: Number(open_postings) }
  }).filter((r) => r.provider && r.token && Number.isFinite(r.postings))
}

const main = async () => {
  const roster = parseCsv(await readFile(ROSTER, 'utf8')).sort((a, b) => b.postings - a.postings)
  const head = roster.slice(0, HEAD_N)
  const rest = roster.slice(HEAD_N)

  // Deterministic every-kth sample of the tail. Not random: the run must be reproducible from
  // the roster alone, and Math.random would make the numbers unauditable by anyone else.
  const step = Math.max(1, Math.floor(rest.length / TAIL_N))
  const tail = []
  for (let i = 0; i < rest.length && tail.length < TAIL_N; i += step) tail.push(rest[i])

  const restPostingsTotal = rest.reduce((s, r) => s + r.postings, 0)
  const headPostingsTotal = head.reduce((s, r) => s + r.postings, 0)

  const counts = { head: {}, tail: {} }
  const boardStats = []          // per-board engineering share, for the ranked list
  const unmatched = new Map()
  const failures = { head: 0, tail: 0 }
  let sampledTailPostings = 0
  let readHead = 0
  let readTail = 0

  // Every title read is cached verbatim. Fetching 121,052 titles costs ~5 minutes of a
  // 30-minute cycle; reclassifying them costs nothing. Run 1 spent that 5 minutes and then had
  // to ship a classifier it already knew was 36% short, because there was no time to re-fetch.
  // With the cache, `--from-cache` reclassifies the same corpus in about a second.
  const titleCache = []

  const tally = (stratum) => (row, out) => {
    if (!out?.ok) { failures[stratum]++; return }
    titleCache.push({ p: row.provider, t: row.token, s: stratum, titles: out.titles })
    const bucket = counts[stratum]
    let eng = 0
    for (const title of out.titles) {
      const fam = classify(title)
      bucket[fam] = (bucket[fam] || 0) + 1
      if (fam === 'engineering') eng++
      if (fam === 'other' && title) {
        const key = String(title).toLowerCase().slice(0, 60)
        unmatched.set(key, (unmatched.get(key) || 0) + 1)
      }
    }
    if (stratum === 'head') readHead += out.titles.length
    else { readTail += out.titles.length; sampledTailPostings += out.titles.length }
    boardStats.push({
      provider: row.provider, token: row.token,
      total: out.titles.length, engineering: eng, stratum,
    })
  }

  if (FROM_CACHE) {
    const cached = JSON.parse(await readFile(CACHE, 'utf8'))
    for (const entry of cached) {
      tally(entry.s)({ provider: entry.p, token: entry.t }, { ok: true, titles: entry.titles })
    }
    process.stderr.write(`reclassified ${readHead + readTail} cached titles, no network\n`)
  } else {
    process.stderr.write(`head: ${head.length} boards (${headPostingsTotal} postings claimed)\n`)
    await runPool(head, tally('head'))
    process.stderr.write(`head done, ${readHead} titles read, ${failures.head} failed\n`)

    process.stderr.write(`tail: ${tail.length} of ${rest.length} boards, every ${step}th\n`)
    await runPool(tail, tally('tail'))
    process.stderr.write(`tail done, ${readTail} titles read, ${failures.tail} failed\n`)
    await writeFile(CACHE, JSON.stringify(titleCache))
    process.stderr.write(`cached ${titleCache.length} boards of titles to ${CACHE}\n`)
  }

  // Weight the tail up to the whole tail stratum. The head needs no weighting: it was censused.
  const tailWeight = sampledTailPostings > 0 ? restPostingsTotal / sampledTailPostings : 0
  const families = new Set([...Object.keys(counts.head), ...Object.keys(counts.tail)])
  const combined = {}
  for (const fam of families) {
    const h = counts.head[fam] || 0
    const t = (counts.tail[fam] || 0) * tailWeight
    combined[fam] = { head: h, tail_weighted: Math.round(t), total: Math.round(h + t) }
  }
  const grandTotal = Object.values(combined).reduce((s, v) => s + v.total, 0)
  for (const fam of families) {
    combined[fam].share = grandTotal ? +(100 * combined[fam].total / grandTotal).toFixed(2) : 0
  }

  // The output that is actually useful to someone else: boards ranked by engineering postings,
  // which is a different list from boards ranked by postings.
  const engRanked = boardStats
    .filter((b) => b.engineering > 0)
    .sort((a, b) => b.engineering - a.engineering)
    .slice(0, 200)

  const result = {
    generated_at: new Date().toISOString(),
    method: {
      head_boards: head.length,
      head_postings_claimed: headPostingsTotal,
      head_titles_read: readHead,
      tail_boards_sampled: tail.length,
      tail_boards_total: rest.length,
      tail_step: step,
      tail_postings_total_claimed: restPostingsTotal,
      tail_titles_read: readTail,
      tail_weight: +tailWeight.toFixed(4),
      // Requested vs actually read. Run 1 hit the wall-clock budget partway through the Lever
      // tail (1 req/s, robots.txt), so ~100 requested boards were never probed. That is not a
      // fetch failure and it must not be reported as one; the tail weighting self-corrects,
      // since it divides by postings actually sampled.
      head_boards_read: boardStats.filter((b) => b.stratum === 'head').length,
      tail_boards_read: boardStats.filter((b) => b.stratum === 'tail').length,
      failures,
      note: 'head is a census, tail is a deterministic every-kth sample weighted to the stratum',
    },
    families: Object.fromEntries(
      Object.entries(combined).sort((a, b) => b[1].total - a[1].total)
    ),
    estimated_total_postings: grandTotal,
    engineering_boards_top: engRanked,
    unmatched_top: [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
      .map(([title, n]) => ({ title, n })),
  }
  await writeFile(OUT, JSON.stringify(result, null, 2))
  process.stderr.write(`wrote ${OUT}\n`)

  // The free artifact this census earns: every measured board ranked by engineering postings.
  // Ranking boards by size and ranking them by engineering give different lists — the biggest
  // board in the roster is a tutoring staffing agency — and nobody in this category publishes
  // the second list. Scope is stated in the header rather than implied: these are the boards
  // whose titles were actually read, not the whole 10,197-board roster.
  const csv = ['provider,token,titles_read,engineering,engineering_share,stratum']
  for (const b of boardStats.sort((a, z) => z.engineering - a.engineering)) {
    const share = b.total ? (100 * b.engineering / b.total).toFixed(1) : '0.0'
    csv.push(`${b.provider},${b.token},${b.total},${b.engineering},${share},${b.stratum}`)
  }
  await writeFile(ENG_CSV, `${csv.join('\n')}\n`)
  process.stderr.write(`wrote ${ENG_CSV} (${boardStats.length} boards)\n`)

  for (const [fam, v] of Object.entries(result.families)) {
    process.stdout.write(`${fam.padEnd(18)} ${String(v.total).padStart(8)}  ${String(v.share).padStart(6)}%\n`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
