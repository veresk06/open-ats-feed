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

**2. Lever is invisible to this method, and it is worth knowing why.**
`jobs.lever.co/robots.txt` contains `User-agent: CCBot / Disallow: /`. Common Crawl obeys it,
so the index contains 62 records for that host — every one of them `robots.txt` itself. Lever
also names GPTBot, ClaudeBot, Google-Extended, Amazonbot, Bytespider and meta-externalagent.
This is a deliberate exclusion, not low Lever adoption, and no amount of sweeping will fix it.
(It says nothing about `api.lever.co`, which is a different host and remains public — we simply
have no way to enumerate *which* tokens to ask it about.)

We also tested the obvious workaround — guessing that a company uses the same slug on every
ATS — and it does not work: 0.3–0.5% hit rate into Lever. That negative result is in the
results doc so nobody has to rediscover it.

## Reproducing it

```bash
node scripts/harvest-tokens.mjs     # sweep Common Crawl -> data/tokens.json
node scripts/verify-coverage.mjs    # probe every token -> data/coverage-summary.json
```

Environment variables:

| Script | Var | Meaning |
|---|---|---|
| harvest | `CRAWLS` | how many Common Crawl monthly indices to sweep (default 4) |
| harvest | `CRAWL_OFFSET` | skip the first N indices, so a deeper pass doesn't redo work |
| verify | `SAMPLE` | probe a seeded random sample per provider instead of everything |
| verify | `SEED` | PRNG seed, so a sampled run is reproducible |
| verify | `CONCURRENCY` | parallel requests (default 24) |

The harvester checkpoints after every host and reloads on start, so an interrupted sweep
resumes instead of starting over.

`scripts/cross-probe.mjs` runs the cross-provider token test described above.

## Politeness

These are public APIs and we would like them to stay that way. The scripts use a descriptive
user-agent, back off on 429 and 5xx, cap concurrency, and never touch a path disallowed by the
host's `robots.txt`. If you re-run this, please keep it that way.

## Licence

Code MIT. The measurements are facts and belong to nobody.
