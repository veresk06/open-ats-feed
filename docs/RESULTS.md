# Results

All numbers below are measured, not estimated, unless a row says otherwise. Every candidate
token was probed against the vendor's live public API and counted only if it returned at least
one open posting.

## Run 1 — 3 Common Crawl indices, every token probed

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

## Finding: Lever is structurally unreachable by this method

Not a thin token list, and not low Lever adoption. `jobs.lever.co/robots.txt` contains:

```
User-agent: CCBot
Disallow: /
```

Common Crawl obeys it. The index holds **62 records for `jobs.lever.co`, every one of them
`robots.txt` itself.** Lever additionally names GPTBot, ClaudeBot, Google-Extended, Amazonbot,
Bytespider, meta-externalagent and CloudflareBrowserRenderingCrawler, and sets
`Content-Signal: search=yes, ai-train=no, use=reference`.

This is a deliberate exclusion and no amount of sweeping will fix it. The 95 Lever tokens above
came from `jobs.eu.lever.co`, which is indexed but tiny, and 66 of them are dead.

To be precise about what this does and does not mean: it says nothing about `api.lever.co`,
which is a different host, is public and unauthenticated, and which we do call. The problem is
purely that we have no way to enumerate *which* tokens to ask it about. Greenhouse and Ashby
impose no relevant restriction — `Disallow: /embed/` and `/meeting/, /b/, /api/` respectively,
none of which this project touches.

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
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{token}/postings` | **Works.** `Sodexo` → 139 postings. Response includes `totalFound`, so board size is one request. Tokens are case-sensitive. |
| Personio | `{token}.jobs.personio.de/xml` | Responds (XML). Not yet characterized. |
| Lever | `api.lever.co/v0/postings/{token}?mode=json` | Works, but see the robots.txt problem above — we cannot enumerate tokens. |

SmartRecruiters board hosts (`careers.smartrecruiters.com`, `jobs.smartrecruiters.com`) are
present in the Common Crawl index, so the same harvest applies unchanged.

This matters for anyone reading the company count as a ceiling. It is not one. **Company
coverage scales by adding vendors, not by sweeping more crawl indices** — marginal yield per
additional index decays fast (2,133 → 996 → 800 → ~230 new tokens), while each new vendor opens
a fresh population.

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
