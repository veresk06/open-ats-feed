#!/usr/bin/env node
// Check a candidate vendor accent before it goes into site.css.
//
// The vendor accents are used two ways: as text (.v-<vendor>) on the card and field
// grounds, and as a 0.7rem tick or bar where only hue survives. So a candidate has to
// clear two independent bars — WCAG AA (4.5:1) as text, and enough hue separation from
// every accent already in use, plus from --mark, which means "you can act on this".
//
// Usage: node scripts/check-accent.mjs '#7d3c8c' '#6e7a1c'

const EXISTING = {
  mark: '#b4482e',
  greenhouse: '#2f6f52',
  ashby: '#5b4b9e',
  lever: '#1e6e8c',
  breezy: '#8d3c63',
}
const GROUNDS = { field: '#e4ebee', card: '#f5f8f9' }

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)

const lum = (hex) => {
  const [r, g, b] = rgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const hue = (hex) => {
  const [r, g, b] = rgb(hex)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

const arc = (a, b) => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

let bad = 0
for (const cand of process.argv.slice(2)) {
  console.log(`\n${cand}  hue ${hue(cand).toFixed(0)}°  relative luminance ${lum(cand).toFixed(3)}`)
  for (const [name, g] of Object.entries(GROUNDS)) {
    const c = contrast(cand, g)
    const ok = c >= 4.5
    if (!ok) bad++
    console.log(`  as text on --${name}: ${c.toFixed(2)}:1 ${ok ? 'AA pass' : 'AA FAIL'}`)
  }
  for (const [name, hex] of Object.entries(EXISTING)) {
    const sep = arc(hue(cand), hue(hex))
    // 30° is the floor at which two dots of the same size and lightness stay
    // tellable apart; below that they read as a rendering difference.
    const ok = sep >= 30
    if (!ok) bad++
    console.log(`  vs --${name} (${hex}): ${sep.toFixed(0)}° apart ${ok ? '' : '<-- TOO CLOSE'}`)
  }
}
process.exit(bad ? 1 : 0)
