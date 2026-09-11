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
