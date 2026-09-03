#!/usr/bin/env node
// Census of the ATS-jobs Actor category on Apify.
//
// Answers three questions with measurement rather than impression:
//   1. Who is actually in this category, and how big are they?
//   2. What do they charge a FREE-plan buyer — which is the price a new user actually pays,
//      not the headline discounted tier quoted in marketing copy?
//   3. Are they carried by the Store index while we are not?
//
// Question 3 reuses the exact-name probe that `store-presence.mjs` established as trustworthy:
// 8 of 8 known-listed actors were returned by their exact name, so a miss on that probe means
// something. The census refuses to report on listing when the control does not pass.
//
// Usage: APIFY_TOKEN must be set (source the repo .env). Writes data/category-census.csv.

import { writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_CSV = join(ROOT, 'data', 'category-census.csv');

const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) {
  console.error('APIFY_TOKEN is not set. Read it from .env; never paste the value anywhere.');
  process.exit(1);
}

// The category as observed. Sources: Apify Store search, and public web search for
// `site:apify.com` ATS terms — which surfaced six of these that Store search never showed us.
const SUBJECTS = [
  'sharp_malachite/open-ats-jobs-feed',
  'fantastic-jobs/career-site-job-listing-api',
  'fantastic-jobs/career-site-job-listing-feed',
  'fantastic-jobs/jobs-scraper',
  'fantastic-jobs/workday-jobs-api',
  'themineworks/ats-jobs',
  'dami_studio/multi-ats-jobs-scraper',
  'bikram07/multi-ats-jobs-feed',
  'fetchcraft/ats-job-aggregator',
  'studious_allergy_mig/ats-jobs-scraper',
  'tokyo-cat/ats-job-feed',
  'memo23/career-site-ats-jobs-api',
  'scrapepilot/career-page-job-scraper----greenhouse-lever-any-ats',
];

// Controls for the listing probe: actors we have independently confirmed are in the Store.
// If any of these fails to come back by exact name, the probe is broken and we say so rather
// than reporting anyone as absent.
const LISTING_CONTROLS = [
  'fantastic-jobs/career-site-job-listing-api',
  'themineworks/ats-jobs',
];

const api = async (path) => {
  const res = await fetch(`https://api.apify.com/v2${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json() };
};

// The FREE-plan price is what a new buyer actually pays. Tiered pricing quotes the discounted
// enterprise rate in marketing copy; that is not the entry price and must not be compared
// against ours as though it were.
function freeTierPricePerJob(pricingInfos) {
  if (!Array.isArray(pricingInfos) || pricingInfos.length === 0) return null;
  // pricingInfos is append-only history — the last record is what is live now.
  const current = pricingInfos[pricingInfos.length - 1];
  if (current.pricingModel === 'PRICE_PER_DATASET_ITEM') {
    return { model: 'per-item', free: current.pricePerUnitUsd ?? null, events: null };
  }
  const events = current.pricingPerEvent?.actorChargeEvents ?? {};
  const out = {};
  for (const [key, ev] of Object.entries(events)) {
    const free = ev.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd ?? ev.eventPriceUsd ?? null;
    out[key] = free;
  }
  // The per-result event is the one comparable across actors.
  const resultKey = Object.keys(out).find((k) =>
    /job|result|item|dataset/i.test(k) && !/start/i.test(k));
  return {
    model: 'pay-per-event',
    free: resultKey ? out[resultKey] : null,
    events: out,
  };
}

// Listing must be probed ANONYMOUSLY. An authenticated probe answers "is it in the index",
// which is not the question — a buyer and a crawler are both anonymous. Getting this wrong is
// what made Cycle 31 report our own Actor as absent and this script briefly report it as listed;
// see docs/research/cycle-32-store-record-withheld.md.
async function isListed(username, name) {
  const res = await fetch(
    `https://api.apify.com/v2/store?search=${encodeURIComponent(name)}&limit=100`);
  if (!res.ok) return { listed: null, reason: `store HTTP ${res.status}` };
  const body = await res.json();
  const items = body?.data?.items ?? [];
  const hit = items.some((i) => i.username === username && i.name === name);
  return { listed: hit, count: items.length };
}

const rows = [];
console.log('ATS Actor category census —', new Date().toISOString());
console.log('');

// Control pass first. Absence means nothing if the probe cannot find known-present actors.
let controlsOk = 0;
for (const ref of LISTING_CONTROLS) {
  const [u, n] = ref.split('/');
  const r = await isListed(u, n);
  if (r.listed === true) controlsOk += 1;
  else console.log(`  control MISS: ${ref} (${r.reason ?? 'not in results'})`);
}
const controlsPass = controlsOk === LISTING_CONTROLS.length;
console.log(`listing-probe controls: ${controlsOk}/${LISTING_CONTROLS.length} ${controlsPass ? 'pass' : 'FAIL'}`);
if (!controlsPass) {
  console.log('  Controls failed. Listing results below are NOT evidence of absence.');
}
console.log('');

for (const ref of SUBJECTS) {
  const [username, name] = ref.split('/');
  const res = await api(`/acts/${username}~${name}`);
  if (!res.ok) {
    console.log(`  ${ref}: unreachable (HTTP ${res.status})`);
    continue;
  }
  const d = res.body.data;
  const s = d.stats ?? {};
  const price = freeTierPricePerJob(d.pricingInfos);
  const listing = controlsPass ? await isListed(username, name) : { listed: null };

  rows.push({
    ref,
    created: d.createdAt,
    users: s.totalUsers ?? 0,
    users30: s.totalUsers30Days ?? 0,
    runs: s.totalRuns ?? 0,
    publicRuns30: s.publicActorRunStats30Days?.TOTAL ?? 0,
    reviews: s.actorReviewCount ?? 0,
    rating: s.actorReviewRating ? Number(s.actorReviewRating.toFixed(2)) : 0,
    bookmarks: s.bookmarkCount ?? 0,
    freePerJob: price?.free ?? null,
    per1000: price?.free != null ? Number((price.free * 1000).toFixed(2)) : null,
    listed: listing.listed,
  });
}

rows.sort((a, b) => b.users - a.users);

const pad = (v, n) => String(v).padEnd(n);
const rpad = (v, n) => String(v).padStart(n);
console.log(pad('actor', 52), rpad('users', 6), rpad('30d', 5), rpad('runs', 8), rpad('rev', 4), rpad('$/1k', 7), ' listed');
for (const r of rows) {
  console.log(
    pad(r.ref, 52),
    rpad(r.users, 6),
    rpad(r.users30, 5),
    rpad(r.runs, 8),
    rpad(r.reviews, 4),
    rpad(r.per1000 == null ? '—' : `$${r.per1000}`, 7),
    ' ' + (r.listed === null ? '?' : r.listed ? 'yes' : 'NO'),
  );
}

mkdirSync(dirname(OUT_CSV), { recursive: true });
const header = 'measured_at,actor,created,users,users_30d,runs,public_runs_30d,reviews,rating,bookmarks,free_price_per_job,free_price_per_1000,listed,controls_pass\n';
if (!existsSync(OUT_CSV)) writeFileSync(OUT_CSV, header);
const now = new Date().toISOString();
for (const r of rows) {
  appendFileSync(OUT_CSV, [
    now, r.ref, r.created, r.users, r.users30, r.runs, r.publicRuns30,
    r.reviews, r.rating, r.bookmarks,
    r.freePerJob ?? '', r.per1000 ?? '',
    r.listed === null ? '' : r.listed, controlsPass,
  ].join(',') + '\n');
}
console.log(`\nappended ${rows.length} rows to data/category-census.csv`);
