# Open ATS Feed — coverage measurement

An open, reproducible measurement of how many companies you can reach through the **public,
unauthenticated job-board APIs** of six applicant tracking systems — Greenhouse, Lever, Ashby,
Breezy, Recruitee and Teamtailor — and how many live job postings that adds up to.

No scraping. No authentication. No terms-of-service gymnastics. Every number here comes from
endpoints those vendors publish for anyone to call, and every number is reproducible by running
two scripts in this repo.

**Browse the result:** <https://veresk06.github.io/open-ats-feed/> — all 16,361 boards with their
open-posting counts, searchable, with CSV downloads. Free, public domain, no signup.
Built from `actor/data/companies.json` by `scripts/build-site.mjs`.

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

Breezy, Recruitee and Teamtailor are the exception that proves the shape: they give each
customer a subdomain rather than a path, so the token is `{token}.breezy.hr`,
`{token}.recruitee.com` or `{token}.teamtailor.com` instead of a first path segment. Same index,
same query, one different extraction rule.

So a CDX query against those host prefixes enumerates companies for free, without crawling
anything ourselves. Then each candidate token is probed against the vendor's real API to see
what is live right now.

## Results

**16,361 live companies and 399,398 live job postings**, across Greenhouse, Ashby, Lever,
Breezy, Recruitee and Teamtailor, from 30,729 candidate tokens harvested out of 17 Common Crawl
indices.

| Provider | Candidates | Probed | Live companies | Hit rate | Live postings |
|---|---:|---:|---:|---:|---:|
| Greenhouse | 10,091 | 10,091 | 5,506 | 54.6% | 189,336 |
| Ashby | 4,386 | 4,386 | 3,153 | 71.9% | 56,721 |
| Lever | 4,961 | 4,824 | 1,621 | 33.6% | 53,715 |
| Breezy | 4,562 | 4,562 | 1,841 | 40.4% | 35,533 |
| Recruitee | 3,554 | 3,554 | 2,247 | 63.2% | 36,588 |
| Teamtailor | 3,175 | 3,175 | 1,993 | 62.8% | 27,505 |
| **Total** | **30,729** | **30,592** | **16,361** | | **399,398** |

**Every figure above is counted. None of it is projected.**

That sentence used to have an asterisk on it. An earlier version of this table reported 10,380
companies, of which the Lever row was extrapolated from a seeded random sample of 1,000 tokens —
`api.lever.co` asks for one request per second, a full pass is ~80 minutes, and we had not run
one. We have now: Lever is probed token by token with a per-token checkpoint, 4,824 of 4,961
done. The remaining 137 are unprobed, which is not the same as dead; they ship as an opt-in list
and are counted as neither. Hit rate is computed against tokens probed, not tokens harvested, so
an unprobed token can never be silently counted as a miss.

The measured Lever hit rate (33.6%) landed within a point of what the sample projected (34.7%),
which is reassuring about the sampling but is not a reason to have kept quoting the projection.

Breezy makes the sharper version of the same point, and it is the reason posting counts are
never projected here. A 250-token sample predicted 1,770 live boards (measured: 1,841, −3.9%)
and 29,653 postings (measured: 35,533, **−16.6%**). Liveness is close to a coin flip and samples
well; postings-per-board is long-tailed — the median Breezy board has 4 open roles and the
largest has 2,760 — so a small draw misses the boards holding most of the corpus, and misses
them downward every time. A company count may be projected from a labelled sample. A posting
count is measured or it is not published.

See [`docs/RESULTS.md`](docs/RESULTS.md) for per-provider detail, the full method, and the
things this measurement does *not* establish.

Four findings are worth pulling out:

**1. Harvested tokens are largely real.** 55–72% of Greenhouse and Ashby candidates resolve to a
live board with at least one open posting. The URL index is a high-quality company list, not
noise. (Earlier, shallower runs showed 71% and 80%; sweeping further back adds companies that
have since closed their board, so coverage and hit rate trade against each other.)

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

## Hiring signals from posting dates alone

Every vendor stamps each posting with a publication date — Greenhouse `first_published`,
Ashby `publishedAt`, Lever `createdAt`, Breezy `published_date` — and on 80 live boards
carrying 61,203 open postings (measured across Greenhouse, Ashby and Lever),
**100% of them had one**. That is enough to measure how fast a company is hiring right now
against its own prior pace, without any accumulated history:

```bash
node scripts/preview-signals.mjs 25 greenhouse,ashby
```

`actor/src/signals.js` is a pure function of one board's postings and is unit-tested against
fixed dates (`node --test actor/test`). Two things it deliberately refuses to say, both found by
running it on live boards rather than fixtures:

- **Departments are not always functions.** BAYADA's board carries ~200 of them
  ("Baltimore Visits (BV) - 94"), SpaceX ~70 ("Raptor Turbomachinery"). Above 25 distinct
  departments the field is a site or sub-team code, and "a newly opened function" is suppressed
  rather than guessed at — the first draft reported 190 of them for a single home-care company.
- **Acronyms belong to industries.** On that same home-care board, `dbt` is Dialectical Behavior
  Therapy and `PHP` is a Partial Hospitalization Program, not a data stack and a web language.
  Ambiguous terms only count inside a technical posting, and the test for "is this technical"
  reads the title, team and department — not the description, which is long enough that almost
  any of them contains the word "data" somewhere.
- **Most of a job description is not the job.** BAYADA still came back holding `.NET` after the
  guard above. Every one of the four matching postings turned out to be a CDN hostname in the
  page markup — `//cdn2.hubspot.net/hubfs/…` and `//static.xx.fbcdn.net/images/emoji.php/…`, the
  latter also the source of the `PHP`. A share button, not a stack. Links, e-mail addresses and
  tags are stripped before any keyword is matched.

### The digest

`scripts/build-digest.mjs` runs that classifier over a sample of live boards and writes a dated,
committed issue to [`digests/`](./digests) — `<date>.md` to read, `<date>.json` carrying every
number in it so you can recompute rather than trust:

```bash
node scripts/build-digest.mjs --greenhouse 300 --ashby 250 --lever 100
```

Which companies are ramping against their own prior pace, which functions opened from scratch,
which technologies are being staffed, where the executive openings cluster. The sample is the
largest boards per provider — a stated bias, repeated in each issue's own *Limits* section — and
nothing is scaled up to the full index. Boards that could not be read are counted and named in the
issue rather than quietly dropped, because a refused connection is instrument state, not a company
that stopped hiring.

One thing each issue says about itself: the ramp *ratio* is an upper bound. Its baseline can only
be counted from postings still open today, and older postings have had longer to be filled, so a
flat-rate company reads as a mild ramp. Counts of roles opened are direct measurements; ratios
against a surviving baseline are not.

### Why the series matters more than any one issue

A single issue counts postings that are **open**, so it can see hiring start and is structurally
unable to see hiring stop. Two issues subtract. From the second onward, each carries a **What
changed** section computed from the two committed JSON files and from nothing else — no network
call, no trust in either document:

```bash
node scripts/diff-digests.mjs digests/<earlier>.json digests/<later>.json
```

That works because the sample is deterministic (the N largest boards per provider in committed
index order), so two dates read the same boards, and because every issue's JSON carries a
**per-board roster** — one row for each board read, not only the ones that made a published
table. Without the roster a company could leave the top-20 by being displaced rather than by
changing, and the diff would report a movement that never happened. Boards that could not be read
are listed by name too, so "we did not reach it" is never mistakable for "it went quiet".

The index at [`digests/README.md`](./digests) is regenerated from the issues themselves rather
than maintained by hand.

What posting dates *cannot* show is a role that closed or a board that went dark. That is what
`scripts/snapshot-history.mjs` and `scripts/hiring-signals.mjs` are for: a daily open-count
series per board, started 2026-09-03, which diffs into `ramp_up` / `ramp_down` / `new_board` /
`went_dark`. It costs nothing but wall clock — it runs locally against the vendor APIs, not on
any platform.

## Politeness

These are public APIs and we would like them to stay that way. The scripts use a descriptive
user-agent, back off on 429 and 5xx, cap concurrency, and never touch a path disallowed by the
host's `robots.txt`. If you re-run this, please keep it that way.

### The permission check

We evaluate `robots.txt` per [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) — group
selection by user-agent, longest-match wins, `Allow` breaks ties, wildcards and `$` — against
**the exact path the fetcher requests**, with the fetcher's real user-agent. Not the domain.
The path.

**We check two files per vendor, not one:** the live `robots.txt` *and* the archived copy from
the Common Crawl index. A live-only check is unsound, and Personio is the proof — see *Refused
vendors* below.

`scripts/robots-archive-audit.mjs` runs the whole thing and **exits non-zero if any shipped
provider refuses us**. Full output, including the Common Crawl WARC offsets so every archived
verdict can be re-fetched and checked independently, is in
[`data/robots-audit.json`](data/robots-audit.json).

Audit of 2026-09-03 — **6 of 6 clear**:

| Provider | Path we read | Live `robots.txt` | Archived | Verdict |
|---|---|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{t}/jobs` | 200, `Disallow: /embed/` | CC-MAIN-2025-33 | allowed — no rule matches |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{t}` | **401, never served** | 401 capture, no 200 ever | allowed — nothing stated |
| Lever | `api.lever.co/v0/postings/{t}` | 200, `Allow: /`, `Crawl-delay: 1` | CC-MAIN-2026-04 | allowed |
| Breezy | `{t}.breezy.hr/json` | 200, `Disallow: /css /fonts /stylesheets /javascripts` | 3 tenants, CC-MAIN-2026-04 | allowed |
| Recruitee | `{t}.recruitee.com/api/offers/` | 200, `Disallow: /v/` | 3 tenants, CC-MAIN-2026-04 | allowed |
| Teamtailor | `{t}.teamtailor.com/jobs.json` | 200, `Disallow: /app/ /messages/ …` | 3 tenants, CC-MAIN-2026-04 | allowed |

Two distinctions the audit reports separately, because conflating them is how a refusal slips
through: **`OK-NEVER-SERVED`** (crawled repeatedly, never returned a `robots.txt`) is not the
same as **`UNVERIFIED-NO-ARCHIVE`** (never crawled at all). Ashby is the first: its live host
returns 401 and the archive holds a 401 capture too, so the absence is corroborated rather than
merely unexplained.

Greenhouse is worth one note. Its archived 2025-08 file was the Rails default with every rule
commented out; it has since **gained** `Disallow: /embed/`. It got stricter while we weren't
looking, and it still does not touch `/v1/boards/`. That is the argument for re-running this
rather than deciding once.

The Lever crawl delay is enforced in code (`concurrency: 1, delayMs: 1000` in
`scripts/verify-coverage.mjs`), not just documented here.

### Refused vendors

These are reachable and we do not ship them. Each has a stated trigger that would change the
answer; none of them is "we got around to it".

| Vendor | Why refused | Comes back if |
|---|---|---|
| **Personio** | Tenant `robots.txt` disallows `/xml` — **the exact path we would read**. The live file 404s today after a site migration, so a live-only check would have waved it straight through. The archived rule is byte-identical across tenants on both TLDs. Detail in [`data/personio-gate.json`](data/personio-gate.json) | a tenant serves a `robots.txt` that permits `/xml` |
| **SmartRecruiters** | `api.smartrecruiters.com` serves `Disallow: /` to `*`, with one `Allow: /v1/companies/` scoped to `LinkedInBot`. We are not LinkedInBot | the `*` group grants the path |
| **Workable** | Not a permission problem — throttled to uselessness under a concurrent pass | it serves at volume |

You can argue that `robots.txt` was written for crawlers and does not govern a documented API
called deliberately. That reading is defensible. We took the stricter one: being wrong in that
direction costs a vendor, being wrong in the other direction costs the argument.

## Licence

Code MIT. The measurements are facts and belong to nobody.
