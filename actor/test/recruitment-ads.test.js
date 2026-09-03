import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isRecruitmentAd } from '../src/recruitment-ads.js'

// The titles below are verbatim from the corpus, not invented — every one of them was read off
// a live Greenhouse, Ashby or Lever board on 2026-09-03. A filter that runs by default has to
// be pinned against real input, in both directions.

test('flags the commission-only recruitment copy actually found in the corpus', () => {
  for (const title of [
    'Tired of Your Income Being Capped? Work from Home Opportunity',
    'Work From Home - Benefits Services Representative',
    'Work From Home - Break Free of the 9-5',
    'Stop Building Someone Else’s Dream',
    'Take Back Control of Your Time',
  ]) {
    assert.equal(isRecruitmentAd({ title }), true, title)
  }
})

test('leaves real postings alone, including remote and entry-level ones', () => {
  for (const title of [
    'Senior Software Engineer, Core Infrastructure',
    'Registered Nurse - Remote Opportunity',
    'Warehouse Associate - No Experience Necessary',
    'Customer Success Manager (Remote, US)',
    'Personal Trainer',
  ]) {
    assert.equal(isRecruitmentAd({ title }), false, title)
  }
})

test('survives the rows that break naive string matching', () => {
  assert.equal(isRecruitmentAd({}), false)
  assert.equal(isRecruitmentAd({ title: null }), false)
  assert.equal(isRecruitmentAd({ title: '' }), false)
  // Punctuation and casing are normalised the same way the census normalises them, so a title
  // that only differs by an em dash or a capital still matches.
  assert.equal(isRecruitmentAd({ title: 'WORK  FROM—HOME — Client Benefits Advisor' }), true)
})
