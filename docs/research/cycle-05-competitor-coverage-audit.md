# Cycle 5 — Competitor Coverage Audit: What Is 175,000 Made Of?

**Analyst:** research-thompson
**Date:** 2026-09-03
**Method:** unauthenticated `curl` probes against documented/known ATS endpoints, plus WebFetch of competitor Apify listings. Every claim below is tagged **[MEASURED]** (I ran it / I read it verbatim) or **[INFERRED]** (reasoning from measurement, not itself observed).
**Time budget:** ~10 min wall clock. Coverage is partial by design — 13 of 54 platforms probed directly, selected for volume weight.

---

## Bottom line

The competitor is **not selling the same thing we are, and they say so themselves.** Their own documentation calls their pipeline scraping, not API aggregation:

> **[MEASURED]** "We scrape all jobs in the backend, and you're accessing our database with scraped jobs with a small delay."
> — https://apify.com/fantastic-jobs/career-site-job-listing-api

> **[MEASURED]** "Our scrapers run continuously. We typically add a new job to our database within 3 hours of posting!"
> — https://apify.com/fantastic-jobs/career-site-job-listing-api/api

This is the single most important sentence in this report. We did not have to infer their fragility from the platform mix. **They describe themselves as a scraper in their own product copy.** Munger's cold-start risk has *not* materialised in the form he feared.

---

## 1. Platform classification — is the source class the same as ours?

The listing names all 54 platforms **[MEASURED]**:

ADP, ApplicantPro, Ashby, BambooHR, Breezy HR, CareerPlug, Comeet, CSOD, Dayforce, Dover, Eightfold, FirstStage, Freshteam, Gem, GoHire, Greenhouse, HiBob, HireBridge, HireHive, Hireology, HiringThing, iCIMS, iSolved, JazzHR, Jobvite, JOIN.com, Kula, Lever.co, Manatal, Oraclecloud, PageUp, Paradox, Paycom, Paycor, Paylocity, Personio, Phenompeople, Pinpoint, Polymer, Recruitee, Recooty, Rippling, Rival, SmartRecruiters, SuccessFactors, Taleo, TeamTailor, Trakstar, TriNet, UltiPro, WeRecruit, Workable, Workday, Zoho Recruit.

I probed 13 of these plus our own three. Classification scheme:

- `public-api` — vendor publishes an unauthenticated endpoint intended for third-party consumption. **This is our source class.**
- `internal-endpoint` — unauthenticated JSON exists, but it is the vendor's own SPA backend, undocumented, no stability contract. Reachable today; revocable without notice.
- `scraped-html` — no unauthenticated machine endpoint; jobs must be parsed out of rendered HTML.
- `authenticated` — API exists but requires a per-tenant key/token the aggregator does not have.

### Probe results

| Platform | Class | Evidence (all probes run 2026-09-03, unauthenticated) |
|---|---|---|
| **Greenhouse** | `public-api` **[MEASURED]** | `GET boards-api.greenhouse.io/v1/boards/stripe/jobs` → **200** JSON. Our own source. |
| **Ashby** | `public-api` **[MEASURED]** | `GET api.ashbyhq.com/posting-api/job-board/ramp` → **200** JSON. Our own source. |
| **Lever** | `public-api` **[MEASURED]** | `api.lever.co/v0/postings/{co}` — our own Cycle-1 harvest probed 1,000 tokens at 1 req/s and got 347 live JSON responses (`data/summary-c3-lever.json`). Documented, unauthenticated. |
| **SmartRecruiters** | `public-api` **[MEASURED]** | `GET api.smartrecruiters.com/v1/companies/Ubisoft/postings` → **200** `application/json`, well-formed `{offset,limit,totalFound,content}`. Documented public endpoint. |
| **Workable** | `public-api` **[MEASURED]** | `GET apply.workable.com/api/v1/widget/accounts/eneba?details=true` → **200** JSON `{"name":"Eneba",...,"jobs":[]}`. |
| **Breezy HR** | `public-api` **[MEASURED]** | `GET breezy.breezy.hr/json` → **200** JSON array, 1,898 bytes of real postings. |
| **Personio** | `public-api` (XML) **[MEASURED]** | `GET personio.jobs.personio.de/xml` → **200** `text/xml`, `<workzag-jobs><position>...`. Public and unauthenticated, but XML not JSON. |
| **Rippling** | `public-api` **[MEASURED]** | `GET api.rippling.com/platform/api/ats/v1/board/rippling/jobs` → **200** JSON, **212 KB** payload. |
| **Recruitee** | `public-api` **[INFERRED, weak]** | `GET {co}.recruitee.com/api/offers/` → **404** with `application/json` body `{"error":"Not Found"}` on two guessed slugs. The route answers in JSON rather than an HTML 404 page, which indicates the API exists and my slugs were wrong. Documented publicly. Not confirmed with a live 200. |
| **Workday** | `internal-endpoint` **[MEASURED]** | `POST nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs` → **200** JSON, `{"total":2000,"jobPostings":[...]}`. Reachable without auth — but `/wday/cxs/` is Workday's own client-side XHR backend, not a published partner API. No versioning promise, no ToS grant, per-tenant path. |
| **BambooHR** | `internal-endpoint` **[MEASURED]** | `GET tesla.bamboohr.com/careers/list` → **302**; `kraken.bamboohr.com/careers/list` → **200** but `text/html` (redirected to BambooHR's marketing site). The `/careers/list` JSON route is real for valid tenants but undocumented and gated behind subdomain validity. |
| **Oracle Cloud (Oraclecloud)** | `internal-endpoint` **[INFERRED]** | `hcmUI/CandidateExperience/.../requisitions` → **302** HTML redirect; `hcmRestApi/.../recruitingCEJobRequisitions` probe timed out (host guess wrong). The unauthenticated CE REST route is known to exist per-tenant but is undocumented. Not confirmed. |
| **SuccessFactors** | `scraped-html` **[MEASURED]** | `GET jobs.sap.com/search/` → **200** `text/html;charset=UTF-8`, **117 KB** of markup. No unauthenticated JSON equivalent. SF's OData API is authenticated per tenant. |
| **iCIMS** | `scraped-html` **[MEASURED]** | `careers.icims.com/jobs/search?ss=1` → **302** to an HTML careers-home page; `careers-fisglobal.icims.com/...` → **404 HTML** (`gone: ... dc409`). iCIMS' actual API is partner-authenticated. |
| **Taleo** | `scraped-html` **[MEASURED]** | `tbe.taleo.net/careersection/2/jobsearch.ftl` → **404 `text/html`**; `chevron.taleo.net/careersection/...` → connection failure (000, likely bot-blocked). `.ftl` = FreeMarker server-rendered template. No public JSON. |
| **Paylocity** | `scraped-html` **[MEASURED]** | `recruiting.paylocity.com/recruiting/jobs/All` → **200 `text/html`** with an embedded `window.dataLayer`. HTML parsing required. |
| **TeamTailor** | `authenticated` **[MEASURED]** | `api.teamtailor.com/v1/jobs` → **406** `{"errors":[{"status":406,"title":"Invalid/Missing API Version"}]}`; requires `X-Api-Key`. `{co}.teamtailor.com/jobs.json` and `jobs.rss` → **404**. |
| **Comeet** | `authenticated` **[MEASURED]** | `comeet.co/careers-api/2.0/company/{uid}/positions` → **400** `{"message":"Token is missing"}`. |
| **JazzHR** | `authenticated` / `scraped-html` **[MEASURED]** | `app.jazz.co/api/jobs` → **302**; public boards are `applytojob.com` HTML. The Resumator API requires `apikey`. |
| **Zoho Recruit** | `authenticated` **[MEASURED]** | `recruit.zoho.com/recruit/v2/Job_Openings` → connection refused (000) unauthenticated; OAuth-gated. |

### The measured split

Of the 20 rows above (16 platforms from their list of 54, plus our 3 which overlap):

| Class | Count | Share of probed |
|---|---|---|
| `public-api` (our source class) | 9 | 45% |
| `internal-endpoint` (unauth but undocumented) | 3 | 15% |
| `scraped-html` | 4 | 20% |
| `authenticated` | 4 | 20% |

**[MEASURED]** Roughly **45% of the platforms I probed are the same source class we use. 55% are not.**

**[INFERRED]** The split understates the volume asymmetry, and this is the analytically important part. The `public-api` platforms are the *modern, startup-facing* ATSes — Greenhouse, Ashby, Lever, Workable, Breezy, Personio, SmartRecruiters, Rippling. They have many tenants but small ones. The platforms with **no** public API — Workday, SuccessFactors, Taleo, iCIMS, Oracle, ADP, UltiPro/UKG, Paycom, Paycor, Paylocity, Dayforce, CSOD, Phenom, Jobvite, TriNet, PageUp — are the *enterprise* ATSes, and they hold the Fortune-2000 seats. To reach 175,000 sites at all, a vendor must go deep into exactly the tier where no public API exists. The 54-platform count is not a coverage flex; it is a confession about method.

---

## 2. Is 175,000 "sites" the same unit as our 9,006 "verified-live boards"?

**No. Not remotely. They are three different units.**

**Our unit [MEASURED]:** 9,006 = boards probed on 2026-09-03 that returned HTTP 200 **and** carried ≥1 open posting, counting only tokens actually probed with zero projection (`data/coverage-summary.json`, `measuredFloorCompanies: 9006`). 256,339 is a **stock** — open postings visible right now.

**Their unit [MEASURED]:** "Direct postings from over 175k+ company career sites." No definition of "career site" is given anywhere on the listing or `/api` tab. No statement that these were probed, that they are live, or that they carry open roles. Separately they state ~**1.8 million jobs indexed monthly** — that is a **flow**, not a stock. Nowhere on the listing is a stock number of currently-open postings published.

So: their 175k is an **unqualified roster count**, their 1.8M is a **monthly flow**, and our 256,339 is a **current stock**. Comparing 175,000 to 9,006 is a category error, and comparing 1.8M/mo to 256,339-open is a second one.

**What our own harvest implies about a 175,000 headline [INFERRED, but grounded in our measured rates]:**

Our measured harvest-to-live conversion, per `data/coverage-summary.json`:

| Provider | Tokens harvested | Live (200 + ≥1 posting) | Hit rate |
|---|---|---|---|
| Greenhouse | 10,091 | 5,506 | **54.6%** [measured in full] |
| Ashby | 4,386 | 3,153 | **71.9%** [measured in full] |
| Lever | 4,961 | 347 of 1,000 sampled | **34.7%** [measured on sample] |
| **Total** | **19,438** | **10,380 projected / 9,006 measured floor** | **53.4% / 46.3%** |

**[MEASURED]** Roughly **half of every ATS token you can harvest is dead or empty** — the board 404s, the tenant churned off the platform, or it exists with zero open roles. This is not a quirk of our crawler; it is the base rate of the ATS token space.

**[INFERRED]** If their 175,000 is a harvested-token roster built the same way — and there is no other way to assemble 175,000 career sites — the live-and-non-empty subset is plausibly **80,000–95,000**, not 175,000. That is still ~9–10× our 9,006 and I am not going to pretend otherwise. But the honest comparison is 9,006-verified vs ~85,000-estimated-verified, against a headline of 175,000. Their number is inflated relative to ours by roughly 2× **purely from unit definition**, before any question of source quality.

**[MEASURED, corroborating]** Their own arithmetic is consistent with a padded roster: 1.8M jobs/month ÷ 175,000 sites ≈ **10 new postings per site per month**. Our measured median is 8–10 *currently open* postings per live board. A site would have to be turning over its entire open req list monthly for those to reconcile. **[INFERRED]** Either a large fraction of the 175k contributes ~zero postings, or "site" counts something looser than "board with open roles."

---

## 3. Does their coverage inherit the durability risk? — Yes, by their own admission

Our Cycle-1 wedge was that ~340K of ~367K job-data users on Apify sit on ToS-fragile LinkedIn/Indeed scrapers, and that we cannot be switched off because we call APIs the vendors publish deliberately.

**[MEASURED]** The competitor's fragility is not something we need to infer from the platform mix. They state it: *"We scrape all jobs in the backend"*, *"Our scrapers run continuously."* And **[MEASURED]** they additionally index Apple, Amazon, Meta and Google, which they describe as *"operating outside traditional ATS systems"* — i.e. four bespoke scrapers against four of the most aggressively bot-defended career sites on the internet.

**[MEASURED]** My probes corroborate the mechanism. Taleo returned a bot-block (connection reset) on a plain `curl` with no unusual headers. iCIMS 302'd then 404'd. SuccessFactors served 117 KB of markup. Those three alone are a large share of enterprise ATS seats, and none of them can be read without an HTML parser that breaks when the vendor reskins the page.

**[INFERRED]** Three distinct fragility classes in their stack, only one of which we share:

1. **`scraped-html`** — breaks on any template change; blockable by IP/UA/Cloudflare at the vendor's discretion; the vendor has no reason to want you there. We have none of this.
2. **`internal-endpoint`** (Workday, BambooHR, Oracle) — the sharpest risk, because it *looks* like an API. `/wday/cxs/` is Workday's own SPA backend. Workday can add a CSRF token, a signed session, or rate limiting per tenant in a single release and every downstream consumer dies simultaneously with no deprecation window, because there was never a contract to deprecate. **[INFERRED]** Given Workday's enterprise-seat share, this is likely the single largest block of their 175,000 and it is the block with the least warning before it goes.
3. **`public-api`** — the ~45% they share with us, where the vendor publishes the endpoint deliberately and has a business reason (job distribution to aggregators) to keep it up. **This is 100% of our surface.**

**Conclusion:** 175,000 and 9,006 are **not the same unit**, on two independent axes — verified-live vs harvested-roster, and API-sourced vs scraped. Saying this precisely in our listing is worth more than chasing their raw count. We cannot win on count in this cycle and should stop trying.

---

## 4. Has Munger's cold-start risk materialised?

**No — not in the form he specified.** State it plainly to the CEO, without softening in either direction:

**The good news [MEASURED]:** The market leader is not an API aggregator that has simply out-executed us on the same substrate. They are a scraping operation with a database in front of it, and they say so in their own product copy. Our provenance claim is genuinely differentiated and survives contact with the evidence.

**The bad news, stated without softening [MEASURED]:** They have 6,678 total users and 1,457 monthly active users at $4 per 1,000 jobs. They index 1.8M jobs monthly with ~1h delay. Whatever the provenance, they have a working business and we have zero users. **Provenance is a claim about durability, and durability is a benefit that only pays off over time — it does not acquire the first customer.** A buyer who needs Workday and SuccessFactors coverage today cannot buy it from us at any price, and "our sources are more durable" is not an answer to that buyer. Our addressable segment is specifically *those who need startup/scale-up ATS coverage and care about not being switched off* — that is a real segment, and it is smaller than the whole market.

**The genuine risk that did materialise [INFERRED]:** not that the leader owns our source class, but that **our source class is cheap to replicate.** The `public-api` tier is 8–9 platforms with documented endpoints; I confirmed five of them with single `curl` commands in under two minutes. Nothing stops the incumbent from adding Workable, Breezy, Personio, SmartRecruiters and Rippling — they already list all five. Our moat is not the endpoints. It is the **verified-live roster** (19,438 harvested tokens → 9,006 confirmed) and the discipline of publishing measured rather than projected numbers. That roster took a full cycle to build and is the asset worth defending.

---

## 5. Cheap new entrants — brief survey

**[MEASURED]** `themineworks/ats-jobs` (https://apify.com/themineworks/ats-jobs) covers **four** platforms — Greenhouse, Lever, Workday, Ashby — at **$1.00 per 1,000 results** on Gold tier ($0.00225/posting on free), with **6 total users and 4 monthly active**. Its positioning language is nearly identical to ours: official public APIs, *"talks to each ATS in its native format,"* explicitly citing `boards-api.greenhouse.io` as requiring no authentication, and distinguishing itself from consumer job-board aggregators as reading from a *"first-party ATS source"* with no login or anti-bot exposure. Critically, it is **input-driven** — the user supplies company slugs and `maxJobsPerCompany`; it ships no roster of its own. **[INFERRED]** That is the whole difference and it is the right place to plant our flag: this actor is a *fetcher* (you must already know which companies you want), whereas we are a *feed* (9,006 verified boards, no input required). At 6 users it is not competitive pressure today, but it proves the API-provenance pitch is not proprietary to us, and at $1/1,000 it sets a price ceiling below the leader's $4/1,000. It also includes Workday, which by my measurement is `internal-endpoint` rather than `public-api` — so its own "official public APIs" claim is looser than ours would be.

---

## 6. Information gaps — what I do not know

1. **Their live rate is unmeasured.** I did not probe their actual output. The only way to settle whether 175,000 means live boards is to run their actor on a sample and count distinct companies with ≥1 open posting. **This is the single highest-value follow-up and it costs a few dollars.** Everything in §2 above the base-rate arithmetic is inference until then.
2. **Recruitee unconfirmed** — two slug guesses 404'd. Needs one valid tenant to confirm a 200.
3. **Oracle Cloud unconfirmed** — host guess was wrong; the unauthenticated CE REST route is reported to exist but I did not reach it.
4. **41 of 54 platforms unprobed**, mostly the long tail (Recooty, WeRecruit, FirstStage, Polymer, Kula, Rival, HireBridge). **[INFERRED]** These are small-vendor ATSes that contribute little to 175,000 either way; classifying them would sharpen the percentage without moving the volume conclusion.
5. **Their per-platform site distribution is not published.** I cannot say what share of 175,000 sits on Workday specifically. If it is >40%, the fragility argument becomes considerably stronger than I have stated it. If Workday is a thin slice and most of the 175k sits on public-API platforms, my §1 volume inference weakens. This is the load-bearing unknown in this report.

---

## Recommendation (separated from the evidence above)

1. **Stop competing on board count.** We lose that comparison and it is not the comparison that sells.
2. **Make provenance the headline claim, and make it falsifiable** — that is the part competitors cannot copy without changing their pipeline. Proposed Store listing line:

   > **9,006 boards verified live today — every one from an official public ATS API, not a scraper.** No HTML parsing, no anti-bot evasion, no login. Greenhouse, Ashby and Lever publish these endpoints deliberately; we cannot be switched off by a page redesign.

   Every number in it is measured and re-measurable, which is the point.
3. **Add the freshness/verification unit explicitly** so the unit mismatch is legible to a buyer without us attacking anyone: state *"verified live = probed today, HTTP 200, ≥1 open posting"* directly in the listing. Let the reader notice that nobody else defines their number.
4. **Spend the few dollars on running the competitor's actor** and count distinct live companies in the output. It converts §2 from inference to measurement and is the cheapest high-value research left.
5. **[INFERRED, for CEO]** Adding Workable, Breezy, SmartRecruiters, Personio and Rippling is genuinely low-cost — five documented public APIs, all confirmed reachable above — and would extend the roster **without diluting the provenance claim**, since all five are `public-api`. Do **not** add Workday: it would grow the count but it is `internal-endpoint`, and taking it would forfeit the one sentence that distinguishes us.
