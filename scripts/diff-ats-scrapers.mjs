#!/usr/bin/env node
// Diff our measured board roster against kalil0321/ats-scrapers' published snapshot.
//
// Their snapshot is per-ATS Parquet behind a manifest. We only care about the six
// providers we ship, and only about the board token — that is the unit our roster is
// keyed on. Token is derived from their `url` column; rows on a company's own career
// domain carry no token, so their board count here is a LOWER BOUND. That caveat is
// printed with the numbers, not buried.
//
// Reading Parquet is delegated to duckdb via `uv run --with duckdb`, which projects
// only the url column over range requests instead of pulling ~260 MB.
//
// Usage: node scripts/diff-ats-scrapers.mjs [--out data/ats-scrapers-diff.json]

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MANIFEST = 'https://storage.stapply.ai/jobhive/v1/manifest.json';

// provider -> DuckDB regexp that lifts the board token out of their url
const TOKEN_RE = {
  greenhouse: 'greenhouse\\.io/([^/?#]+)/',
  lever: 'jobs\\.lever\\.co/([^/?#]+)',
  ashby: 'jobs\\.ashbyhq\\.com/([^/?#]+)',
  recruitee: '^https?://([^./]+)\\.recruitee\\.com',
  teamtailor: '^https?://([^./]+)\\.teamtailor\\.com',
  breezy: '^https?://([^./]+)\\.breezy\\.hr',
};

const outArg = process.argv.indexOf('--out');
const outPath = outArg === -1 ? 'data/ats-scrapers-diff.json' : process.argv[outArg + 1];
const csvArg = process.argv.indexOf('--csv');
const csvPath = csvArg === -1 ? 'docs/data/net-new-vs-ats-scrapers.csv' : process.argv[csvArg + 1];

// A board whose postings all live on the company's own careers domain yields no token from
// their url, so it looks net-new when it is not. Match those by normalised company name and
// take them off our side of the ledger — the correction only ever shrinks our number.
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}

// --- our side ------------------------------------------------------------
const ours = new Map(); // provider -> Map(token -> open_postings)
for (const line of readFileSync('docs/data/all.csv', 'utf8').trim().split('\n').slice(1)) {
  const [provider, token, postings] = line.split(',');
  if (!ours.has(provider)) ours.set(provider, new Map());
  ours.get(provider).set(token.toLowerCase(), Number(postings) || 0);
}

// --- their side ----------------------------------------------------------
const manifest = JSON.parse(sh('curl', ['-sS', '--max-time', '60', MANIFEST]));

const work = Object.keys(TOKEN_RE).map((p) => ({
  provider: p,
  url: manifest.by_ats[p].parquet,
  rows: manifest.by_ats[p].rows,
  re: TOKEN_RE[p],
}));

const dir = mkdtempSync(join(tmpdir(), 'ats-diff-'));
const py = join(dir, 'extract.py');
writeFileSync(
  py,
  `import duckdb, json, sys
jobs = json.loads(sys.argv[1])
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs;")
out = {}
for j in jobs:
    q = f"""
      SELECT lower(regexp_extract(url, '{j["re"]}', 1)) AS token, count(*) AS n
      FROM '{j["url"]}'
      GROUP BY 1
    """
    rows = con.execute(q).fetchall()
    companies = con.execute(f"""
      SELECT DISTINCT company FROM '{j["url"]}'
      WHERE company IS NOT NULL AND regexp_extract(url, '{j["re"]}', 1) = ''
    """).fetchall()
    out[j["provider"]] = {
        "tokens": {t: n for t, n in rows if t},
        "untokenised": sum(n for t, n in rows if not t),
        "custom_domain_companies": [c[0] for c in companies],
    }
    print(j["provider"], "done", file=sys.stderr)
print(json.dumps(out))
`,
);

process.stderr.write(`reading ${work.length} remote parquet files...\n`);
const raw = sh('uv', ['run', '--quiet', '--with', 'duckdb', 'python3', py, JSON.stringify(work)], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const theirs = JSON.parse(raw);

// --- diff ----------------------------------------------------------------
const report = { generated_at: new Date().toISOString(), source: MANIFEST, providers: {}, totals: {} };
const t = {
  our_boards: 0, their_boards: 0, shared: 0, ours_only_raw: 0, ours_only_net: 0, theirs_only: 0,
  our_postings: 0, their_postings: 0, our_postings_on_net_new: 0,
  corrected_boards: 0, corrected_postings: 0, max_possible_correction: 0,
  their_rows: 0, their_untokenised_rows: 0,
};
const netNewRows = [];

for (const { provider, rows } of work) {
  const mine = ours.get(provider) ?? new Map();
  const yours = new Map(Object.entries(theirs[provider].tokens));
  const untok = theirs[provider].untokenised;
  const customDomain = new Set(theirs[provider].custom_domain_companies.map(norm));

  const oursOnlyRaw = [...mine.keys()].filter((k) => !yours.has(k));
  const corrected = oursOnlyRaw.filter((k) => customDomain.has(norm(k)));
  const netNew = oursOnlyRaw.filter((k) => !customDomain.has(norm(k)));
  const theirsOnly = [...yours.keys()].filter((k) => !mine.has(k));
  const shared = mine.size - oursOnlyRaw.length;

  const ourPostings = [...mine.values()].reduce((a, b) => a + b, 0);
  const netNewPostings = netNew.reduce((a, k) => a + mine.get(k), 0);
  const correctedPostings = corrected.reduce((a, k) => a + mine.get(k), 0);
  const theirPostings = [...yours.values()].reduce((a, b) => a + b, 0);

  for (const token of netNew.sort()) netNewRows.push([provider, token, mine.get(token)]);

  report.providers[provider] = {
    our_boards: mine.size,
    their_boards_tokenised: yours.size,
    shared,
    ours_only_raw: oursOnlyRaw.length,
    corrected_custom_domain: corrected.length,
    ours_only_net_new: netNew.length,
    theirs_only: theirsOnly.length,
    our_postings: ourPostings,
    our_postings_on_net_new: netNewPostings,
    their_rows_total: rows,
    their_rows_tokenised: theirPostings,
    their_rows_untokenised: untok,
    their_custom_domain_companies: customDomain.size,
    token_extraction_rate: rows ? +(theirPostings / rows).toFixed(4) : null,
  };

  t.our_boards += mine.size;
  t.their_boards += yours.size;
  t.shared += shared;
  t.ours_only_raw += oursOnlyRaw.length;
  t.ours_only_net += netNew.length;
  t.theirs_only += theirsOnly.length;
  t.our_postings += ourPostings;
  t.our_postings_on_net_new += netNewPostings;
  t.corrected_boards += corrected.length;
  t.corrected_postings += correctedPostings;
  t.max_possible_correction += customDomain.size;
  t.their_postings += theirPostings;
  t.their_rows += rows;
  t.their_untokenised_rows += untok;
}
// Worst case every custom-domain company of theirs is one of ours that name-matching missed.
t.ours_only_net_lower_bound = t.ours_only_raw - t.max_possible_correction;
report.totals = t;

writeFileSync(outPath, JSON.stringify(report, null, 2));
writeFileSync(
  csvPath,
  'provider,token,open_postings,board_url\n' +
    netNewRows
      .map(([p, tok, n]) => `${p},${tok},${n},${boardUrl(p, tok)}`)
      .join('\n') + '\n',
);

function boardUrl(provider, token) {
  switch (provider) {
    case 'greenhouse': return `https://job-boards.greenhouse.io/${token}`;
    case 'lever': return `https://jobs.lever.co/${token}`;
    case 'ashby': return `https://jobs.ashbyhq.com/${token}`;
    case 'recruitee': return `https://${token}.recruitee.com/`;
    case 'teamtailor': return `https://${token}.teamtailor.com/`;
    case 'breezy': return `https://${token}.breezy.hr/`;
    default: return '';
  }
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '—');
console.log(`\nats-scrapers diff @ ${report.generated_at}`);
console.log('provider      ours  theirs*  shared  net-new  corrected  theirs-only  tok-rate');
for (const [p, r] of Object.entries(report.providers)) {
  console.log(
    `${p.padEnd(12)} ${String(r.our_boards).padStart(5)} ${String(r.their_boards_tokenised).padStart(7)} ` +
      `${String(r.shared).padStart(7)} ${String(r.ours_only_net_new).padStart(8)} ` +
      `${String(r.corrected_custom_domain).padStart(10)} ${String(r.theirs_only).padStart(12)} ` +
      `${String((r.token_extraction_rate * 100).toFixed(1) + '%').padStart(9)}`,
  );
}
console.log(
  `${'TOTAL'.padEnd(12)} ${String(t.our_boards).padStart(5)} ${String(t.their_boards).padStart(7)} ` +
    `${String(t.shared).padStart(7)} ${String(t.ours_only_net).padStart(8)} ` +
    `${String(t.corrected_boards).padStart(10)} ${String(t.theirs_only).padStart(12)}`,
);
console.log(
  `\npostings on the six shared providers: ours ${t.our_postings} vs theirs ${t.their_rows} ` +
    `(${(t.our_postings / t.their_rows).toFixed(2)}×)`,
);
console.log(
  `net-new boards on our side: ${t.ours_only_net} of ${t.our_boards} (${pct(t.ours_only_net, t.our_boards)}), ` +
    `carrying ${t.our_postings_on_net_new} of ${t.our_postings} open postings ` +
    `(${pct(t.our_postings_on_net_new, t.our_postings)})`,
);
console.log(
  `  after removing ${t.corrected_boards} boards (${t.corrected_postings} postings) that are theirs ` +
    `under a company careers domain. Worst case all ${t.max_possible_correction} of their ` +
    `custom-domain companies are ours, giving a floor of ${t.ours_only_net_lower_bound} ` +
    `(${pct(t.ours_only_net_lower_bound, t.our_boards)}).`,
);
console.log(
  `their rows on these six: ${t.their_rows}, of which ${t.their_untokenised_rows} ` +
    `(${pct(t.their_untokenised_rows, t.their_rows)}) carry no derivable token — ` +
    `their board counts above are a LOWER BOUND.`,
);
console.log(`written: ${outPath} and ${csvPath} (${netNewRows.length} rows)`);
