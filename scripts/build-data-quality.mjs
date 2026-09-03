#!/usr/bin/env node
// Build docs/data/data-quality.csv — the 500 measured boards, with how many of their postings
// are not paid jobs.
//
// Why this is worth publishing. Every feed in this category ships recruitment ads and volunteer
// listings; none of them publishes which boards they come from, because none of them has
// counted. The interesting result is not the corpus share (1.17% ads, 0.37% volunteer) but the
// concentration: 2 boards of 500 carry any ad at all, and one of them is 79% ads. A share that
// small looks ignorable right up until your run lands on that board.
//
// Reads data/role-census-titles.json — the cached titles from the run-2 census. No network,
// $0.00. Classification is the Actor's own, imported from actor/src so the CSV and the shipped
// filters cannot drift apart.
//
//   node scripts/build-data-quality.mjs

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isRecruitmentAd } from '../actor/src/recruitment-ads.js'
import { isVolunteerListing } from '../actor/src/volunteer.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = resolve(ROOT, 'data/role-census-titles.json')
const OUT = resolve(ROOT, 'docs/data/data-quality.csv')

const boards = JSON.parse(await readFile(CACHE, 'utf8'))

const rows = boards.map((b) => {
  let ads = 0
  let volunteer = 0
  for (const title of b.titles) {
    if (isRecruitmentAd({ title })) ads++
    else if (isVolunteerListing({ title })) volunteer++
  }
  const read = b.titles.length
  const notJobs = ads + volunteer
  return {
    provider: b.p,
    token: b.t,
    titles_read: read,
    recruitment_ads: ads,
    volunteer_unpaid: volunteer,
    not_jobs: notJobs,
    // One decimal, same as engineering.csv. This is the column worth sorting on.
    not_jobs_share: read ? +((100 * notJobs) / read).toFixed(1) : 0,
    stratum: b.s,
  }
})

// Worst first — the whole point of the file is to name the boards that carry the junk.
rows.sort((a, b) => b.not_jobs_share - a.not_jobs_share || b.not_jobs - a.not_jobs)

const header = 'provider,token,titles_read,recruitment_ads,volunteer_unpaid,not_jobs,not_jobs_share,stratum'
const csv = [header, ...rows.map((r) => Object.values(r).join(','))].join('\n')
await writeFile(OUT, `${csv}\n`)

const affected = rows.filter((r) => r.not_jobs > 0)
const totalRead = rows.reduce((s, r) => s + r.titles_read, 0)
const totalAds = rows.reduce((s, r) => s + r.recruitment_ads, 0)
const totalVol = rows.reduce((s, r) => s + r.volunteer_unpaid, 0)

process.stdout.write(`${OUT}\n`)
process.stdout.write(`${rows.length} boards, ${totalRead.toLocaleString()} titles read\n`)
process.stdout.write(`recruitment ads: ${totalAds} on ${rows.filter((r) => r.recruitment_ads > 0).length} boards\n`)
process.stdout.write(`volunteer/unpaid: ${totalVol} on ${rows.filter((r) => r.volunteer_unpaid > 0).length} boards\n`)
process.stdout.write(`boards with any: ${affected.length} of ${rows.length}\n\n`)
for (const r of affected.slice(0, 10)) {
  process.stdout.write(
    `  ${`${r.provider}/${r.token}`.padEnd(36)} ${String(r.titles_read).padStart(5)} read  ` +
      `${String(r.not_jobs).padStart(5)} not jobs  ${String(r.not_jobs_share).padStart(5)}%\n`,
  )
}
