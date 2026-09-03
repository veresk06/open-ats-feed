// A robots.txt evaluator, RFC 9309.
//
// Written because Cycle 38 discovered that the question "may we fetch this path?" was
// being answered by eye, on a live host, once. Both halves of that were wrong: eyeballing
// misses group selection, and a live-only check misses a rule that existed until the
// vendor's last site migration. This module does the first half; robots-archive-audit.mjs
// does the second.

// Groups are consecutive user-agent lines followed by rules. A rule line that appears
// before any user-agent line belongs to no group and is ignored, per the RFC.
export function parseRobots(text) {
  const groups = []
  let current = null
  let expectingAgents = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()

    if (field === 'user-agent') {
      if (!expectingAgents || !current) {
        current = { agents: [], rules: [] }
        groups.push(current)
        expectingAgents = true
      }
      current.agents.push(value.toLowerCase())
      continue
    }
    if (field !== 'allow' && field !== 'disallow') continue
    if (!current) continue
    expectingAgents = false
    current.rules.push({ type: field, path: value })
  }
  return groups
}

// The group governing `productToken`. A specific match beats `*`; among specific
// matches the longest agent string wins. No match at all means no group applies.
export function groupFor(groups, productToken) {
  const ua = productToken.toLowerCase()
  let best = null
  let bestLen = -1
  let star = null

  for (const group of groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        star ??= group
        continue
      }
      // RFC 9309: the record value matches if it is a prefix of the product token.
      if (ua.startsWith(agent) && agent.length > bestLen) {
        best = group
        bestLen = agent.length
      }
    }
  }
  return best ?? star ?? null
}

// `*` matches any run of characters; a trailing `$` anchors the end.
function patternMatches(pattern, path) {
  if (pattern === '') return false
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const parts = body.split('*')

  let pos = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i === 0) {
      if (!path.startsWith(part)) return false
      pos = part.length
      continue
    }
    if (part === '') continue
    const at = path.indexOf(part, pos)
    if (at === -1) return false
    pos = at + part.length
  }
  if (!anchored) return true
  // With a trailing `$` the final literal must land exactly on the end of the path.
  const tail = parts[parts.length - 1]
  return parts.length === 1 ? path === body : path.endsWith(tail) && pos === path.length
}

// Longest matching rule wins; Allow wins a tie. No rule matching means allowed, and so
// does an empty Disallow value, which is the RFC's explicit "everything is permitted".
export function isAllowed(text, pathWithQuery, productToken) {
  const groups = parseRobots(text)
  const group = groupFor(groups, productToken)
  if (!group) return { allowed: true, reason: 'no group applies', rule: null }

  let winner = null
  for (const rule of group.rules) {
    if (rule.type === 'disallow' && rule.path === '') continue
    if (!patternMatches(rule.path, pathWithQuery)) continue
    if (
      !winner ||
      rule.path.length > winner.path.length ||
      (rule.path.length === winner.path.length && rule.type === 'allow')
    ) {
      winner = rule
    }
  }
  if (!winner) {
    return {
      allowed: true,
      reason: `no rule in the [${group.agents.join(', ')}] group matches`,
      rule: null,
    }
  }
  return {
    allowed: winner.type === 'allow',
    reason: `${winner.type}: ${winner.path} in the [${group.agents.join(', ')}] group`,
    rule: winner,
  }
}
