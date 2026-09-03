#!/usr/bin/env node
// Resolve `unclassifiable_generic` titles with a board-level prior — and measure whether the
// prior is worth trusting before using it.
//
// The problem. 9.35% of the 121,050 titles we read (11,319 of them; 11.96% once weighted to the
// corpus) land in `unclassifiable_generic`. They are bare nouns: `manager` 4,209, `lead` 2,504,
// `associate` 1,922. "Business Operations Associate" says a level and nothing about the work.
// The title cannot resolve it. The *board* usually can — "Stretch Manager" is unreadable until
// you notice the board is a stretch-therapy studio whose other 40 postings are all fitness.
//
// The method. For each board, count the families of its titles that DID resolve to a real role
// family, take the most common one, and use it as the board's prior. Assign a board's generic
// titles to that family when the board has enough resolved titles (support) and the top family
// is dominant enough (confidence).
//
// The part that matters. A prior is a guess, so it is only publishable with a measured error
// rate. This script scores itself by leave-one-out on the titles that DO resolve: hide one
// title's true family, predict it from the rest of its board, compare. That produces an accuracy
// per (support, confidence) threshold, against the honest baseline of always guessing the corpus
// mode. If the board prior does not clearly beat that baseline, it is not worth having and this
// script says so rather than shipping the numbers anyway.
//
// READ THE ACCURACY NUMBER CORRECTLY, because it is easy to overclaim and we nearly did.
// Leave-one-out compares the prior's prediction against *the keyword classifier's own label*,
// which is not ground truth. So 91.2% is agreement with the classifier, not 91.2% correct. Where
// the classifier is systematically wrong about a board, the prior agrees with it confidently and
// scores full marks for doing so.
//
// The worked example, found by spot-check: `lever/jetsetpilates` is a Pilates studio. 168 of its
// 379 postings are titled `Instructor - <city>`, which the classifier reads as `education`
// (correctly, from the title alone — a bare "Instructor" is a teacher). The board therefore gets
// an `education` prior at 0.70 confidence and its 134 generic titles are assigned to education.
// Every one of those is wrong, and leave-one-out cannot see it: the truth labels are wrong the
// same way. The word "pilates" appears only in the board token, never in a title.
//
// That is the honest ceiling on this method: it propagates whatever the resolved titles say, so
// it inherits and then amplifies the base classifier's blind spots. The fix is a different signal
// — the board token is public metadata we already ship and is exactly what a human reads — and it
// is deliberately not attempted here, because a token-based classifier needs its own
// false-positive audit before it is trusted.
//
// Reads data/role-census-titles.json — the cached run-2 corpus. No network, $0.00.
//
//   node scripts/board-prior.mjs

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { explain } from './role-census.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = resolve(ROOT, 'data/role-census-titles.json')
const OUT = resolve(ROOT, 'data/board-prior.json')
const CSV = resolve(ROOT, 'docs/data/board-roles.csv')

// Families a board prior may predict. Excluded, deliberately:
//   suspect_recruitment_ad, volunteer_unpaid — data-quality labels, not roles. A board that is
//     79% recruitment ads must not have its generic titles called "recruitment ads" by inference;
//     that filter is keyword-driven and audited, and inference has no business widening it.
//   unclassifiable_generic — the thing being predicted.
//   other — unmatched, i.e. the classifier's own failure. Predicting it resolves nothing.
//   non_english — a language, not a role. It would make a French board predict "French".
export const NOT_A_ROLE = new Set([
  'suspect_recruitment_ad', 'volunteer_unpaid', 'unclassifiable_generic', 'other', 'non_english',
])

export const isRole = (family) => !NOT_A_ROLE.has(family)

// A board too full of rows that are not jobs does not get a prior at all.
//
// Found by spot-checking, not by reasoning: `lever/globalelitecareers` is 79% recruitment ads,
// and its 97 generic titles are 97 copies of "Benefits Services Representative - Remote" — the
// same commission-only pitch, worded so it dodges the ad filter's phrase list. The board's
// remaining real-looking titles gave it a `corporate` prior at 0.78 confidence, so the prior
// would have taken junk the quality filter exists to catch and stamped a legitimate job family
// on it. Inference must not launder what measurement flagged.
export const MAX_NOT_JOB_SHARE = 0.10
export const junkShare = (families) => {
  let junk = 0
  for (const f of families) if (f === 'suspect_recruitment_ad' || f === 'volunteer_unpaid') junk++
  return families.length ? junk / families.length : 0
}

// Counts of role families among a board's resolved titles.
export const boardCounts = (families) => {
  const counts = new Map()
  for (const f of families) {
    if (!isRole(f)) continue
    counts.set(f, (counts.get(f) || 0) + 1)
  }
  return counts
}

// The prior itself. `omit` drops one observation, which is what makes leave-one-out possible
// without rebuilding the counts 121,050 times.
export const predict = (counts, omit = null) => {
  let top = null
  let topN = 0
  let total = 0
  for (const [family, raw] of counts) {
    const n = family === omit ? raw - 1 : raw
    if (n <= 0) continue
    total += n
    // Ties broken by name so the result is reproducible from the corpus alone.
    if (n > topN || (n === topN && top !== null && family < top)) { top = family; topN = n }
  }
  if (!top) return null
  return { family: top, support: total, confidence: total ? topN / total : 0 }
}

const main = async () => {
  const boards = JSON.parse(await readFile(CACHE, 'utf8'))

  // Pass 1: classify everything once, keep per-board family lists and the firing key.
  const perBoard = []
  const corpusRoleCounts = new Map()
  let titlesRead = 0
  for (const b of boards) {
    const families = []
    const weak = []          // titles decided by a single-word key — the ambiguity proxy, below
    for (const title of b.titles) {
      const { family, key } = explain(title)
      families.push(family)
      weak.push(Boolean(key) && !key.trim().includes(' '))
      titlesRead++
      if (isRole(family)) corpusRoleCounts.set(family, (corpusRoleCounts.get(family) || 0) + 1)
    }
    perBoard.push({
      provider: b.p, token: b.t, stratum: b.s, titles: b.titles, families, weak,
      counts: boardCounts(families), junk: junkShare(families),
    })
  }

  // The baseline any prior has to beat: always guess the corpus mode.
  const baselineFamily = [...corpusRoleCounts.entries()].sort((a, z) => z[1] - a[1])[0][0]
  const roleTitles = [...corpusRoleCounts.values()].reduce((s, n) => s + n, 0)
  const baselineAccuracy = corpusRoleCounts.get(baselineFamily) / roleTitles

  // Pass 2: leave-one-out over every resolved title, at every threshold pair.
  const SUPPORTS = [1, 3, 5, 10, 20, 50]
  const CONFIDENCES = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
  const grid = new Map()      // "support|confidence" -> {hit, seen, hitWeak, seenWeak}
  const cell = (s, c) => {
    const k = `${s}|${c}`
    if (!grid.has(k)) grid.set(k, { support: s, confidence: c, hit: 0, seen: 0, hit_weak: 0, seen_weak: 0 })
    return grid.get(k)
  }

  for (const board of perBoard) {
    // Junk boards get no prior, so they must not count toward the accuracy either — otherwise
    // the published number describes a board set the prior is not actually used on.
    if (board.junk >= MAX_NOT_JOB_SHARE) continue
    for (let i = 0; i < board.families.length; i++) {
      const truth = board.families[i]
      if (!isRole(truth)) continue
      const p = predict(board.counts, truth)
      if (!p) continue
      const correct = p.family === truth
      for (const s of SUPPORTS) {
        if (p.support < s) continue
        for (const c of CONFIDENCES) {
          if (p.confidence < c) continue
          const cl = cell(s, c)
          cl.seen++
          if (correct) cl.hit++
          if (board.weak[i]) { cl.seen_weak++; if (correct) cl.hit_weak++ }
        }
      }
    }
  }

  // What each threshold would actually buy, which is not the same as its coverage of resolved
  // titles: the generic titles are not spread evenly over boards. A threshold can accept 40% of
  // resolved titles and still resolve almost no generic ones, if the boards it accepts are the
  // single-purpose boards that had few generic titles to begin with.
  const genericAt = (s, c) => {
    let n = 0
    for (const board of perBoard) {
      if (board.junk >= MAX_NOT_JOB_SHARE) continue
      const p = predict(board.counts)
      if (!p || p.support < s || p.confidence < c) continue
      for (const f of board.families) if (f === 'unclassifiable_generic') n++
    }
    return n
  }
  const genericTotal = perBoard.reduce(
    (s, b) => s + b.families.filter((f) => f === 'unclassifiable_generic').length, 0)

  const sweep = [...grid.values()].map((c) => ({
    min_support: c.support,
    min_confidence: c.confidence,
    // Coverage is what share of resolved titles a threshold would have accepted a prediction for.
    // A threshold that is accurate on 2% of titles resolves nothing.
    coverage: +(c.seen / roleTitles).toFixed(4),
    accuracy: c.seen ? +(c.hit / c.seen).toFixed(4) : 0,
    // Same score restricted to titles a single-word key decided — "engineer", "manager",
    // "technician". These are the weakly-identified titles, the closest thing in the resolved
    // set to the generic ones we actually want to predict, so this number generalises better
    // than the headline accuracy does.
    accuracy_weak_titles: c.seen_weak ? +(c.hit_weak / c.seen_weak).toFixed(4) : 0,
    n_scored: c.seen,
    n_scored_weak: c.seen_weak,
    // The number the decision actually turns on: how many of the 11,319 generic titles this
    // threshold would assign a family to.
    generic_assigned: genericAt(c.support, c.confidence),
    generic_share: +(genericAt(c.support, c.confidence) / genericTotal).toFixed(4),
  })).sort((a, z) => a.min_support - z.min_support || a.min_confidence - z.min_confidence)

  // Chosen operating point.
  //
  // The rule was originally "cheapest thresholds beating the baseline by 20 points, then maximum
  // coverage". Run against the real sweep it selected support>=1 / confidence>=0 — 62.8%
  // accurate, covering everything. That clears the baseline three times over and is still the
  // wrong answer: it mislabels more than a third of the rows it touches, and on a published
  // artifact a confident wrong label is worse than a blank one. The rule is accuracy-first
  // instead, and the whole sweep ships in the output so anyone can pick a different point.
  //
  // Stated plainly, because it is a real methodological weakness: the threshold is chosen by
  // looking at the same corpus it is scored on. The sweep is monotone and wide, not a search for
  // a lucky cell, but the accuracy at the chosen point is an in-sample number.
  const MIN_ACCURACY = 0.90
  const MIN_SUPPORT = 5      // a board with fewer than five resolved titles is not evidence
  const eligible = sweep.filter((r) =>
    r.accuracy_weak_titles >= MIN_ACCURACY && r.min_support >= MIN_SUPPORT && r.n_scored_weak >= 500)
  const chosen = eligible.sort((a, z) => z.coverage - a.coverage || a.min_support - z.min_support)[0] ?? null

  // Pass 3: apply it. Raw counts and stratum-weighted counts both, because the two differ by a
  // factor we have already published wrong once.
  const applied = { raw: new Map(), by_family_from: new Map() }
  let resolved = 0
  let leftGeneric = 0
  const boardRows = []
  for (const board of perBoard) {
    const p = predict(board.counts)
    const clean = board.junk < MAX_NOT_JOB_SHARE
    const usable = clean && chosen && p &&
      p.support >= chosen.min_support && p.confidence >= chosen.min_confidence
    let generic = 0
    for (const f of board.families) if (f === 'unclassifiable_generic') generic++
    if (usable && generic) {
      resolved += generic
      applied.raw.set(p.family, (applied.raw.get(p.family) || 0) + generic)
    } else {
      leftGeneric += generic
    }
    boardRows.push({
      provider: board.provider,
      token: board.token,
      titles_read: board.families.length,
      resolved_titles: p ? p.support : 0,
      inferred_family: usable ? p.family : '',
      confidence: p ? +p.confidence.toFixed(3) : 0,
      generic_titles: generic,
      generic_assigned: usable ? generic : 0,
      not_job_share: +board.junk.toFixed(3),
      stratum: board.stratum,
    })
  }

  const result = {
    generated_at: new Date().toISOString(),
    source: 'data/role-census-titles.json (cached run-2 corpus, no network)',
    corpus: {
      boards: perBoard.length,
      titles_read: titlesRead,
      resolved_role_titles: roleTitles,
      generic_titles: perBoard.reduce((s, b) => s + b.families.filter((f) => f === 'unclassifiable_generic').length, 0),
    },
    baseline: {
      rule: 'always predict the corpus mode',
      family: baselineFamily,
      accuracy: +baselineAccuracy.toFixed(4),
    },
    method: {
      validation: 'leave-one-out over resolved titles: hide one title, predict its family from the rest of its board',
      caveat: 'resolved titles are not a random sample of generic ones; accuracy_weak_titles is the closer proxy',
      caveat_accuracy_is_agreement: 'leave-one-out truth is the keyword classifier\'s own label, not ground truth, so accuracy measures agreement with the classifier; where the classifier is systematically wrong about a board the prior agrees with it confidently (worked example: lever/jetsetpilates, a Pilates studio whose 168 bare "Instructor" titles read as education)',
      selection_rule: `accuracy on weakly-identified titles >= ${MIN_ACCURACY}, min_support >= ${MIN_SUPPORT}, scored on >= 500 such titles, then max coverage`,
      selection_caveat: 'the threshold is chosen on the same corpus it is scored on, so the accuracy at the chosen point is in-sample; the full sweep is published so a different point can be taken',
    },
    sweep,
    chosen,
    applied: chosen
      ? {
        generic_assigned: resolved,
        generic_left_unresolved: leftGeneric,
        share_of_generic_resolved: +(resolved / (resolved + leftGeneric)).toFixed(4),
        into: Object.fromEntries([...applied.raw.entries()].sort((a, z) => z[1] - a[1])),
      }
      : null,
    boards_with_prior: boardRows.filter((r) => r.inferred_family).length,
    boards_refused_as_junk: perBoard.filter((b) => b.junk >= MAX_NOT_JOB_SHARE)
      .map((b) => ({ board: `${b.provider}/${b.token}`, not_job_share: +b.junk.toFixed(3) }))
      .sort((a, z) => z.not_job_share - a.not_job_share),
  }
  await writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`)

  // Public artifact: every measured board with the role family its own postings imply. Ranking
  // boards by size and knowing what a board is *for* are different questions, and the second one
  // is the one a buyer picking boards actually has.
  const header = 'provider,token,titles_read,resolved_titles,inferred_family,confidence,generic_titles,generic_assigned,not_job_share,stratum'
  boardRows.sort((a, z) => z.titles_read - a.titles_read)
  await writeFile(CSV, `${[header, ...boardRows.map((r) => Object.values(r).join(','))].join('\n')}\n`)

  process.stdout.write(`baseline: always "${baselineFamily}" -> ${(100 * baselineAccuracy).toFixed(1)}% on ${roleTitles.toLocaleString()} resolved titles\n\n`)
  process.stdout.write('support  conf   coverage  accuracy  acc(weak)   generic resolved\n')
  for (const r of sweep) {
    if (r.min_support !== MIN_SUPPORT) continue    // the support axis changes nothing; see below
    process.stdout.write(
      `${String(r.min_support).padStart(7)}  ${r.min_confidence.toFixed(2)}  ` +
      `${(100 * r.coverage).toFixed(1).padStart(7)}%  ${(100 * r.accuracy).toFixed(1).padStart(7)}%  ` +
      `${(100 * r.accuracy_weak_titles).toFixed(1).padStart(8)}%   ${String(r.generic_assigned).padStart(6)} ` +
      `(${(100 * r.generic_share).toFixed(1).padStart(5)}%)\n`,
    )
  }
  if (!chosen) {
    process.stdout.write('\nNo threshold clears the baseline by the required margin. The board prior is not usable.\n')
    return
  }
  process.stdout.write(`\nchosen: support >= ${chosen.min_support}, confidence >= ${chosen.min_confidence} ` +
    `(accuracy ${(100 * chosen.accuracy).toFixed(1)}%, weak-title accuracy ${(100 * chosen.accuracy_weak_titles).toFixed(1)}%)\n`)
  process.stdout.write(`assigned ${resolved.toLocaleString()} of ${(resolved + leftGeneric).toLocaleString()} generic titles ` +
    `(${(100 * resolved / (resolved + leftGeneric)).toFixed(1)}%), ${leftGeneric.toLocaleString()} stay unresolved\n`)
  for (const [fam, n] of [...applied.raw.entries()].sort((a, z) => z[1] - a[1])) {
    process.stdout.write(`  ${fam.padEnd(24)} +${String(n).padStart(6)}\n`)
  }
  process.stdout.write(`\nwrote ${OUT}\nwrote ${CSV} (${boardRows.length} boards, ${result.boards_with_prior} with a usable prior)\n`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
