# Hiring digests

A dated series, one issue per date, measured from the live public job APIs of Greenhouse, Ashby and Lever. Each issue is two files: a `.md` written for a person and a `.json` carrying every number in it. Nothing is projected, estimated or back-filled, and no issue is edited after it is committed — a correction goes in the next one, where you can see it.

| Issue | Boards read | Open postings | Opened in 7 days | Ramping | Data |
|---|---:|---:|---:|---:|---|
| [2026-09-05](./2026-09-05.md) | 650 | 174,541 | 21,239 | 324 | [json](./2026-09-05.json) |
| [2026-09-03](./2026-09-03.md) | 650 | 155,490 | 15,751 | 339 | [json](./2026-09-03.json) |

## Why there is more than one

A single issue counts postings that are **open**. That is enough to see hiring start and structurally unable to see hiring stop: a role filled last week is not on the board to be counted. Every ramp figure in a single issue is therefore an upper bound, and each issue says so in its own body rather than in a footnote.

Two issues subtract. From the second one onward each carries a **What changed** section computed from the two JSON files and from nothing else, so a reader can reproduce it without trusting either document and without a network call:

```
node scripts/diff-digests.mjs digests/<earlier>.json digests/<later>.json
```

That section is the only thing here a competitor starting today cannot reproduce, because it needs a yesterday. It is also where the honest ambiguity lives: a posting that disappeared was filled, cancelled or expired, and the board does not say which. The diff reports increases and decreases separately and calls both lower bounds, because they are computed per board — a company that opened three roles and closed three in the same interval contributes zero to each.

## Reproducing an issue

Each issue prints the exact command that produced it. The sample is deterministic — the N largest boards per provider in the order of the committed company index — so the same command on the same index reads the same boards, which is what makes two dates comparable at all. Re-running it on a later date will not reproduce the numbers, because the boards will have changed; that is the point.

Two runs 12 minutes apart over the same 650 boards differed by 6 postings out of 155,490 — 0.004%. The instrument contributes essentially nothing to a day-over-day delta, so what a diff shows is the market moving, not the measurement wobbling.

The same classifier runs over the whole index as an Apify Actor: [open-ats-jobs-feed](https://apify.com/sharp_malachite/open-ats-jobs-feed), `outputMode: "signals"`.
