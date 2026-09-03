#!/usr/bin/env node
// Generate the public board directory at site/ from actor/data/companies.json.
//
// Why this exists: Apify Store search is popularity-ranked, and a 2-user Actor is not
// in the top 100 for any query a buyer would type (measured 2026-09-03, ten queries).
// So the roster ships as a free, statically rendered, Google-indexable directory
// instead — the rows are in the HTML, not fetched, because a client-side-only list
// is invisible to a crawler and that would defeat the whole point.
//
// The roster is not the moat. Dated history is, and it cannot be back-dated.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// GitHub Pages can only serve from the repo root or /docs on a branch, and root
// already has a data/ directory that would collide. So the site lives in docs/,
// alongside the two hand-written notes that were there first — which is why this
// script clears only the files it generates rather than the whole directory.
const OUT = join(ROOT, 'docs')
const SITE_URL = 'https://veresk06.github.io/open-ats-feed'
const REPO_URL = 'https://github.com/veresk06/open-ats-feed'
const ACTOR_URL = 'https://apify.com/sharp_malachite/open-ats-jobs-feed'

const PROVIDERS = {
  greenhouse: {
    label: 'Greenhouse',
    board: (t) => `https://boards.greenhouse.io/${t}`,
    api: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
    apiPattern: 'https://boards-api.greenhouse.io/v1/boards/{token}/jobs',
  },
  ashby: {
    label: 'Ashby',
    board: (t) => `https://jobs.ashbyhq.com/${t}`,
    api: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    apiPattern: 'https://api.ashbyhq.com/posting-api/job-board/{token}',
  },
  lever: {
    label: 'Lever',
    board: (t) => `https://jobs.lever.co/${t}`,
    api: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
    apiPattern: 'https://api.lever.co/v0/postings/{token}?mode=json',
  },
}

// Candidate tokens harvested from the Common Crawl URL index, per provider, before
// any of them were called. Sourced from data/coverage-summary.json (crawlsSwept: 17,
// candidateTokens: 19438). These are the only numbers on the coverage page that do
// not come from companies.json, because a candidate that turned out to be dead is by
// definition not in the roster — so the roster cannot tell you how many there were.
const CANDIDATES = { greenhouse: 10091, ashby: 4386, lever: 4961 }
const CRAWLS_SWEPT = 17

// The Lever projection published on 2026-09-03 and since superseded by the full probe.
// Kept as data rather than prose so the erratum states the same numbers the correction
// was actually made against.
const LEVER_PROJECTION = { sample: 1000, seed: 7, hitRate: 0.347, live: 1721, ci: [1591, 1852] }

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n) => n.toLocaleString('en-US')
const pct = (n, d) => ((n / d) * 100).toFixed(1)

const index = JSON.parse(readFileSync(join(ROOT, 'actor/data/companies.json'), 'utf8'))
const asOf = index.as_of
const totals = index.totals

// The ramp page is the only page here whose numbers go stale, so it is built only
// when a scan exists rather than from a checked-in fallback. A missing scan drops
// the page; it never publishes yesterday's pace as today's.
let scan = null
try {
  scan = JSON.parse(readFileSync(join(ROOT, 'data/market-scan.json'), 'utf8'))
} catch {
  scan = null
}

// live is [[token, openPostings], ...] already sorted descending by the harvest.
const rows = {}
for (const key of Object.keys(PROVIDERS)) {
  rows[key] = [...index.providers[key].live].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

const HEAD = (title, description, path) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE_URL}${path}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE_URL}${path}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400..800&family=DM+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${path.split('/').length > 2 ? '../' : ''}style.css">
</head>
<body>`

const TOPBAR = (here) => `<header class="topbar">
  <a class="wordmark" href="./">Open&nbsp;ATS&nbsp;Index</a>
  <nav>
    ${Object.entries(PROVIDERS).map(([k, p]) =>
      `<a href="./${k}.html"${here === k ? ' aria-current="page"' : ''}>${p.label}</a>`).join('\n    ')}
    <a href="./ramp.html"${here === 'ramp' ? ' aria-current="page"' : ''}>Ramp</a>
    <a href="./coverage.html"${here === 'coverage' ? ' aria-current="page"' : ''}>Coverage</a>
    <a href="./#method"${here === 'method' ? ' aria-current="page"' : ''}>Method</a>
  </nav>
</header>`

const FOOTER = `<footer>
  <p class="serif">Read on ${asOf} by calling each vendor's own public job-board API, unauthenticated,
  once per company. No scraping, no login, no third-party dataset. A board is listed here only if it
  answered and had at least one posting open at that moment.</p>
  <p class="meta">
    <a href="${REPO_URL}">Source and raw data on GitHub</a> ·
    <a href="${REPO_URL}/tree/main/digests">Daily digest series</a> ·
    <a href="${ACTOR_URL}">The same scan, packaged as an Apify Actor</a>
  </p>
</footer>
</body>
</html>`

const row = (p, [token, count]) => `<li class="row"><a class="slug" href="${PROVIDERS[p].board(token)}" rel="nofollow noopener">${esc(token)}</a><span class="leader" aria-hidden="true"></span><span class="count">${num(count)}</span></li>`

// ── index.html ───────────────────────────────────────────────────────────────
const barPct = (n) => ((n / totals.live) * 100).toFixed(2)

const preview = (key) => {
  const p = PROVIDERS[key]
  const t = totals.perProvider[key]
  return `<section class="prov" id="${key}">
  <div class="prov-head">
    <h2><span class="tick tick-${key}"></span>${p.label}</h2>
    <p class="prov-stat"><b>${num(t.live)}</b> boards <span class="sep">·</span> <b>${num(t.postings)}</b> postings open</p>
  </div>
  <p class="endpoint"><code>${esc(p.apiPattern)}</code></p>
  <ol class="rows rows-${key}">
${rows[key].slice(0, 12).map((r) => '    ' + row(key, r)).join('\n')}
  </ol>
  <p class="more"><a href="./${key}.html">See all ${num(t.live)} ${p.label} boards &rarr;</a> <span class="sep">·</span> <a href="./data/${key}.csv" download>CSV</a></p>
</section>`
}

const indexHtml = `${HEAD(
  'Open ATS Index — every company hiring on Greenhouse, Ashby and Lever',
  `${num(totals.live)} verified company job boards and ${num(totals.postings)} open postings, read from the vendors' own public APIs on ${asOf}. Free, downloadable, with the endpoint that produced it.`,
  '/',
)}
${TOPBAR('')}
<main>
<section class="hero">
  <p class="eyebrow">Public register <span class="sep">·</span> read ${asOf}</p>
  <h1>Every company hiring on<br><em class="v-greenhouse">Greenhouse</em>, <em class="v-ashby">Ashby</em><br>and <em class="v-lever">Lever</em>.</h1>
  <p class="lede serif">${num(totals.live)} company job boards, each one confirmed by calling the vendor's
  own public API and finding at least one posting open. ${num(totals.postings)} were open on the day
  of reading. The whole list is here, free, alongside the endpoint that produced it.</p>
  <div class="bars" role="img" aria-label="${Object.entries(PROVIDERS).map(([k, p]) => `${p.label} ${num(totals.perProvider[k].live)} boards`).join(', ')}">
${Object.entries(PROVIDERS).map(([k, p]) => `    <div class="bar bar-${k}" style="--w:${barPct(totals.perProvider[k].live)}%"><span class="bar-label">${p.label}</span><span class="bar-num">${num(totals.perProvider[k].live)}</span></div>`).join('\n')}
  </div>
  ${scan ? `<p class="more"><a href="./ramp.html">${num(scan.breakdown.ramping)} of them opened more roles this month than last &mdash; read today &rarr;</a></p>` : ''}
  <p class="more"><a href="./coverage.html">${pct(
    Object.values(CANDIDATES).reduce((s, n) => s + n, 0) - totals.live,
    Object.values(CANDIDATES).reduce((s, n) => s + n, 0),
  )}% of the board links on the public web are dead ends &mdash; we measured all ${num(
    Object.values(CANDIDATES).reduce((s, n) => s + n, 0),
  )} &rarr;</a></p>
</section>

${Object.keys(PROVIDERS).map(preview).join('\n\n')}

<section class="method" id="method">
  <h2>How the list was made</h2>
  <div class="cols serif">
    <p>Greenhouse, Ashby and Lever each publish a job board API that needs no key and no account.
    Give it a company's board token and it answers with that company's open postings. The hard part
    is not reading a board — it is knowing which tokens exist.</p>
    <p>Those came from the Common Crawl web indexes, CC-MAIN-2024-51 through CC-MAIN-2025-51: every
    URL on the public web pointing at one of the three board hosts, reduced to the distinct token in
    the path. That harvest is a list of candidates, not of companies.</p>
    <p>Every candidate was then called directly, once. ${num(totals.live)} answered with at least one
    open posting and are listed here. ${num(Object.values(totals.perProvider).reduce((s, p) => s + p.empty, 0))}
    answered correctly with an empty board — real companies, nothing open that day — and are not listed.
    The rest did not answer and were dropped.</p>
    <p>So the count beside each company is not an estimate. It is what that endpoint returned on
    ${asOf}. Call it yourself and you should get a similar number, drifting as they hire.</p>
  </div>
  <p class="caveat">One honest limit: a board is only findable here if something on the public web
  linked to it at some point between late 2024 and late 2025. Companies that never linked their board
  anywhere crawlable are missing, and there is no way to count what you cannot see.</p>
</section>

<section class="downloads">
  <h2>Take the data</h2>
  <ul class="dl">
${Object.entries(PROVIDERS).map(([k, p]) => `    <li><a href="./data/${k}.csv" download><span class="dl-name">${p.label.toLowerCase()}.csv</span><span class="dl-meta">${num(totals.perProvider[k].live)} rows &mdash; token, open postings, board URL, API URL</span></a></li>`).join('\n')}
    <li><a href="./data/all.csv" download><span class="dl-name">all.csv</span><span class="dl-meta">${num(totals.live)} rows &mdash; all three providers in one file</span></a></li>
    <li><a href="./data/engineering.csv" download><span class="dl-name">engineering.csv</span><span class="dl-meta">500 rows &mdash; boards ranked by engineering postings, not by size. 121,050 titles read to build it</span></a></li>
    <li><a href="./data/data-quality.csv" download><span class="dl-name">data-quality.csv</span><span class="dl-meta">500 rows &mdash; which boards carry postings that are not paid jobs. 1,411 commission-only recruitment ads sit on 2 boards; one of them is 79&percnt; ads</span></a></li>
    <li><a href="./data/board-roles.csv" download><span class="dl-name">board-roles.csv</span><span class="dl-meta">500 rows &mdash; the role family each board&rsquo;s own postings imply, with the confidence it was inferred at. Blank where the evidence is too thin to say; 101 boards clear the bar</span></a></li>
    <li><a href="./data/board-industry.csv" download><span class="dl-name">board-industry.csv</span><span class="dl-meta">142 rows &mdash; boards whose industry is readable from the board token alone. 81 keywords were tested against 838 boards&rsquo; real postings and 8 survived; each row says whether the check agreed</span></a></li>
    <li><a href="./data/duplication-corpus.csv" download><span class="dl-name">duplication-corpus.csv</span><span class="dl-meta">7 rows &mdash; how much of the corpus is one board posting the same job twice. 3.03&percnt; of postings, from 1,317 boards read live; 7.60&percnt; on boards over 500 postings and zero on boards under 10</span></a></li>
  </ul>
  <p class="serif">Public domain, no attribution required, no signup. If you want the same scan run on
  a schedule with postings normalised and salary parsed out, that is <a href="${ACTOR_URL}">packaged as an
  Actor</a>; the list above is the part that should be free.</p>
</section>
</main>
${FOOTER}`

// ── provider pages ───────────────────────────────────────────────────────────
const providerPage = (key) => {
  const p = PROVIDERS[key]
  const t = totals.perProvider[key]
  const title = `Companies using ${p.label} — ${num(t.live)} public job boards`
  const desc = `Every company with a live ${p.label} job board: ${num(t.live)} verified boards and ${num(t.postings)} open postings, read from ${p.label}'s own public API on ${asOf}. Searchable, free, CSV included.`
  return `${HEAD(title, desc, `/${key}.html`)}
${TOPBAR(key)}
<main>
<section class="hero hero-narrow">
  <p class="eyebrow"><span class="tick tick-${key}"></span>${p.label} <span class="sep">·</span> read ${asOf}</p>
  <h1>Companies using ${p.label}</h1>
  <p class="lede serif">${num(t.live)} companies had a live ${p.label} board with at least one posting open,
  totalling ${num(t.postings)} postings. Each row links to the board a candidate would see; the count is
  what the API returned.</p>
  <p class="endpoint"><code>${esc(p.apiPattern)}</code></p>
</section>

<section class="finder">
  <label class="search">
    <span class="search-label">Search ${num(t.live)} boards</span>
    <input type="search" id="q" placeholder="stripe, spacex, anduril…" autocomplete="off" spellcheck="false">
  </label>
  <p class="readout" id="readout" aria-live="polite">${num(t.live)} boards</p>
</section>

<ol class="rows rows-${key} rows-full" id="list">
${rows[key].map((r) => row(key, r)).join('\n')}
</ol>

<p class="more"><a href="./data/${key}.csv" download>Download ${key}.csv</a> <span class="sep">·</span> <a href="./">All three providers</a></p>
</main>
${FOOTER.replace('</body>', `<script>
(function () {
  var q = document.getElementById('q')
  var list = document.getElementById('list')
  var readout = document.getElementById('readout')
  var items = Array.prototype.slice.call(list.children)
  var total = items.length
  var fmt = function (n) { return n.toLocaleString('en-US') }
  var t
  q.addEventListener('input', function () {
    clearTimeout(t)
    t = setTimeout(function () {
      var v = q.value.trim().toLowerCase()
      var shown = 0
      for (var i = 0; i < total; i++) {
        var hit = !v || items[i].firstChild.textContent.indexOf(v) !== -1
        items[i].hidden = !hit
        if (hit) shown++
      }
      readout.textContent = v
        ? fmt(shown) + ' of ' + fmt(total) + ' boards'
        : fmt(total) + ' boards'
      list.classList.toggle('empty', shown === 0)
    }, 90)
  })
})()
</script>
</body>`)}`
}

// ── coverage.html ────────────────────────────────────────────────────────────
// The one thing here that no competing job-board scraper publishes: what fraction of
// the ATS board links on the public web still resolve to an open board. Everyone
// harvests these tokens; nobody reports how many of them are already dead.
const coveragePage = () => {
  const per = Object.keys(PROVIDERS).map((k) => {
    const cand = CANDIDATES[k]
    const live = totals.perProvider[k].live
    const empty = totals.perProvider[k].empty
    return { k, label: PROVIDERS[k].label, cand, live, empty, dead: cand - live - empty }
  })
  const sum = (f) => per.reduce((s, p) => s + f(p), 0)
  const all = { cand: sum((p) => p.cand), live: sum((p) => p.live), empty: sum((p) => p.empty), dead: sum((p) => p.dead) }
  const notLive = all.cand - all.live

  const title = `How many public ATS job boards are actually dead? We probed ${num(all.cand)}.`
  const desc = `${pct(notLive, all.cand)}% of the Greenhouse, Ashby and Lever board links on the public web no longer lead to an open job board. Every candidate token called once against the vendor's own public API on ${asOf}. Method, per-vendor rates and the raw counts.`

  return `${HEAD(title, desc, '/coverage.html')}
${TOPBAR('coverage')}
<main>
<section class="hero hero-narrow">
  <p class="eyebrow">Measurement <span class="sep">·</span> ${num(all.cand)} tokens probed <span class="sep">·</span> ${asOf}</p>
  <h1>Nearly half of the ATS board links on the public web are&nbsp;dead&nbsp;ends.</h1>
  <p class="lede serif">We harvested every Greenhouse, Ashby and Lever board link in ${CRAWLS_SWEPT} Common
  Crawl indexes &mdash; ${num(all.cand)} distinct company tokens &mdash; then called every one of them against
  the vendor's own public API. ${num(all.live)} answered with at least one posting open.
  <strong>${num(notLive)} did not &mdash; ${pct(notLive, all.cand)}% of the list</strong>: ${num(all.dead)} are gone
  outright, and ${num(all.empty)} still answer with nothing open. Everyone building a job feed harvests these
  tokens. This is what nobody publishes about them.</p>
</section>

<section class="finding" id="attrition">
  <h2>What survived, by vendor</h2>
  <p class="serif">Solid is what answered with an open board. Hatched is what did not &mdash; a token that
  was linked somewhere on the public web, and today has no open role behind it.</p>
  <ul class="attrition">
${per.map((p) => `    <li class="att att-${p.k}">
      <div class="att-head">
        <span class="att-name"><span class="tick tick-${p.k}"></span>${p.label}</span>
        <span class="att-rate"><b>${pct(p.live, p.cand)}%</b> of ${num(p.cand)} tokens still live</span>
      </div>
      <div class="att-track" role="img" aria-label="${p.label}: ${num(p.live)} of ${num(p.cand)} tokens live, ${pct(p.live, p.cand)} percent">
        <div class="att-live" style="--w:${pct(p.live, p.cand)}%"></div>
      </div>
      <p class="att-legend"><span>${num(p.live)} live</span><span>${num(p.empty)} answered, nothing open</span><span>${num(p.dead)} gone</span></p>
    </li>`).join('\n')}
  </ul>

  <div class="ledger-wrap">
  <table class="ledger">
    <thead>
      <tr><th>Vendor</th><th>Candidates</th><th>Live</th><th>Empty</th><th>Gone</th><th>Live rate</th><th>Postings</th></tr>
    </thead>
    <tbody>
${per.map((p) => `      <tr>
        <td><span class="name"><span class="tick tick-${p.k}"></span>${p.label}</span></td>
        <td>${num(p.cand)}</td><td>${num(p.live)}</td><td class="dim">${num(p.empty)}</td><td class="dim">${num(p.dead)}</td>
        <td>${pct(p.live, p.cand)}%</td><td>${num(totals.perProvider[p.k].postings)}</td>
      </tr>`).join('\n')}
    </tbody>
    <tfoot>
      <tr><td>All three</td><td>${num(all.cand)}</td><td>${num(all.live)}</td><td>${num(all.empty)}</td><td>${num(all.dead)}</td><td>${pct(all.live, all.cand)}%</td><td>${num(totals.postings)}</td></tr>
    </tfoot>
  </table>
  </div>
  <p class="caveat"><strong>Live</strong> means the token resolved and the board had at least one posting open
  at the moment of reading. <strong>Empty</strong> means it resolved with zero postings &mdash; a real company with
  nothing open &mdash; and is counted as not live, which is the conservative choice. <strong>Gone</strong> is a 404,
  a 410, or a response that was not a job board at all.</p>
</section>

<section class="finding" id="erratum">
  <h2>A correction to our own number</h2>
  <div class="erratum">
    <p class="erratum-tag">Erratum &mdash; Lever, ${asOf}</p>
    <dl class="erratum-figs">
      <div><dt>We projected</dt><dd class="struck">${num(LEVER_PROJECTION.live)}</dd></div>
      <div><dt>We measured</dt><dd class="stands">${num(per.find((p) => p.k === 'lever').live)}</dd></div>
      <div><dt>Our stated 95% interval</dt><dd class="struck">${num(LEVER_PROJECTION.ci[0])}&ndash;${num(LEVER_PROJECTION.ci[1])}</dd></div>
    </dl>
    <p>Lever's API asks for one request per second, so a full pass takes about eighty minutes. Rather than
    wait, we probed a seeded random sample of ${num(LEVER_PROJECTION.sample)} of the ${num(per.find((p) => p.k === 'lever').cand)} tokens,
    got a ${(LEVER_PROJECTION.hitRate * 100).toFixed(1)}% hit rate, scaled it, and published ${num(LEVER_PROJECTION.live)} live boards
    with a 95% confidence interval of ${num(LEVER_PROJECTION.ci[0])}&ndash;${num(LEVER_PROJECTION.ci[1])}.</p>
    <p>The pass has since finished. The measured answer is <strong>${num(per.find((p) => p.k === 'lever').live)}</strong> &mdash;
    ${pct(LEVER_PROJECTION.live - per.find((p) => p.k === 'lever').live, per.find((p) => p.k === 'lever').live)}% above the truth, and
    <strong>below the bottom of the interval we published with it</strong>. A 95% interval is allowed to miss one time in
    twenty; the honest reading is that our sample was not the uniform draw we treated it as, because liveness is not
    independent of where a token sits in the harvest.</p>
    <p>We are leaving this here rather than quietly swapping the number, because a coverage figure you cannot audit is
    worth nothing, and the only way to show ours is auditable is to show it being corrected.</p>
  </div>
</section>

<section class="finding" id="throttling">
  <h2>A 403 is a fact about your client, not a verdict about the company</h2>
  <p class="serif">Greenhouse starts returning <code>403</code> once a client has asked too often. Our verifier
  originally filed any non-<code>429</code>, non-<code>5xx</code> failure as dead &mdash; so throttling was being
  recorded as "this company has no board."</p>
  <p class="serif">The tell was arithmetic, not a stack trace. A run over ${num(CANDIDATES.greenhouse)} Greenhouse tokens
  reported 4,391 live boards. An earlier run over 7,692 tokens &mdash; a strict <em>subset</em> of the same list &mdash; had
  reported 4,932. Adding tokens cannot remove companies, so one of the two runs was not measuring what it claimed.
  Splitting by status code found 2,107 <code>403</code>s in the new run against zero in the old, and 1,008 of those were
  boards the earlier run had confirmed live hours before.</p>
  <p class="serif">A refused request is now retried, and one still refused after its retries is recorded as
  <code>blocked</code> &mdash; excluded from the denominator rather than counted as a miss. The general form of the
  mistake: when a service rate-limits you, the failure describes your client, and folding it into a verdict about the
  world biases the result downward while leaving it entirely believable.</p>
</section>

<section class="finding" id="cross-probe">
  <h2>Guessing a company's token across vendors does not work</h2>
  <p class="serif">A company's board token is often the same slug whichever ATS it runs &mdash; <code>stripe</code>,
  <code>figma</code>, <code>ramp</code> &mdash; so tokens harvested from one vendor look like free candidates for the
  others. Tested on seeded random samples of up to 400 tokens per direction, it is worth 2&ndash;3% marginal coverage,
  and 0.3&ndash;0.5% into Lever. <strong>Hypothesis rejected.</strong> Published so nobody has to rediscover it.</p>
</section>

<section class="finding" id="limits">
  <h2>What this measurement does not tell you</h2>
  <p class="serif">A board is findable here only if something on the public web linked to it while Common Crawl was
  looking. Companies that never linked their board anywhere crawlable are missing, and there is no way to count what
  you cannot see. <strong>This is a floor, not a census.</strong></p>
  <p class="serif">It also says nothing about freshness. The dead tokens measure the decay rate of an archive-aged
  list; they do not say how fast <em>new</em> companies appear, which is the number a re-sweep cadence should be tuned
  to. And the ${num(all.empty)} boards that answered with nothing open are not classified &mdash; seasonally quiet and
  permanently dormant look identical from outside.</p>
  <p class="serif">There is no Workday here, and no Taleo. Both are large, and both need a different method than a
  public unauthenticated board API.</p>
</section>

<section class="downloads">
  <h2>Check it yourself</h2>
  <p class="serif">The ${num(all.live)} boards that answered are published in full, with the exact API URL that
  produced each row. Call any of them and you should get a similar count, drifting as they hire.</p>
  <ul class="dl">
    <li><a href="./data/all.csv" download><span class="dl-name">all.csv</span><span class="dl-meta">${num(all.live)} rows &mdash; token, open postings, board URL, API URL</span></a></li>
    <li><a href="${REPO_URL}/blob/main/docs/RESULTS.md"><span class="dl-name">RESULTS.md</span><span class="dl-meta">the long form &mdash; per-index yield, robots.txt handling, every superseded run</span></a></li>
  </ul>
  <p class="serif">Public domain, no attribution required, no signup. <a href="./">The directory is here</a>.</p>
</section>
</main>
${FOOTER}`
}

// ── ramp.html ────────────────────────────────────────────────────────────────
// Built from data/market-scan.json, which is produced by scripts/market-scan.mjs.
// Absent scan, no page: this is the one page on the site whose numbers expire, and
// a stale ramp is worse than no ramp because the reader cannot tell.

const RAMP_ROWS = 40
const TECH_ROWS = 36

// Internal site and cost codes, which several large boards use where a department
// name belongs. Measured on today's scan: BAYADA files roles under "Acacia
// Division (ACD) - 1047" and Bozzuto under "511 - Maintenance". Those are true
// values from the vendor's own API and they are still noise to a reader, so they
// are dropped from the prose rather than reported as functions. They stay in the
// downloadable data, where the reader has asked for everything.
const CODE_LIKE = /\s-\s*\d+\s*$|^\s*\d{2,}\s*-\s/

function paceRow(s, { tick = true } = {}) {
  // Per-company track: full width is this company's last 30 days, so the tick sits
  // at the share of that month the old pace would already have accounted for.
  const was = tick && s.opened_30d > 0 ? Math.max(0, Math.min(96, (s.baseline_30d / s.opened_30d) * 100)) : 0
  const detail = []
  const depts = s.top_departments.filter((d) => !CODE_LIKE.test(d.name))
  if (s.new_functions.length) {
    detail.push(`just opened <b>${s.new_functions.map((f) => esc(f.name)).join('</b>, <b>')}</b>`)
  } else if (depts.length) {
    detail.push(`hiring into ${depts.map((d) => esc(d.name)).join(', ')}`)
  }
  if (s.tech_signals.length) detail.push(`building with ${s.tech_signals.slice(0, 5).map((t) => esc(t.name)).join(', ')}`)
  return `  <li class="ramp-row v-${s.source}">
    <a class="ramp-name" href="${esc(s.company_url)}" rel="nofollow noopener"><span class="tick tick-${s.source}"></span>${esc(s.company)}</a>
    <div class="pace" style="--was:${was.toFixed(2)}%" role="img" aria-label="${s.opened_30d} roles opened in the last 30 days against a prior rate of ${tick ? s.baseline_30d : 'nothing — the board is new'}">
      <span class="pace-bar"></span>${tick ? '<span class="pace-tick"></span>' : ''}
    </div>
    <p class="ramp-num"><b>${num(s.opened_30d)}</b> new <span class="sep">·</span> ${tick ? `was ${s.baseline_30d}` : 'no history'}</p>
${detail.length ? `    <p class="ramp-detail">${detail.join(' <span class="sep">·</span> ')}</p>\n` : ''}  </li>`
}

function rampPage(scan) {
  const ramping = scan.ramping.slice(0, RAMP_ROWS)
  const newBoards = scan.new_boards.slice(0, 20)
  const day = scan.fetched_at.slice(0, 10)
  const rampPct = pct(scan.breakdown.ramping, scan.boards_with_postings)
  const complete = Object.entries(scan.per_provider).filter(([, p]) => p.complete).map(([k]) => PROVIDERS[k].label)
  const partial = Object.entries(scan.per_provider).filter(([, p]) => !p.complete)

  return `${HEAD(
    'Who started hiring — ramp signals across 10,197 company job boards',
    `${num(scan.breakdown.ramping)} companies opened more roles in the last 30 days than in the 60 before it, measured on ${day} across ${num(scan.scanned)} job boards read from the vendors' own public APIs.`,
    '/ramp.html',
  )}
${TOPBAR('ramp')}
<main>
<section class="hero">
  <p class="eyebrow">Ramp register <span class="sep">·</span> read ${day}</p>
  <h1><em class="v-greenhouse">${num(scan.breakdown.ramping)}</em> companies<br>just changed pace.</h1>
  <p class="lede serif">Of the ${num(scan.boards_with_postings)} boards read today, these opened more roles in
  the last 30 days than in the 60 days before them. Nothing here is accumulated: every vendor stamps each
  posting with the date it went up, so a single pass over a board is enough to see whether hiring is
  accelerating — and whether a department exists this month that did not exist last month.</p>
  <p class="more"><a href="./data/ramp.csv" download>Take all ${num(scan.boards_with_postings)} companies as CSV &rarr;</a></p>
</section>

<ol class="registers">
<li class="reg">
  <h2>Accelerating</h2>
  <p class="reg-note">Ranked by roles opened in the last 30 days, not by ratio — a company going from one
  posting to three has tripled and told you nothing.</p>
  <div class="pace-key">
    <span class="pace" style="--was:34%"><span class="pace-bar"></span><span class="pace-tick"></span></span>
    <span>track = this company's last 30 days</span>
    <span>tick = where its prior rate reached</span>
    <span>the ink is the hiring above it</span>
  </div>
  <ul class="ramp-rows">
${ramping.map((s) => paceRow(s)).join('\n')}
  </ul>
</li>

<li class="reg">
  <h2>Boards that did not exist 60 days ago</h2>
  <p class="reg-note">Every posting on these boards is recent, so there is no prior rate to compare against
  and no tick to draw. The track is inked end to end because all of it is new.</p>
  <ul class="ramp-rows">
${newBoards.map((s) => paceRow(s, { tick: false })).join('\n')}
  </ul>
</li>

<li class="reg">
  <h2>What they are staffing for</h2>
  <p class="reg-note">Every technology named in a posting opened in the last 90 days, counted across all
  ${num(scan.boards_with_postings)} boards. Matched on the title, team and department, and on the body only
  once the posting already reads as a technical one — otherwise a home-care agency comes back holding a
  data stack, which is exactly what happened the first time.</p>
  <ol class="rows rows-full">
${scan.market_tech
  .slice(0, TECH_ROWS)
  .map(
    (t) =>
      `    <li class="row"><span class="slug">${esc(t.name)}</span><span class="leader" aria-hidden="true"></span><span class="count">${num(t.postings)}</span></li>`,
  )
  .join('\n')}
  </ol>
</li>
</ol>

<section class="method">
  <h2>How this was read</h2>
  <div class="cols serif">
    <p>One pass over the roster on ${day}: each company's board called once, at its own vendor's public
    API, unauthenticated. The postings come back carrying the date each one was published, and that date
    is the whole method — the last 30 days against the 60 before it, normalised to the same length.</p>
    <p>A company is called accelerating when it opened at least ${'3'} roles in the last 30 days
    <em>and</em> did so at twice its prior rate or better. Both conditions matter: the first throws out
    the noise of very small boards, the second is what separates a ramp from a company that is simply
    large.</p>
    <p>What this cannot see is a posting that was taken down, or a board that went dark — posting dates
    only record arrivals. That is the one thing here that does need accumulated history, and the daily
    snapshot series is what collects it.</p>
  </div>
  <p class="edges">Scan edges, stated because they are real.<br>
  Read in <b>${scan.elapsed_s}s</b> against a <b>${scan.deadline_s}s</b> wall clock.
  ${complete.length ? `<b>${complete.join('</b> and <b>')}</b> swept complete.` : ''}
  ${partial
    .map(
      ([k, p]) =>
        `<b>${PROVIDERS[k].label}</b> reached ${num(p.scanned)} of ${num(p.candidates)} boards — it publishes <code>Crawl-delay: 1</code> and we honour it, which is one request per second and 26 minutes for the full list.`,
    )
    .join(' ')}<br>
  So the counts on this page are a floor, not a total. ${num(scan.postings_seen)} postings were read to produce them.</p>
</section>

<section class="downloads">
  <h2>Take the data</h2>
  <ul class="dl">
    <li><a href="./data/ramp.csv" download><span class="dl-name">ramp.csv</span><span class="dl-meta">${num(scan.boards_with_postings)} rows &mdash; company, verdict, roles opened at 7 / 30 / 90 days, prior rate, ratio</span></a></li>
    <li><a href="./data/ramp.json" download><span class="dl-name">ramp.json</span><span class="dl-meta">the same, plus newly opened departments and the technologies named in each company's recent postings</span></a></li>
    <li><a href="./data/all.csv" download><span class="dl-name">all.csv</span><span class="dl-meta">${num(totals.live)} rows &mdash; the full board roster behind it</span></a></li>
  </ul>
  <p class="serif">Public domain, no attribution required, no signup. The same scan runs on demand,
  filtered to the companies and titles you care about, as <a href="${ACTOR_URL}">an Apify Actor</a>
  &mdash; set <code>outputMode: "signals"</code> and it returns these rows for your own slice of the market.</p>
</section>
</main>
${FOOTER}`
}

// ── CSV ──────────────────────────────────────────────────────────────────────
const csvFor = (keys) => {
  const head = 'provider,token,open_postings,board_url,api_url\n'
  const body = keys.flatMap((k) =>
    rows[k].map(([token, n]) => `${k},${token},${n},${PROVIDERS[k].board(token)},"${PROVIDERS[k].api(token)}"`),
  )
  return head + body.join('\n') + '\n'
}

// ── write ────────────────────────────────────────────────────────────────────
for (const f of ['index.html', 'coverage.html', 'ramp.html', 'style.css', 'robots.txt', 'sitemap.xml', '.nojekyll']) {
  rmSync(join(OUT, f), { force: true })
}
for (const key of Object.keys(PROVIDERS)) rmSync(join(OUT, `${key}.html`), { force: true })
// Only the files this script owns. It used to wipe `data/` wholesale, which silently deleted
// every CSV built by another script — `engineering.csv` (scripts/role-census.mjs) and
// `data-quality.csv` (scripts/build-data-quality.mjs) are both published and linked from the
// index, and one site rebuild would have removed the files and left the links dangling. Nothing
// had rebuilt the site since they landed, so the breakage had not surfaced yet.
mkdirSync(join(OUT, 'data'), { recursive: true })
for (const f of [...Object.keys(PROVIDERS).map((k) => `${k}.csv`), 'all.csv', 'ramp.csv', 'ramp.json']) {
  rmSync(join(OUT, 'data', f), { force: true })
}

writeFileSync(join(OUT, 'index.html'), indexHtml)
writeFileSync(join(OUT, 'coverage.html'), coveragePage())
for (const key of Object.keys(PROVIDERS)) {
  writeFileSync(join(OUT, `${key}.html`), providerPage(key))
  writeFileSync(join(OUT, 'data', `${key}.csv`), csvFor([key]))
}
writeFileSync(join(OUT, 'data', 'all.csv'), csvFor(Object.keys(PROVIDERS)))
if (scan) {
  writeFileSync(join(OUT, 'ramp.html'), rampPage(scan))
  // Both forms ship, and this is the published copy — data/market-scan.* stays out
  // of the repo so the same bytes are not committed twice. The CSV is every company
  // flat; the JSON additionally carries the newly-opened functions and the
  // per-company technology counts, which do not fit a flat row.
  writeFileSync(join(OUT, 'data', 'ramp.csv'), readFileSync(join(ROOT, 'data/market-scan.csv'), 'utf8'))
  writeFileSync(join(OUT, 'data', 'ramp.json'), JSON.stringify(scan))
}
writeFileSync(join(OUT, 'style.css'), readFileSync(join(ROOT, 'scripts/lib/site.css'), 'utf8'))
writeFileSync(join(OUT, '.nojekyll'), '')
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`)
writeFileSync(
  join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    ['/', '/coverage.html', ...(scan ? ['/ramp.html'] : []), ...Object.keys(PROVIDERS).map((k) => `/${k}.html`)]
      .map((u) => `  <url><loc>${SITE_URL}${u}</loc><lastmod>${asOf}</lastmod></url>`)
      .join('\n') +
    `\n</urlset>\n`,
)

console.log(`docs/ written — ${num(totals.live)} boards, ${num(totals.postings)} postings, as_of ${asOf}`)
for (const key of Object.keys(PROVIDERS)) {
  console.log(`  ${key.padEnd(11)} ${num(totals.perProvider[key].live).padStart(6)} boards`)
}
