// The role classifier is a keyword list where **order is the algorithm**: first match wins, so
// every family added to the middle of the list silently re-decides every title the families
// below it used to own. Run 4 added three families and 60 keys, and the audit
// (`node scripts/audit-classifier.mjs <family>`) deleted five of them for firing on the wrong
// jobs entirely.
//
// These tests freeze what that audit established. Each one is a decision that was measured
// against the corpus rather than reasoned about, and each is the kind of thing a later keyword
// addition would break without failing anything else.

import test from 'node:test'
import assert from 'node:assert/strict'
import { classify, explain } from '../scripts/role-census.mjs'

test('AI gig work is taken out of the job families it was hiding in', () => {
  // 3,567 postings were being counted as real openings on real teams. The engineering ones are
  // the reason this family exists at all: `engineering` is the number this repo quotes publicly,
  // and "AI Trainer - Electrical Engineers" is piecework for a model vendor, not a team opening.
  assert.equal(classify('AI Trainer - Electrical Engineers, CAD, Python expertise (Remote)'), 'ai_gig_work')
  assert.equal(classify('Accountants - AI Training - Albuquerque, US'), 'ai_gig_work')
  assert.equal(classify('AI Tutor - Bulgarian'), 'ai_gig_work')
  // ...and it must not swallow the staff jobs that build the same systems. `data annotation` and
  // `data labeling` were dropped from the family precisely because they did.
  assert.equal(classify('Technical Program Manager, Human Data Annotation (Code)'), 'engineering')
  assert.notEqual(classify('General Manager, AI Data Labeling'), 'ai_gig_work')
})

test('the classifier reads NHS as well as it reads American', () => {
  // One board carried 832 UK clinical postings and every one landed in `other`, because the
  // list had `nurse` and `physician` and no Agenda for Change pay band.
  assert.equal(classify('Band 7/8a Locum Invasive Cardiac Physiologist - Woolwich'), 'healthcare')
  assert.equal(classify('Band 6 General Radiographer - Liverpool'), 'healthcare')
  assert.equal(classify('Consultant Haematologist - Chelmsford'), 'healthcare')
  assert.equal(classify('ACCIDENT & EMERGENCY - GRIMSBY'), 'healthcare')
  // American vocabulary the list also never had: specialty physicians named by specialty.
  assert.equal(classify('Endocrinologist - IMLC License | Flexible 1099 Remote'), 'healthcare')
  assert.equal(classify('Board Certified Behavior Analyst (BCBA)'), 'healthcare')
})

test('`radiographer` is clinical; radiography is also a way to inspect a weld', () => {
  // The key started life as `radiograph` and was narrowed on audit. Industrial non-destructive
  // examination uses the same word and is not a healthcare job.
  assert.equal(classify('Breast Radiographer - London'), 'healthcare')
  assert.notEqual(classify('Sr. NDE Engineer, Radiography Testing'), 'healthcare')
})

test('selling to hospitals is a sales job', () => {
  // `hospice` was dropped for exactly this: healthcare is ordered ahead of sales_marketing, so
  // every commercial role at a hospice provider would have been counted as clinical headcount —
  // inflating the family this run exists to correct.
  assert.equal(classify('Account Executive, Hospice'), 'sales_marketing')
  // Not sales — `client services` is a support key, and that is the right answer. The claim
  // under test is only that the word "hospice" does not make a commercial role clinical.
  assert.equal(classify('Client Services Manager, Hospice'), 'support')
})

test('an insurance producer does not produce media', () => {
  // The bare `producer` key fired 323 times and 201 of them were this title on one agency board.
  // It was deleted; "we cannot say what kind of producer" is the honest answer and `other` is
  // where honest answers live.
  assert.notEqual(classify('Insurance Producer - Abilene, TX'), 'media_production')
  assert.notEqual(classify('Associate Director, Post Production & Quality Operations'), 'media_production')
  // The qualified titles survive.
  assert.equal(classify('Multiskilled Journalist'), 'media_production')
  assert.equal(classify('Senior Video Editor and Motion Designer'), 'media_production')
})

test('events beats media, and trades beat events', () => {
  // Ordering, stated as a test because ordering is the only thing that makes these three
  // families disjoint. A conference producer is an events job; a conference room is a building.
  assert.equal(classify('Event Producer'), 'events')
  assert.equal(classify('Conference Producer'), 'events')
  assert.equal(classify('Conference Room AV Technician'), 'skilled_trades')
})

test('the legal cluster reaches the family that already had `paralegal`', () => {
  assert.equal(classify('Trial Attorney'), 'corporate')
  assert.equal(classify('Hmong Document Reviewer'), 'corporate')
  assert.equal(classify('Director of eDiscovery'), 'corporate')
})

test('non-English keys must be written the way the normaliser leaves them', () => {
  // The normaliser folds every non-alphanumeric character to a space, so `indépendant` reaches
  // the matcher as `ind pendant` and `réceptionniste` as `r ceptionniste`. A key written with
  // the accent in it can never fire, and would fail silently rather than loudly.
  assert.equal(explain('Commercial(e) Terrain Indépendant(e)').key, 'ind pendant')
  assert.equal(classify('Agent(e) Réceptionniste - Lobe ( Laval )'), 'non_english')
  assert.equal(classify('Técnico de Inspeção - Macaé/RJ'), 'non_english')
})

test('run 4 moved nobody who was already correctly placed', () => {
  // The cheapest possible regression net over the families that carry the headline numbers.
  assert.equal(classify('Senior Software Engineer'), 'engineering')
  assert.equal(classify('Registered Nurse - ICU'), 'healthcare')
  assert.equal(classify('CDL Class A Driver'), 'logistics')
  assert.equal(classify('Work From Home - Be Your Own Boss'), 'suspect_recruitment_ad')
  assert.equal(classify('Hospice Volunteer (Unpaid)'), 'volunteer_unpaid')
})
