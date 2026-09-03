import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyToken, blocked, stripSuffixes, titleFamily, TOKEN_KEYS } from '../scripts/board-token.mjs'

test('a substring in a token is not a fact about a company', () => {
  // Every one of these is a real board token from the roster, and every one of them contains an
  // industry word by accident. This is the whole reason the classifier has blockers at all.
  assert.equal(classifyToken('spacex').family, null, 'spacex is not a spa')
  assert.equal(classifyToken('squarespace').family, null)
  assert.equal(classifyToken('instacart').family, null, 'instacart is not an art company')
  assert.equal(classifyToken('westernveterinarypartnersllc').family, 'healthcare', 'but partners does not disqualify a real vet')
  assert.equal(classifyToken('oneacrefundmalawi').family, null, 'malawi is not a law firm')
  assert.equal(classifyToken('delawaretitleloansinc').family, null, 'delaware is not a law firm')
  // `svetness` is the single largest board in the corpus (4,981 postings) and it is a tutoring
  // staffing agency. A naive `vet` substring would have made it a veterinary practice.
  assert.equal(classifyToken('svetness').family, null, 'svetness contains vet and is not a vet')
  assert.equal(classifyToken('fivetran').family, null)
  assert.equal(classifyToken('resolvetosavelives').family, null)
})

test('careers is the dominant care collision and the blocker removes it', () => {
  // 109 of the 185 roster tokens containing `care` contain it only inside `careers`.
  for (const t of ['plscareers', 'allcareers', 'zyngacareers', 'nflcareers', 'la28careers']) {
    assert.equal(classifyToken(t).family, null, `${t} is a careers page, not a care provider`)
  }
  // What survives is real.
  for (const t of ['freedomcare', 'skilledwoundcare', 'pomelocare', 'wovencare']) {
    assert.equal(classifyToken(t).family, 'healthcare')
  }
  // `philzcoffeecareers` still classifies — on `coffee`, which is ordered before `care` fails.
  assert.equal(classifyToken('philzcoffeecareers').family, 'retail_food')
})

test('blocked() needs only one free occurrence of the key to let a match through', () => {
  assert.equal(blocked('plscareers', 'care', ['career']), true)
  assert.equal(blocked('freedomcare', 'care', ['career']), false)
  // A token carrying both — a care provider with a careers suffix — must still classify.
  assert.equal(blocked('freedomcarecareers', 'care', ['career']), false)
  assert.equal(blocked('anything', 'care', []), false, 'no blockers means nothing is blocked')
})

test('end-anchored keys strip corporate suffixes but stay anchored', () => {
  assert.equal(stripSuffixes('cityvetinc'), 'cityvet')
  assert.equal(stripSuffixes('bolingbrookvet'), 'bolingbrookvet')
  assert.equal(stripSuffixes('drwuniversityjobs'), 'drwuniversity')
  assert.equal(stripSuffixes('wellthy-care-network'), 'wellthycarenetwork', 'separators are removed first')
  for (const t of ['bondvet', 'cityvetinc', 'bolingbrookvet', 'lansingpetvet', 'chessielanevet']) {
    assert.equal(classifyToken(t).family, 'healthcare', t)
  }
  // Anchoring is what makes the key safe: `vet` anywhere else must not fire.
  assert.equal(classifyToken('truveta').family, null)
  assert.equal(classifyToken('avetta').family, null)
})

test('stripSuffixes cannot eat a whole token', () => {
  // Guard against the degenerate case: a token that IS a suffix must survive, or an end-anchored
  // key would match the empty string and fire on everything.
  assert.equal(stripSuffixes('careers'), 'careers')
  assert.equal(stripSuffixes('jobs'), 'jobs')
  assert.equal(stripSuffixes('inc'), 'inc')
  assert.notEqual(stripSuffixes('anyboard'), '')
})

test('first match wins, and the order puts the specific key first', () => {
  // `healthcare` is ordered ahead of the bare `health`, and `dental` ahead of `care`, so the
  // reported key names the most specific evidence rather than the first alphabetical one.
  assert.equal(classifyToken('missionhealthcare').key, 'healthcare')
  assert.equal(classifyToken('charliehealth').key, 'health')
  assert.equal(classifyToken('elitedentalpartnersllc').key, 'dental')
})

test('no key is shadowed by an earlier, broader key', () => {
  // Ordering is load-bearing and easy to break by appending. If a broad key precedes a specific
  // one that contains it, the specific key can never fire and its audited agreement is a lie.
  // A broad key is only genuinely shadowing when it does not block the narrow one — `care`
  // precedes `daycare` and is allowed to, because `daycare` is one of `care`'s blockers.
  const seen = []
  for (const [, key, mode] of TOKEN_KEYS) {
    if (mode === 'end') { seen.push([key, []]); continue }
    const shadow = seen.find(([prev, prevBlockers]) =>
      key.includes(prev) && !blocked(key, prev, prevBlockers))
    assert.equal(shadow, undefined,
      `"${key}" is shadowed by the earlier key "${shadow && shadow[0]}" and can never fire`)
    seen.push([key, TOKEN_KEYS.find((k) => k[1] === key)[3] || []])
  }
  // And the behaviour the ordering exists to produce.
  assert.equal(classifyToken('brightdaycare').family, 'education')
  assert.equal(classifyToken('brightdaycare').key, 'daycare')
})

test('titleFamily refuses junk boards rather than labelling them', () => {
  // Same guard as the Cycle-22 board prior: a board that is >=10% not-a-job gets no family, so
  // inference never launders what the quality filters flagged.
  const junk = Array.from({ length: 10 }, (_, i) => (i < 2 ? 'work from home opportunity' : 'Software Engineer'))
  assert.equal(titleFamily(junk).family, null)
  assert.equal(titleFamily(junk).reason, 'junk_board')
  assert.equal(titleFamily([]).family, null)
  assert.equal(titleFamily(['Manager', 'Associate', 'Lead']).reason, 'no_resolved_titles',
    'all-generic boards yield no yardstick, so they cannot be audited against')
})

test('titleFamily reports the modal role family, matching the board prior', () => {
  const t = titleFamily(['Registered Nurse', 'Nurse Practitioner', 'Software Engineer', 'Manager'])
  assert.equal(t.family, 'healthcare')
  assert.equal(t.support, 3)
})
