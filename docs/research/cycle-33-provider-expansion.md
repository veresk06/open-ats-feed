# Cycle 33 — Two ATS vendors evaluated, both rejected, both on measured evidence

**Date:** 2026-09-03
**Question:** the Cycle-32 category census found that price is not the binding constraint and
that the category leader differs from us mainly in breadth — 54 claimed ATS platforms against our
3. Coverage is the one gap in that census that is entirely in our own hands. Can we close it?

**Answer:** not with these two. SmartRecruiters refuses us in robots.txt. Workable allows us in
robots.txt and then rate-limits us at the edge. The fourth-provider code path is built, tested
and committed; the vendor access is not there.

---

## SmartRecruiters — rejected on robots.txt

The API is real and the data is good. `GET /v1/companies/{identifier}/postings` returns 200 with
fully populated records — structured `location` including explicit `remote` and `hybrid`
booleans, `department`, `function`, `typeOfEmployment`, `experienceLevel`, `releasedDate`. Better
structured than Greenhouse. 1,886 board tokens were harvested from six Common Crawl indices
before the disqualifying fact was checked.

```
$ curl -s https://api.smartrecruiters.com/robots.txt
User-agent: LinkedInBot
Allow: /v1/companies/

User-agent: *
Disallow: /
```

An explicit allowance for LinkedIn's crawler on exactly the path we would use, and a blanket
refusal for everyone else. Checked on all four hosts; `www.smartrecruiters.com` additionally
disallows a long list of individual company paths, which is a further signal that this vendor
manages crawler access deliberately rather than by neglect.

**Why this is a kill and not an inconvenience.** The Cycle-5 competitor audit established that
the incumbent's coverage is 45% public API, 15% undocumented internal endpoint, 20% scraped HTML
and 20% authenticated — and that our differentiator is being the feed whose every posting comes
from an API its vendor publishes for the taking. That claim is the one thing a scraper cannot
copy. Fetching a host that refuses us in writing would spend it to buy ~1,800 boards.

One thing worth keeping: the company identifier is **case-sensitive** and sits verbatim in the
API path, so `ubisoft` and `Ubisoft` are different boards and only one exists. The harvester's
lowercasing would have produced a roster of 404s. `tokenFromUrl` now takes a `caseSensitive`
option and keeps it despite no current source needing it, because the next vendor evaluated may.

**Tokens discarded. A test now fails if any `smartrecruiters.com` host is re-added to `SOURCES`.**

---

## Workable — rejected as a default, on Cloudflare bot mitigation

robots.txt is maximally permissive — an *empty* `Disallow`, which means everything is allowed:

```
User-agent: *
Content-Signal: search=yes, ai-input=yes, ai-train=no
Disallow:
```

`ai-train=no` is respected and not in tension with what we do: we index and redistribute
postings, we do not train models on them.

### What was measured before the block

6,882 tokens harvested. A 400-token sample spread evenly across the roster (not the alphabetical
head, which biases toward numeric-prefixed companies):

| Measure | Value |
|---|---:|
| Sampled | 400 |
| Live — HTTP 200 | 374 |
| Dead — 404/410 | 25 |
| Error | 1 |
| **Boards with ≥1 open posting** | **156 — 39.0%** |
| Postings in the sample | 4,574 |

39.0% sits between Lever (31.0%) and Greenhouse (54.6%), so the roster is of ordinary quality.
Extrapolated: ~2,680 live boards, ~78,000 open postings — about a 27% increase on our 291,507.

**These numbers are a sample, not a roster.** They are recorded here and italicised in
`consensus.md` so they are never quoted as measured coverage.

### The `telecommuting` flag, and why it is trusted where Ashby's is not

Ashby ships `isRemote`, and it is `true` for Hybrid roles too — believing it once classified two
thirds of the feed as remote, wrong by roughly 3×. That history made Workable's `telecommuting`
worth measuring rather than assuming, across 590 sampled postings:

| Measure | Count |
|---|---:|
| Postings | 590 |
| `telecommuting: true` | 47 — 8.0% |
| "hybrid" in city/state/country/title | 0 |
| **Both** | **0** |

No overlap at all. The flag is a genuine remote marker. It is still not trusted blindly: a hybrid
label in the location or title wins over it, so if the vendor's semantics ever drift the mapper
degrades to the string match instead of corrupting the column.

`experience` is deliberately **ignored** even though it is present and clean. Three providers
derive `seniority` from the title; taking a vendor enum for the fourth would make one column mean
two different things depending on which row it sits in. Uniform and documented beats marginally
richer and inconsistent.

### The block

After roughly 700 requests in total, every subsequent request returned:

```
HTTP/2 429
cf-mitigated: challenge
server: cloudflare
```

No `Retry-After`, no `X-RateLimit-*` — this is Cloudflare bot management issuing a challenge, not
a documented rate limit. The full 6,882-token pass recorded 12 consecutive `blocked` and nothing
else before it was stopped.

**It clears.** A single request every 45 seconds returned HTTP 200 **six times out of six**, over
four and a half minutes, starting while the concurrent pass was still recording `blocked`. So
Workable is **rate-limited, not closed** — Lever's problem with an undocumented and far stricter
limit. The sustainable rate is bounded but not yet calibrated: 1 req/45s works and ~6 concurrent
does not, and nothing between the two has been tested. Calibrating it is a cheap next step, not
a cycle's work.

### Why it ships off by default

A customer presses **Try**, is billed per board scanned, and receives boards that returned
nothing. That is the one-star review that ends the product, and it is the operator's own stated
concern about run quality on a marketplace where rating is ranking. Workable therefore ships
reachable but off by default, with the limit stated in the input schema in plain words rather
than discovered by a customer.

**Bypassing the challenge was never considered.** It is evasion, it is outside what this company
does, and it would forfeit the provenance claim that is the entire differentiator.

---

## What this says about the leader's "54 ATS platforms"

Two of the two vendors evaluated turned out to be closed to permitted automated access at
volume — one by policy, one by enforcement. That is direct evidence for the Cycle-5 audit
finding rather than a restatement of it: if a vendor sample this small yields two closed doors,
**54 permitted public APIs is very unlikely to be what that number is made of.** Their 54 and our
3 are not the same unit. This is worth saying precisely in the listing, with evidence — the
Cycle-32 census already established that competing on price is not what is binding.

## Engineering left behind

- `PROVIDERS.workable` in `actor/src/normalize.js` — correct, tested, dormant.
- `PROVIDER_NAMES` derived from `SOURCES`. The harvester previously hard-coded its provider set
  in two places; a provider added to `SOURCES` and forgotten in `harvest-s3.mjs` would have had
  its tokens dropped and, worse, **wiped from `tokens.json` by the whole-file save**.
- `HOSTS=` filter on the harvester, so adding a vendor does not re-walk the three already done.
- `scripts/probe-workable-resume.mjs` — resumable, append-per-token. On resume it re-probes
  `blocked` and `error` rather than skipping them: those are facts about our request, and
  treating them as settled writes off boards Cloudflare happened to challenge, permanently and
  silently.
- 131 tests pass, up from 118.
