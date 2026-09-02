# Open ATS Feed — coverage measurement

An open, reproducible measurement of how many companies you can reach through the **public,
unauthenticated job-board APIs** of the three major applicant tracking systems — Greenhouse,
Lever and Ashby — and how many live job postings that adds up to.

No scraping. No authentication. No terms-of-service gymnastics. Every number here comes from
endpoints those vendors publish for anyone to call, and every number is reproducible by running
two scripts in this repo.

## Why this exists

Most job-data products are built on scrapers pointed at LinkedIn or Indeed, which means they
are one enforcement action away from going dark. The official ATS board APIs are the opposite:
public by design, stable, and intended to be consumed. The obvious question — *is that enough
coverage to be useful?* — did not seem to have a published answer, so we measured it.

The measurement turns on one observation: **the Common Crawl URL index is already a
company→board-token index.** Every public ATS board URL carries the company's token as its
first path segment:

```
boards.greenhouse.io/{token}     jobs.lever.co/{token}     jobs.ashbyhq.com/{token}
```

So a CDX query against those host prefixes enumerates companies for free, without crawling
anything ourselves. Then each candidate token is probed against the vendor's real API to see
what is live right now.

## Results

See [`docs/RESULTS.md`](docs/RESULTS.md) for the current numbers, the per-provider hit rates,
and the full method.

Two findings are worth pulling out:

**1. Harvested tokens are overwhelmingly real.** ~71% of Greenhouse candidates and ~80% of
Ashby candidates resolve to a live board with at least one open posting. The URL index is a
high-quality company list, not noise.

**2. Lever's robots.txt exclusion has a date, and sweeping past it does fix the problem.**
`jobs.lever.co/robots.txt` contains `User-agent: CCBot / Disallow: /`, and Common Crawl obeys
it, so recent indices hold 62 records for that host — every one of them `robots.txt` itself.
Lever also names GPTBot, ClaudeBot, Google-Extended, Amazonbot, Bytespider and
meta-externalagent.

We originally concluded from this that Lever was structurally unreachable and that no amount of
sweeping would fix it. **That was wrong, and we are leaving the error in the git history rather
than quietly correcting it.** The mistake was measuring only the most recent crawls. The
exclusion is not retroactive: Common Crawl's older indices were collected before the ban and
contain ordinary `jobs.lever.co` board URLs. Sweeping back through 2025 took Lever from 112
candidate tokens to **4,961**.

The correct statement is narrower and more useful: *robots.txt governs future crawling, not the
existing archive*. If you hit an apparently empty host in a recent index, check whether it was
always empty before concluding the method fails on it.

On the ethics, since this deserves a straight answer rather than a shrug: we do not crawl
`jobs.lever.co` — we read Common Crawl's published archive of pages it was permitted to fetch
at the time. The liveness probe goes to `api.lever.co`, a different host, whose own robots.txt
says `Allow: /` with `Crawl-delay: 1`. We honour that delay (one request per second, which is
why the Lever pass takes about 80 minutes).

We also tested the obvious workaround — guessing that a company uses the same slug on every
ATS — and it does not work: 0.3–0.5% hit rate into Lever. That negative result is in the
results doc so nobody has to rediscover it.

## Reproducing it

```bash
node scripts/harvest-s3.mjs         # sweep Common Crawl -> data/tokens.json
node scripts/verify-coverage.mjs    # probe every token -> data/coverage-summary.json
```

There are two harvesters, and the difference matters if you plan to run this yourself:

- **`harvest-s3.mjs` (use this one)** reads the index files directly from
  `data.commoncrawl.org`. Each crawl ships a `cluster.idx`: ~110 MB of plain text, one line per
  compressed cdx block, **sorted by SURT**. Sorted plus HTTP range requests means it is a
  binary-searchable index over the entire crawl, so locating every block for
  `io,greenhouse,boards)/` costs about 700 KB of transfer instead of 110 MB. It then range-fetches
  only those blocks.
- **`harvest-tokens.mjs`** uses the CDX API at `index.commoncrawl.org`. It is a nicer query
  interface and we no longer depend on it: that host is a single application server, and it went
  from intermittent 504s to refusing TLS entirely partway through our sweep, taking 13 of 17
  planned indices with it. The S3 bucket stayed up throughout. If you are running an unattended
  sweep, do not put it on the critical path.

Environment variables:

| Script | Var | Meaning |
|---|---|---|
| harvest-s3 | `CRAWLS` | comma-separated crawl ids, e.g. `CC-MAIN-2025-51,CC-MAIN-2025-47` |
| harvest-tokens | `CRAWLS` | how many Common Crawl monthly indices to sweep (default 4) |
| harvest-tokens | `CRAWL_OFFSET` | skip the first N indices, so a deeper pass doesn't redo work |
| verify | `ONLY` | probe only these providers, e.g. `ONLY=lever` |
| verify | `SAMPLE` | probe a seeded random sample per provider instead of everything |
| verify | `SEED` | PRNG seed, so a sampled run is reproducible |
| verify | `CONCURRENCY` | parallel requests (default 24; per-provider limits override it) |

Both harvesters share `scripts/lib/tokens.mjs` and write the same checkpoint file, so they
resume each other. The checkpoint is written after every host, so an interrupted sweep costs one
host rather than starting over.

`scripts/cross-probe.mjs` runs the cross-provider token test described above.

## Politeness

These are public APIs and we would like them to stay that way. The scripts use a descriptive
user-agent, back off on 429 and 5xx, cap concurrency, and never touch a path disallowed by the
host's `robots.txt`. If you re-run this, please keep it that way.

`robots.txt` on each host we actually fetch, checked 2026-09-03:

| Host | Says | What we do |
|---|---|---|
| `boards-api.greenhouse.io` | `Disallow: /embed/` | we fetch `/v1/boards/` — allowed |
| `api.ashbyhq.com` | robots.txt returns HTTP 401 | nothing stated, no restriction to honour |
| `api.lever.co` | `Allow: /`, `Crawl-delay: 1` | 1 request/second, single connection |

The Lever crawl delay is enforced in code (`concurrency: 1, delayMs: 1000` in
`scripts/verify-coverage.mjs`), not just documented here.

## Licence

Code MIT. The measurements are facts and belong to nobody.
