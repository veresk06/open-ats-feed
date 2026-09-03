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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n) => n.toLocaleString('en-US')

const index = JSON.parse(readFileSync(join(ROOT, 'actor/data/companies.json'), 'utf8'))
const asOf = index.as_of
const totals = index.totals

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

// ── CSV ──────────────────────────────────────────────────────────────────────
const csvFor = (keys) => {
  const head = 'provider,token,open_postings,board_url,api_url\n'
  const body = keys.flatMap((k) =>
    rows[k].map(([token, n]) => `${k},${token},${n},${PROVIDERS[k].board(token)},"${PROVIDERS[k].api(token)}"`),
  )
  return head + body.join('\n') + '\n'
}

// ── write ────────────────────────────────────────────────────────────────────
for (const f of ['index.html', 'style.css', 'robots.txt', 'sitemap.xml', '.nojekyll']) {
  rmSync(join(OUT, f), { force: true })
}
for (const key of Object.keys(PROVIDERS)) rmSync(join(OUT, `${key}.html`), { force: true })
rmSync(join(OUT, 'data'), { recursive: true, force: true })
mkdirSync(join(OUT, 'data'), { recursive: true })

writeFileSync(join(OUT, 'index.html'), indexHtml)
for (const key of Object.keys(PROVIDERS)) {
  writeFileSync(join(OUT, `${key}.html`), providerPage(key))
  writeFileSync(join(OUT, 'data', `${key}.csv`), csvFor([key]))
}
writeFileSync(join(OUT, 'data', 'all.csv'), csvFor(Object.keys(PROVIDERS)))
writeFileSync(join(OUT, 'style.css'), readFileSync(join(ROOT, 'scripts/lib/site.css'), 'utf8'))
writeFileSync(join(OUT, '.nojekyll'), '')
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`)
writeFileSync(
  join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    ['/', ...Object.keys(PROVIDERS).map((k) => `/${k}.html`)]
      .map((u) => `  <url><loc>${SITE_URL}${u}</loc><lastmod>${asOf}</lastmod></url>`)
      .join('\n') +
    `\n</urlset>\n`,
)

console.log(`docs/ written — ${num(totals.live)} boards, ${num(totals.postings)} postings, as_of ${asOf}`)
for (const key of Object.keys(PROVIDERS)) {
  console.log(`  ${key.padEnd(11)} ${num(totals.perProvider[key].live).padStart(6)} boards`)
}
