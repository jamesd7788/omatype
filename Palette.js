.pragma library

// Resolves role names against the active Omarchy theme's colors.toml.
//
// The shell's Color singleton only exposes five roles (foreground, background,
// accent, urgent, muted), but a theme's colors.toml carries the full palette —
// bright_foreground, selection, cyan, orange and the rest — which is what the
// palette presets remap between. So the file is parsed directly.

// Minimal TOML reader: this file is flat `key = "#rrggbb"` lines with comments
// and a `mode` string. Nothing here needs a real TOML parser.
function parse(text) {
  var out = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    // Match the quoted value first and let anything after it be a comment.
    // Stripping on a bare `#` would cut into "#78824b" and drop every colour.
    var m = lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// Fallback chains: a theme that omits a role still resolves to something
// sensible rather than rendering an invalid colour.
var CHAINS = {
  foreground:        ["foreground", "light_foreground", "bright_foreground"],
  bright_foreground: ["bright_foreground", "light_foreground", "foreground"],
  light_foreground:  ["light_foreground", "foreground", "bright_foreground"],
  dark_foreground:   ["dark_foreground", "muted", "selection"],
  muted:             ["muted", "dark_foreground", "selection"],
  selection:         ["selection", "muted", "dark_foreground"],
  accent:            ["accent", "blue", "cyan", "foreground"],
  cyan:              ["cyan", "bright_cyan", "blue", "accent"],
  blue:              ["blue", "bright_blue", "accent"],
  green:             ["green", "bright_green", "accent"],
  orange:            ["orange", "yellow", "bright_yellow", "accent"],
  yellow:            ["yellow", "bright_yellow", "orange", "accent"],
  magenta:           ["magenta", "bright_magenta", "accent"],
  red:               ["red", "bright_red", "urgent"],
  background:        ["background", "dark_background"]
}

// Resolve one role to a hex string, or "" when nothing in the chain exists.
function role(colors, name) {
  var chain = CHAINS[name] || [name]
  for (var i = 0; i < chain.length; i++) {
    var v = colors[chain[i]]
    if (typeof v === "string" && v.match(/^#[0-9a-fA-F]{3,8}$/)) return v
  }
  return ""
}

// ------------------------------------------------------------- contrast
//
// Presets used to name palette roles directly ("warm" meant cyan + orange).
// That reads well and does not survive contact with real themes: a theme
// assigns ANSI slots for terminal compatibility, not by hue, so `cyan` is
// pink in rose-pine and grey in matte-black, and `green` is amber. Worse,
// `muted` and `selection` are background-adjacent in most themes, which put
// the pending text at 1.3:1 against the field — invisible, and pending text
// is the half you actually read ahead into.
//
// So colours are chosen by measurement instead: WCAG relative luminance,
// picking from whatever the theme actually contains to hit a contrast band.

function _srgb(c) {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance(hex) {
  var h = String(hex || "").replace("#", "")
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (h.length < 6) return 0
  var r = parseInt(h.substr(0, 2), 16) / 255
  var g = parseInt(h.substr(2, 2), 16) / 255
  var b = parseInt(h.substr(4, 2), 16) / 255
  return 0.2126 * _srgb(r) + 0.7152 * _srgb(g) + 0.0722 * _srgb(b)
}

// WCAG contrast ratio, 1:1 (identical) to 21:1 (black on white).
function contrast(a, b) {
  var la = luminance(a), lb = luminance(b)
  var hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

function isHex(v) {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)
}

// Every distinct colour the theme defines, minus the backgrounds — the pool
// any variant is allowed to draw from.
function swatches(colors) {
  var skip = { background: 1, dark_background: 1, darker_background: 1, lighter_background: 1, mode: 1 }
  var seen = {}, out = []
  for (var k in colors) {
    if (skip[k] || !isHex(colors[k])) continue
    var v = colors[k].toLowerCase()
    if (seen[v]) continue
    seen[v] = 1
    out.push({ name: k, hex: colors[k] })
  }
  return out
}

// Mix toward a target — used only to rescue a theme too monochrome to supply
// a readable pending colour from its own palette.
function mix(a, b, t) {
  var pa = String(a).replace("#", ""), pb = String(b).replace("#", "")
  var out = "#"
  for (var i = 0; i < 3; i++) {
    var ca = parseInt(pa.substr(i * 2, 2), 16)
    var cb = parseInt(pb.substr(i * 2, 2), 16)
    var v = Math.round(ca + (cb - ca) * t)
    out += ("0" + Math.max(0, Math.min(255, v)).toString(16)).slice(-2)
  }
  return out
}

// Pick the swatch whose contrast against `bg` sits closest to `target`,
// staying inside [min,max] where possible. `exclude` keeps the three slots
// from collapsing onto the same colour.
function pickByContrast(pool, bg, target, min, max, exclude) {
  var best = null, bestScore = Infinity
  for (var i = 0; i < pool.length; i++) {
    var hex = pool[i].hex
    if (exclude && exclude.indexOf(hex.toLowerCase()) !== -1) continue
    var c = contrast(hex, bg)
    if (c < min || c > max) continue
    var score = Math.abs(c - target)
    if (score < bestScore) { bestScore = score; best = hex }
  }
  return best
}

// ---------------------------------------------------------- the variants
//
// Contrast bands, against the field background. Typed text is what you have
// already cleared, pending is what you are reading ahead into: pending has to
// sit clearly below typed so the boundary reads as a position, while staying
// well clear of the background so the words are still legible.
var TYPED_MIN = 4.5      // WCAG AA for body text
var PENDING_MIN = 2.4    // measured floor: below this the words disappear
var PENDING_MAX = 4.5    // above this it stops reading as "not yet typed"
var CARET_MIN = 3.0

// Deterministic 32-bit hash → the Random variant is stable for a given theme
// and seed rather than flickering on every repaint.
function hash(str) {
  var h = 2166136261
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h >>> 0
}

// Resolve a variant to { typed, pending, caret } hex values.
//
//   default  the original: foreground, a dimmed pending, accent caret
//   vivid    typed in the theme's primary (accent), pending in high-contrast text
//   random   picked from the theme's own palette, seeded, always readable
//
function resolve(colors, variant, seed) {
  var bg = role(colors, "background") || "#000000"
  var fg = role(colors, "foreground") || "#ffffff"
  var accent = role(colors, "accent") || fg
  var pool = swatches(colors)

  // A pending colour in band, else mixed from foreground toward background
  // until it lands there — themes too monochrome to offer one are common.
  function pendingFor(exclude) {
    var p = pickByContrast(pool, bg, 3.2, PENDING_MIN, PENDING_MAX, exclude)
    if (p) return p
    for (var t = 0.35; t <= 0.85; t += 0.05) {
      var m = mix(fg, bg, t)
      var c = contrast(m, bg)
      if (c >= PENDING_MIN && c <= PENDING_MAX) return m
    }
    return mix(fg, bg, 0.55)
  }

  // Pending must sit clearly below `typed`, not merely inside the band: on a
  // light theme both can land at similar luminance and the boundary between
  // typed and untyped — which is the only cursor the test has — disappears.
  function separatedPending(typed, exclude) {
    var need = 1.45
    var best = null, bestSep = 0
    for (var i = 0; i < pool.length; i++) {
      var hex = pool[i].hex
      if (exclude && exclude.indexOf(hex.toLowerCase()) !== -1) continue
      var cb = contrast(hex, bg)
      if (cb < PENDING_MIN || cb > PENDING_MAX) continue
      var sep = contrast(typed, hex)
      if (sep > bestSep) { bestSep = sep; best = hex }
    }
    if (best && bestSep >= need) return best
    // Nothing in the palette separates enough: walk the typed colour toward
    // the background until it does.
    for (var t = 0.30; t <= 0.90; t += 0.05) {
      var m = mix(typed, bg, t)
      if (contrast(m, bg) >= PENDING_MIN && contrast(typed, m) >= need) return m
    }
    return best || mix(typed, bg, 0.55)
  }

  if (variant === "vivid") {
    // Typed in the theme's primary — but only if the accent can actually
    // carry body text. Plenty of themes use a pastel or muted accent that
    // looks right on an icon and is unreadable as a line of words.
    var vTyped = contrast(accent, bg) >= TYPED_MIN ? accent : fg
    var vPending = separatedPending(vTyped, [vTyped.toLowerCase()])
    // High-contrast text for the caret so the position is unmistakable.
    var bright = role(colors, "bright_foreground") || fg
    var vCaret = contrast(bright, bg) >= contrast(fg, bg) ? bright : fg
    return { typed: vTyped, pending: vPending, caret: vCaret }
  }

  if (variant === "random") {
    var h = hash(String(seed || "") + "|" + bg + "|" + pool.length)
    // Typed: any swatch that clears AA, chosen by the seed.
    var strong = []
    for (var i = 0; i < pool.length; i++) {
      if (contrast(pool[i].hex, bg) >= TYPED_MIN) strong.push(pool[i].hex)
    }
    if (strong.length === 0) strong = [fg]
    var rTyped = strong[h % strong.length]

    // Caret: a different swatch with real presence, else the accent.
    var carets = []
    for (var j = 0; j < pool.length; j++) {
      var ch = pool[j].hex
      if (ch.toLowerCase() === rTyped.toLowerCase()) continue
      if (contrast(ch, bg) >= CARET_MIN) carets.push(ch)
    }
    var rCaret = carets.length ? carets[(h >>> 8) % carets.length] : accent

    // Pending is never randomised across the band — it is the one slot where
    // a bad draw makes the test unreadable, so it is always measured.
    var rPending = separatedPending(rTyped, [rTyped.toLowerCase(), rCaret.toLowerCase()])
    return { typed: rTyped, pending: rPending, caret: rCaret }
  }

  // default
  return {
    typed: fg,
    pending: separatedPending(fg, [fg.toLowerCase()]),
    caret: contrast(accent, bg) >= CARET_MIN ? accent : fg
  }
}
