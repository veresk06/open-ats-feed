# Cycle 34 — a fourth provider that passes the gate, and the Workable rate

Two measured results, both taken 2026-09-03.

## 1. Workable: the usable cadence is ~0.45 req/s, and it is not close

Cycle 33 established the block was transient — 1 request per 45 seconds was served `200`
six times out of six — and left the actual limit unknown between that and the ~6 concurrent
that gets challenged. `probe-workable-resume.mjs` gained a `--delay-ms` knob so the answer
could be bisected instead of guessed.

| Setting | Probed | Settled | Blocked | Blocked rate |
|---|---:|---:|---:|---:|
| `--concurrency=8 --delay-ms=0` (Cycle 33) | 12 | 0 | 12 | **100%** |
| `--concurrency=1 --delay-ms=2000` | 54 | 54 | 0 | **0.0%** |

54 settled probes in 120 seconds, zero challenges. That is ~0.45 req/s, roughly 27 boards a
minute. The remaining 6,414 tokens are therefore about four hours of wall clock — long, but
unattended and resumable, which is exactly what `probe-workable-resume.mjs` was built for.
It is now running detached at that cadence.

One bisection point, not a curve: this says 1 req/2s is safe and 8-concurrent is not. It does
not say where between them the wall is, and there is no reason to spend more requests finding
out — the safe rate already finishes the roster overnight.

Cumulative after the calibration pass: 468 probed of 6,882, hit rate **37.8%**, close to the
39.0% the 400-token sample predicted.

## 2. Breezy passes the same gate that SmartRecruiters and Workable failed

The gate, unchanged: robots.txt on the host we actually fetch → is the API real → will it
serve us at volume.

**robots.txt.** `{token}.breezy.hr/robots.txt` reads:

```
User-Agent: *
Disallow: /css
Disallow: /fonts
Disallow: /stylesheets
Disallow: /javascripts

User-Agent: AhrefsBot
Disallow: /
```

`/json` — the board endpoint — is allowed. The distinction that matters: the *marketing* host
`breezy.hr` carries `Disallow: /api/`, and we do not fetch that host at all. Reading the wrong
one of these two files would have produced the wrong answer in either direction.

**The API is real.** `https://{token}.breezy.hr/json` returns a bare JSON array of postings:
`id`, `friendly_id`, `name`, `url`, `published_date`, `type{id,name}`,
`location{country,name,city,is_remote}`, `department`, `salary`, `company{name,friendly_id}`.
A board with nothing open answers `200` with `[]`; a dead token answers `404`. Those are clean,
distinguishable verdicts — the same shape the other four providers give.

Probed live on five real tenants: `75f` 1 posting, `accelone` 9, `a2h` 19, `20four7va` 91,
`47-degrees` and `99-group` empty, `3dbio-therapeutics` 404.

**No description.** Breezy's board endpoint carries no posting body — it sits behind a
per-posting fetch we do not make. `description` is therefore `null` on every Breezy row. That
is recorded rather than papered over; putting a title in a column that means "the posting"
would make one column mean two things depending on which provider the row came from.

**`location.is_remote` is not trusted.** Ashby ships a flag that looks identical and is true
for Hybrid roles; believing it once mislabelled two thirds of the feed. Workable's
`telecommuting` earned its place by being measured across 590 postings (true on 8.0%,
overlapping "hybrid" exactly 0 times). Breezy's flag has been measured against nothing, so the
workplace column comes from the text until it has been. There is a test asserting exactly that.

## 3. The structural finding: our harvester could only see path-token vendors

`tokenFromUrl` took the first path segment. Greenhouse, Lever, Ashby and Workable all address
a board as `vendor.tld/{token}`. Breezy, Recruitee, Teamtailor and Personio address one as
`{token}.vendor.tld`, and a path-only harvester finds **none** of them — it was not that those
vendors were closed, it was that we never looked.

That is one concrete, self-inflicted reason the provider count sat at three against the
leader's 54, and it is now fixed:

- `tokenFromUrl(url, { tokenFrom: 'subdomain', host })` takes the single label left of the
  vendor host. The host is required and never inferred — otherwise `acme.breezy.hr.evil.com`
  yields a token. A nested label (`a.b.breezy.hr`) is rejected rather than flattened.
- `NOT_A_TOKEN` gained `www`, `app`, `help`, `support`, `blog`, `status`, `admin` and the rest.
  On a path vendor these could never occupy position 0; on a subdomain vendor the vendor's own
  marketing and console hosts sit in exactly the slot a company token occupies.
- `surtPrefix` stops one comma short for a subdomain source: `breezy.hr` → `hr,breezy,`, which
  matches every tenant and, by omitting the `)/`, excludes the vendor's own apex.

The harvest is running: 2,363 Breezy tokens from the first two of thirteen Common Crawl
indices.

## What is not claimed

Breezy is **not** in the shipped roster, and no number from it belongs in the measured table
until the full probe has run. The 10,197 boards / 291,507 postings figures are unchanged this
cycle. What changed is that a fourth and a fifth provider are now reachable, and that the class
of vendor we were structurally blind to is no longer invisible.
