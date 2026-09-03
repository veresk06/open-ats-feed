# Results

All numbers below are measured, not estimated, unless a row says otherwise. Every candidate
token was probed against the vendor's live public API and counted only if it returned at least
one open posting.

Run 1 is kept below for comparison, but **its Greenhouse and Lever numbers are superseded** —
Run 1 swept only three indices, and its Lever row reflects the mistaken conclusion corrected
further down. Read Run 2 first.

## Run 2 — 17 Common Crawl indices, every token probed (current)

Swept via `harvest-s3.mjs` (see method note below). Candidate tokens: **19,438**.

| Provider | Candidates | Live | Empty | Dead | Hit rate | Median jobs/co. | Live postings |
|---|---:|---:|---:|---:|---:|---:|---:|
| Greenhouse | 10,091 | 5,506 | 880 | 3,705 | **54.6%** | 9 | 189,336 |
| Ashby | 4,386 | 3,153 | 299 | 934 | **71.9%** | 8 | 56,721 |
| Lever *(projected)* | 4,961 | 1,721 | — | — | **34.7%** | 8 | 51,009 |
| **Total** | **19,438** | **10,380** | | | | | **297,066** |

**Read the Lever row carefully — it is the one number here that is not measured in full.** Lever
is rate-limited to one request per second by its own robots.txt, so a full pass takes ~80
minutes. We probed a **seeded random sample of 1,000 of the 4,961 tokens** (`SEED=7`,
reproducible) and got a 34.7% hit rate, then scaled. The 95% confidence interval on that
projection puts the company total at **[10,250, 10,511]**.

**If you distrust the projection entirely, the floor is 9,006 companies** — Greenhouse and Ashby
measured in full, plus only the 347 Lever companies actually probed. Everything above 9,006 rests
on the sample.

The Greenhouse row is 4,391 live from the main pass plus 1,115 recovered by re-probing 2,107
throttled tokens at low concurrency; that re-probe returned **zero** blocked requests, so this is
a clean measurement rather than a patched one. See the 403 finding below for why the first pass
undercounted.

**Hit rates fell relative to Run 1 (71% → 55% Greenhouse, 80% → 72% Ashby), and that is expected
rather than alarming.** Run 1 swept only recent indices. Run 2 reaches back through 2025, and an
older index contains more companies that have since closed their board. The older tokens buy
coverage at a lower yield — which is the real shape of the trade-off, and Run 1's hit rate was
flattering because of its recency bias.

## Run 1 — 3 Common Crawl indices, every token probed (superseded)

Swept `CC-MAIN-2026-34`, `CC-MAIN-2026-30`, `CC-MAIN-2026-25`. Candidate tokens: **9,681**.

| Provider | Candidates | Live | Empty | Dead | Hit rate | Median jobs/co. | Live postings |
|---|---:|---:|---:|---:|---:|---:|---:|
| Greenhouse | 5,932 | 4,188 | 400 | 1,344 | **70.6%** | 12 | 161,292 |
| Ashby | 3,654 | 2,919 | 231 | 504 | **79.9%** | 8 | 54,945 |
| Lever | 95 | 1 | 0 | 66 | 1.1% | 2 | 2 |
| **Total** | **9,681** | **7,108** | 631 | 1,914 | | | **216,239** |

- **Live** = token resolves and the board has ≥1 open posting.
- **Empty** = token resolves, board has zero postings. Counted as *not* live, which is the
  conservative choice — 631 companies are excluded that a looser definition would count.
- **Dead** = 404/410 or an unexpected response shape.

The headline is the hit rate. **~71% of Greenhouse and ~80% of Ashby candidates are live company
boards.** The Common Crawl URL index is a high-quality company list for these two vendors, not
a noisy one.

### Marginal yield per additional crawl index

| Index swept | New tokens | Running total |
|---|---:|---:|
| CC-MAIN-2026-34 | 6,552 | 6,552 |
| CC-MAIN-2026-30 | +2,133 | 8,685 |
| CC-MAIN-2026-25 | +996 | 9,681 |
| CC-MAIN-2026-21 | +800 | 10,481 |

Yield decays but does not stop. Sweeping more indices is the direct lever on company count.

### Marginal yield across the full 17-index sweep

New candidate tokens contributed by each index, in sweep order (newest to oldest):

| Index | New tokens | | Index | New tokens |
|---|---:|---|---|---:|
| CC-MAIN-2026-04 | 408 | | CC-MAIN-2025-26 | 371 |
| CC-MAIN-2025-51 | 280 | | CC-MAIN-2025-21 | 413 |
| CC-MAIN-2025-47 | 315 | | CC-MAIN-2025-18 | 387 |
| CC-MAIN-2025-43 | **2,635** | | CC-MAIN-2025-13 | 313 |
| CC-MAIN-2025-38 | 821 | | CC-MAIN-2025-08 | 302 |
| CC-MAIN-2025-33 | 565 | | CC-MAIN-2025-05 | 240 |
| CC-MAIN-2025-30 | 493 | | | |

Two things worth reading off this, because the naive reading is wrong:

1. **The tail is flat, not converging.** After the first few indices the yield settles around
   240–490 per index and stays there. It is diminishing returns, not saturation. Common Crawl
   publishes indices going back years, so **the company count is a function of how far back you
   sweep**, at roughly +300 tokens ≈ +165 live companies per additional index. Any coverage
   number from this method should be quoted with the number of indices swept, or it is not a
   reproducible claim.
2. **CC-MAIN-2025-43's 2,635 is not noise.** That is where Lever's pre-ban board URLs first
   appear in volume. A single index dominating the yield is a signal that something structural
   changed at that point in time, and it is worth chasing rather than averaging away.

## Correction: "Lever is structurally unreachable" was wrong

This section previously concluded that Lever could not be reached by this method and that
**"no amount of sweeping will fix it."** That was wrong. The finding is left here, corrected in
place, because the way it was wrong is more useful than the conclusion was.

What is still true: `jobs.lever.co/robots.txt` contains

```
User-agent: CCBot
Disallow: /
```

Common Crawl obeys it, so **recent** indices hold 62 records for `jobs.lever.co`, every one of
them `robots.txt` itself. Lever additionally names GPTBot, ClaudeBot, Google-Extended, Amazonbot,
Bytespider, meta-externalagent and CloudflareBrowserRenderingCrawler, and sets
`Content-Signal: search=yes, ai-train=no, use=reference`.

**What was wrong: the conclusion was drawn from recent crawls only.** A robots.txt exclusion
governs future crawling; it does not retroactively empty an archive already collected. Common
Crawl's 2025 indices predate Lever's ban and contain ordinary `jobs.lever.co` board URLs.
Sweeping back through them took Lever from **112 candidate tokens to 4,961**.

The generalizable lesson, which is the part worth keeping: *an empty result in a recent index is
not evidence of an empty archive.* Check whether a host was always absent before concluding the
method fails on it. We spent a cycle designing around a provider we had not actually lost, and
the product scope decision that followed from it ("ship without Lever") was made on a false
premise.

### On whether using pre-ban archived data is legitimate

Stating this plainly rather than leaving it implicit:

- We do **not** crawl `jobs.lever.co`. We read Common Crawl's published archive of pages it was
  permitted to fetch at the time it fetched them.
- The liveness probe goes to `api.lever.co` — a different host, public and unauthenticated —
  whose own robots.txt says `Allow: /` with `Crawl-delay: 1`.
- We honour that crawl delay: the Lever pass runs single-connection at one request per second
  and takes about 80 minutes. This is enforced in `scripts/verify-coverage.mjs`
  (`concurrency: 1, delayMs: 1000`), not merely documented.

Greenhouse and Ashby impose no relevant restriction on the board hosts — `Disallow: /embed/` and
`/meeting/, /b/, /api/` respectively, none of which this project touches.

## Finding: cross-provider token guessing does not work

Worth testing, because it would have been the only available token source for Lever: a
company's board token is often the same slug whichever ATS it runs on (`stripe`, `figma`,
`ramp`), so tokens harvested from one vendor are free candidates for the others.

Measured with `scripts/cross-probe.mjs`, seeded random samples of up to 400 tokens:

| Direction | Live | Hit rate |
|---|---:|---:|
| greenhouse → ashby | 13/400 | 3.3% |
| ashby → greenhouse | 10/400 | 2.5% |
| lever → ashby | 7/88 | 8.0% |
| lever → greenhouse | 2/88 | 2.3% |
| ashby → lever | 2/400 | 0.5% |
| greenhouse → lever | 1/400 | 0.3% |

**Hypothesis rejected.** Worth ~2–3% marginal coverage, and essentially nothing for Lever
(0.3–0.5%). Published so nobody has to rediscover it.

## The method generalizes to other ATS vendors

Greenhouse and Ashby are not special. Spot-checked, and these also answer public,
unauthenticated requests:

| Vendor | Endpoint | Result |
|---|---|---|
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{token}/postings` | Responds — `Sodexo` → 139 postings — but **REFUSED, and we do not ship it.** `api.smartrecruiters.com/robots.txt` serves `Disallow: /` to `*`, with one `Allow: /v1/companies/` scoped to `LinkedInBot`. We are not LinkedInBot. |
| Personio | `{token}.jobs.personio.de/xml` | Responds (XML), but **REFUSED, and we do not ship it.** Tenant `robots.txt` disallows `/xml` — the exact path. The live file 404s today after a site migration; the archived rule is byte-identical across tenants on both TLDs. See `data/personio-gate.json`. |
| Lever | `api.lever.co/v0/postings/{token}?mode=json` | Works, but see the robots.txt problem above — we cannot enumerate tokens. |

SmartRecruiters board hosts (`careers.smartrecruiters.com`, `jobs.smartrecruiters.com`) are
present in the Common Crawl index, so the same harvest would apply unchanged — which is exactly
why the refusal above is a decision rather than a limitation. Answering a request is not the
same as permitting one.

This matters for anyone reading the company count as a ceiling. It is not one. **Company
coverage scales by adding vendors, not by sweeping more crawl indices** — marginal yield per
additional index decays fast (2,133 → 996 → 800 → ~230 new tokens), while each new vendor opens
a fresh population.

## Method: reading the Common Crawl index without the CDX API

The first version of this measurement queried the CDX API at `index.commoncrawl.org`. Partway
through a 17-index sweep that host degraded to 504s and then refused TLS handshakes entirely.
**13 of 17 planned indices were never fetched, and the run exited cleanly with a
plausible-looking token count** — the failure mode was a quiet undercount, not a crash. A gate
decision was nearly taken on that number.

`data.commoncrawl.org` — the S3 bucket behind a CDN — stayed up throughout. It has no query
interface, but it does not need one:

- Each crawl publishes `cluster.idx`, ~110 MB of plain text, one line per compressed cdx block,
  **sorted by SURT** (`boards.greenhouse.io` → `io,greenhouse,boards)/`).
- Sorted data plus HTTP range requests is a binary-searchable index. About 12 range reads of
  64 KB locate the block range for a host prefix, so searching a 110 MB file costs ~700 KB.
- Each line gives `(cdx file, offset, length)`. Range-fetch those blocks, gunzip, and parse.
  Only the blocks that can contain the prefix are ever transferred.

One boundary detail that matters: cluster.idx keys are block *start* keys, so the block holding
the first matching record usually begins just *before* the prefix. The search deliberately keeps
the last line below the prefix, or the first few thousand records of a host go missing.

`scripts/harvest-s3.mjs` implements this; `scripts/harvest-tokens.mjs` retains the CDX-API path.
Completing the sweep this way took the harvest from 11,895 to **19,438 candidate tokens**.

The operational lesson is not about Common Crawl specifically: *an unattended sweep whose only
index path is a single application server will eventually report a confident undercount.* The
bucket and the API fail independently, and only one of them is on the critical path now.

## Finding: HTTP 403 is a fact about the client, not a verdict about the company

Worth writing down because it produced a *plausible* wrong answer rather than an error, and
because anyone reproducing this at scale will hit it.

Greenhouse begins returning `403` once a client has asked too often. The verifier originally
classified any non-`429`, non-`5xx` failure as `dead` — "this company has no board" — so
throttling was silently recorded as absence.

**The tell was arithmetic, not a stack trace.** A run over 10,091 Greenhouse tokens reported
4,391 live boards. An earlier run over 7,692 tokens — a strict *subset* of the same tokens —
had reported 4,932. Adding tokens cannot remove companies, so at least one of the two runs was
not measuring what it claimed. Breaking the results down by status code showed 2,107 `403`s in
the new run against zero in the old one, and 1,008 of those 403s were boards the earlier run had
confirmed live hours before.

Two changes followed:

1. `403` now backs off and retries alongside `429` and `5xx`.
2. A request still refused after its retries is recorded as **`blocked`**, a distinct status
   that is excluded from the hit-rate denominator rather than counted as a miss. A run with a
   non-trivial `blocked` count is not a measurement, and the code says so in its output.

The general form of the mistake: *when a remote service rate-limits you, the failure describes
your client, and folding it into a domain verdict silently biases the result downward.* The
number stayed believable the whole time, which is exactly why the arithmetic cross-check
mattered more than the error handling did.

## Known limits of this measurement

- **Freshness is not measured.** 1,344 dead Greenhouse tokens (23%) tell you the decay rate of a
  Common-Crawl-aged index. They do not tell you how fast *new* companies appear, which is the
  thing a re-sweep cadence should be tuned to.
- **`empty` boards are not classified.** 631 tokens resolve with zero postings. Whether they are
  seasonally quiet or permanently dormant is unknown; they are excluded from the live count
  either way.
- **Coverage is of companies *reachable via Common Crawl*,** which is a subset of companies with
  ATS boards — specifically, those whose board pages were linked from somewhere Common Crawl
  crawled. It is a floor, not a census.
