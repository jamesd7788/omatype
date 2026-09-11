.pragma library

// Settings model for the config strip: the option list, the values each
// option cycles through, and how a choice resolves to a colour role.
//
// Colour choices are stored as ROLE NAMES ("accent", "muted"), never as hex.
// The role is looked up in the active theme's colors.toml at paint time, so a
// preset picked under one theme keeps working when the theme changes — which
// is the whole point of remapping within the theme rather than choosing
// colours outright.

var CARETS = ["underline", "outline", "accent block", "soft tint", "invert"]

// Ordered so the default lands first; `wordCounts` are what the test deals.
var WORD_COUNTS = [10, 25, 40]

// Palette variants. These are resolved by measurement in Palette.js rather
// than by naming theme roles: a theme assigns ANSI slots for terminal
// compatibility, not by hue, so a preset built from "cyan" and "orange" is
// pink-on-cream in one theme and grey in another.
//
//   default  the theme's foreground, a measured dim for pending, accent caret
//   vivid    typed in the theme's primary, pending in high-contrast text
//   random   drawn from the theme's own palette, reseeded each test, always
//            inside the readable contrast band
var PALETTES = [
  { name: "default", variant: "default" },
  { name: "vivid",   variant: "vivid" },
  { name: "random",  variant: "random" }
]

// The config strip's rows, in h/l order.
var OPTIONS = [
  { key: "caret",   label: "caret",   values: CARETS },
  { key: "words",   label: "words",   values: WORD_COUNTS },
  { key: "palette", label: "palette", values: PALETTES.map(function (p) { return p.name }) }
]

function defaults() {
  return { caret: 0, words: 1, palette: 0 }   // underline, 25 words, default
}

// Clamp a loaded config so a hand-edited or stale file cannot put the UI into
// an index that no longer exists.
function sanitize(cfg) {
  var out = defaults()
  if (!cfg || typeof cfg !== "object") return out
  for (var i = 0; i < OPTIONS.length; i++) {
    var opt = OPTIONS[i]
    var v = parseInt(cfg[opt.key])
    if (!isNaN(v) && v >= 0 && v < opt.values.length) out[opt.key] = v
  }
  return out
}

function wordCount(cfg) { return WORD_COUNTS[cfg.words] }
function palette(cfg)   { return PALETTES[cfg.palette] }
function caretStyle(cfg){ return cfg.caret }

// Step an option's value, wrapping in both directions.
function cycle(cfg, key, delta) {
  for (var i = 0; i < OPTIONS.length; i++) {
    if (OPTIONS[i].key !== key) continue
    var n = OPTIONS[i].values.length
    cfg[key] = ((cfg[key] + delta) % n + n) % n
    return cfg
  }
  return cfg
}

function valueLabel(cfg, key) {
  for (var i = 0; i < OPTIONS.length; i++) {
    if (OPTIONS[i].key === key) return String(OPTIONS[i].values[cfg[key]])
  }
  return ""
}
