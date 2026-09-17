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
  // `best` is a wpm per word count, keyed by the count itself rather than by
  // its index, so reordering WORD_COUNTS later cannot silently reassign
  // somebody's records to the wrong mode.
  return { caret: 0, words: 1, palette: 0, best: {} }   // underline, 25 words, default
}

// Clamp a loaded config so a hand-edited or stale file cannot put the UI into
// an index that no longer exists.
function sanitize(cfg) {
  var out = defaults()
  if (!cfg || typeof cfg !== "object") return out
  if (cfg.best && typeof cfg.best === "object") {
    for (var wi = 0; wi < WORD_COUNTS.length; wi++) {
      var key = String(WORD_COUNTS[wi])
      var score = Number(cfg.best[key])
      // Finite and positive only: a corrupt or hand-edited file must not be
      // able to park an unbeatable record in the way.
      if (isFinite(score) && score > 0) out.best[key] = Math.round(score)
    }
  }
  for (var i = 0; i < OPTIONS.length; i++) {
    var opt = OPTIONS[i]
    var v = parseInt(cfg[opt.key])
    if (!isNaN(v) && v >= 0 && v < opt.values.length) out[opt.key] = v
  }
  return out
}

function wordCount(cfg) { return WORD_COUNTS[cfg.words] }

// Best wpm recorded for the mode this config is set to, or 0 for none yet.
function best(cfg) {
  var v = cfg.best ? cfg.best[String(wordCount(cfg))] : 0
  return isFinite(v) && v > 0 ? v : 0
}

// Record `wpm` if it beats the mode's stored best. Returns true when it did,
// which is what the run's record animation keys off. A failed run never
// records: its wpm is the speed reached before the mistake, not a result.
function recordBest(cfg, wpm, failed) {
  if (failed) return false
  var score = Math.round(Number(wpm))
  if (!isFinite(score) || score <= 0) return false
  var key = String(wordCount(cfg))
  var prev = cfg.best ? cfg.best[key] : 0
  if (isFinite(prev) && prev >= score) return false
  if (!cfg.best) cfg.best = {}
  cfg.best[key] = score
  return true
}
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
