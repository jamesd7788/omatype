// Unit suite for the three logic modules. Run it with `test/run`.
//
// The QML layer is not covered here — it needs a live compositor — but every
// rule that decides whether a run passes or fails lives in these files.

import * as Engine from './Engine.mjs'
import * as Settings from './Settings.mjs'
import * as Palette from './Palette.mjs'
import { readFileSync } from 'node:fs'

let passed = 0
const failures = []
const ok = (name, cond) => cond ? passed++ : failures.push(name)
const eq = (name, got, want) =>
  ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
     JSON.stringify(got) === JSON.stringify(want))

// ---------------------------------------------------------------- engine

{
  const s = Engine.create("ab cd")
  eq("create: ready", s.phase, Engine.STATE.READY)
  eq("create: nothing typed", s.typed, "")
  eq("create: clock not started", Engine.elapsedMs(s, 9999), 0)
  eq("create: empty target is idle", Engine.create("").phase, Engine.STATE.IDLE)
}

{ // a clean run
  const s = Engine.create("ab cd")
  let t = 1000
  for (const ch of "ab cd") { Engine.press(s, ch, t); t += 100 }
  eq("run: done", s.phase, Engine.STATE.DONE)
  eq("run: typed all", s.typed, "ab cd")
  eq("run: words", Engine.wordsTyped(s), 2)
  eq("run: counts every keystroke", s.keystrokes, 5)
}

{ // master rule: the first wrong character ends it
  const s = Engine.create("abc")
  Engine.press(s, "a", 0)
  Engine.press(s, "x", 500)
  eq("master: failed", s.phase, Engine.STATE.FAILED)
  eq("master: typed frozen at the good prefix", s.typed, "a")
  eq("master: fatal key counted", s.keystrokes, 2)
  Engine.press(s, "b", 600)
  eq("master: input after failure ignored", s.typed, "a")
  eq("master: keystrokes frozen too", s.keystrokes, 2)
}

{ // a mistyped space fails like any other character
  const s = Engine.create("ab cd")
  for (const ch of "ab") Engine.press(s, ch, 0)
  Engine.press(s, "c", 0)
  eq("master: wrong space fails", s.phase, Engine.STATE.FAILED)
}

{ // the clock starts on the first keystroke, not when the words are dealt
  const s = Engine.create("ab")
  Engine.press(s, "a", 5000)
  eq("clock: running", s.phase, Engine.STATE.RUNNING)
  eq("clock: measured from the first key", Engine.elapsedMs(s, 6000), 1000)
}

{ // regression: a zero-origin clock is a real start, not "never started".
  // Guarding on `startedAt !== 0` instead of the `started` flag broke this.
  const s = Engine.create("abcde")
  Engine.press(s, "a", 0)
  let t = 0
  for (const ch of "bcde") { t += 15000; Engine.press(s, ch, t) }
  eq("clock: zero origin elapses", Engine.elapsedMs(s), 60000)
  eq("wpm: 5 chars in 60s is 1", Engine.wpm(s), 1)
  eq("raw: 5 keystrokes in 60s is 1", Engine.raw(s), 1)
}

{ // raw counts the fatal keystroke; wpm counts only correct characters
  const s = Engine.create("abcdefghij")
  Engine.press(s, "a", 0)
  for (const [i, ch] of [..."bcde"].entries()) Engine.press(s, ch, (i + 1) * 12000)
  Engine.press(s, "Z", 60000)
  eq("failed: wpm counts correct only", Engine.wpm(s), 1)
  eq("failed: raw counts the fatal key", Engine.raw(s), 1.2)
}

{ // a word counts once its trailing space lands, or at the end of the run
  const s = Engine.create("aa bb cc")
  eq("words: none yet", Engine.wordsTyped(s), 0)
  for (const ch of "aa") Engine.press(s, ch, 0)
  eq("words: uncommitted word does not count", Engine.wordsTyped(s), 0)
  Engine.press(s, " ", 0)
  eq("words: committed by its space", Engine.wordsTyped(s), 1)
  for (const ch of "bb cc") Engine.press(s, ch, 0)
  eq("words: final word counts on completion", Engine.wordsTyped(s), 3)
}

{ // non-characters are not input
  const s = Engine.create("ab")
  Engine.press(s, "ab", 0)
  Engine.press(s, "", 0)
  Engine.press(s, undefined, 0)
  eq("press: ignores non-single-char", s.typed, "")
}

{ // formatting
  const done = Engine.create("ab")
  Engine.press(done, "a", 0); Engine.press(done, "b", 1000)
  ok("format: full line", /wpm · \d+ raw · \d+ words · [\d.]+s/.test(
    Engine.formatSummary(Engine.summary(done))))
  const failed = Engine.create("ab")
  Engine.press(failed, "z", 0)
  ok("format: failure is named, not glyphed",
     Engine.formatSummary(Engine.summary(failed)).startsWith("failed"))
  ok("format: no glyph", !/[✗✘×]/.test(Engine.formatSummary(Engine.summary(failed))))
  ok("format: failure omits word count",
    !/words/.test(Engine.formatSummary(Engine.summary(failed))))
}

// -------------------------------------------------------------- settings

{
  const d = Settings.defaults()
  eq("defaults: underline caret", Settings.CARETS[d.caret], "underline")
  eq("defaults: 25 words", Settings.wordCount(d), 25)
  eq("defaults: default palette", Settings.palette(d).name, "default")
}

{ // cycling wraps in both directions
  const c = Settings.defaults()
  Settings.cycle(c, "words", 1)
  eq("cycle: 25 -> 40", Settings.wordCount(c), 40)
  Settings.cycle(c, "words", 1)
  eq("cycle: wraps to 10", Settings.wordCount(c), 10)
  Settings.cycle(c, "words", -1)
  eq("cycle: wraps back to 40", Settings.wordCount(c), 40)
  const c2 = Settings.defaults()
  Settings.cycle(c2, "caret", -1)
  eq("cycle: negative wrap", c2.caret, Settings.CARETS.length - 1)
  Settings.cycle(c2, "nonexistent", 1)
  ok("cycle: unknown key is a no-op", true)
}

{ // a stale or hand-edited file must not put the UI out of range
  eq("sanitize: clamps junk", Settings.wordCount(Settings.sanitize({ words: 99, caret: -3 })), 25)
  eq("sanitize: null", Settings.sanitize(null).caret, 0)
  eq("sanitize: keeps valid values", Settings.sanitize({ words: 2 }).words, 2)
  eq("sanitize: ignores unknown keys", Settings.sanitize({ nope: 1 }).words, 1)
  // The option keys are indexes into a value list; `best` is a score map,
  // range-checked with the high-score cases above.
  for (const opt of Settings.OPTIONS) {
    const v = Settings.sanitize({ [opt.key]: 999 })[opt.key]
    ok(`sanitize: ${opt.key} stays in range`, v >= 0 && v < opt.values.length)
  }
}

{
  eq("options: three rows", Settings.OPTIONS.length, 3)
  eq("labels: reads the current value", Settings.valueLabel(Settings.defaults(), "words"), "25")
  for (const opt of Settings.OPTIONS)
    ok(`options: ${opt.key} has values`, Array.isArray(opt.values) && opt.values.length > 0)
}

{ // high scores: one per word count, beaten only by a better finished run
  const cfg = Settings.defaults()
  eq("best: none to start", Settings.best(cfg), 0)

  ok("record: first result sets it", Settings.recordBest(cfg, 62, false))
  eq("record: stored", Settings.best(cfg), 62)

  ok("record: a slower run does not", !Settings.recordBest(cfg, 61, false))
  eq("record: previous best kept", Settings.best(cfg), 62)
  ok("record: an equal run does not", !Settings.recordBest(cfg, 62, false))
  ok("record: a faster run does", Settings.recordBest(cfg, 63, false))
  eq("record: updated", Settings.best(cfg), 63)

  // A failed run reports the speed reached before the mistake. That is not a
  // result and must never take the record, however fast it was.
  ok("record: a failed run never counts", !Settings.recordBest(cfg, 200, true))
  eq("record: untouched by failure", Settings.best(cfg), 63)

  // Records are per word count and must not leak between modes.
  Settings.cycle(cfg, "words", 1)
  eq("record: other mode starts empty", Settings.best(cfg), 0)
  Settings.recordBest(cfg, 40, false)
  eq("record: stored for this mode", Settings.best(cfg), 40)
  Settings.cycle(cfg, "words", -1)
  eq("record: original mode intact", Settings.best(cfg), 63)

  ok("record: rejects nonsense", !Settings.recordBest(cfg, NaN, false))
  ok("record: rejects zero", !Settings.recordBest(cfg, 0, false))
  ok("record: rejects negative", !Settings.recordBest(cfg, -5, false))

  // Keyed by the word count itself, so reordering WORD_COUNTS cannot
  // reassign somebody's records to the wrong mode.
  ok("record: keyed by count not index", Object.keys(cfg.best).includes("25"))

  // Survives a save/load round trip, and a corrupt file cannot inject one.
  const loaded = Settings.sanitize(JSON.parse(JSON.stringify(cfg)))
  eq("record: survives a round trip", Settings.best(loaded), 63)
  eq("record: junk best is dropped",
     Settings.best(Settings.sanitize({ words: 1, best: { "25": "fast" } })), 0)
  eq("record: negative best is dropped",
     Settings.best(Settings.sanitize({ words: 1, best: { "25": -9 } })), 0)
}

// --------------------------------------------------------------- palette

{
  eq("parse: hex is not eaten as a comment", Palette.parse('accent = "#123456"').accent, "#123456")
  eq("parse: trailing comment stripped", Palette.parse('accent = "#123456" # hi').accent, "#123456")
  eq("parse: blank input", Object.keys(Palette.parse("")).length, 0)
  eq("parse: junk input", Object.keys(Palette.parse("nonsense\n[section]\n")).length, 0)
}

{ // every variant must be readable on every installed theme — the whole
  // point of measuring rather than naming roles
  const { readdirSync, existsSync } = await import("node:fs")
  const dirs = ["/usr/share/omarchy/themes", `${process.env.HOME}/.config/omarchy/themes`]
  const themes = []
  for (const d of dirs) {
    try {
      for (const t of readdirSync(d))
        if (existsSync(`${d}/${t}/colors.toml`)) themes.push([t, `${d}/${t}/colors.toml`])
    } catch {}
  }
  ok("themes: found some to check", themes.length > 0)

  for (const [name, file] of themes) {
    const colors = Palette.parse(readFileSync(file, "utf8"))
    const bg = Palette.role(colors, "background") || "#000000"
    for (const p of Settings.PALETTES) {
      const r = Palette.resolve(colors, p.variant, name)
      // Typed is body text and must clear WCAG AA.
      ok(`${name}/${p.name}: typed readable`, Palette.contrast(r.typed, bg) >= 4.5)
      // Pending is read ahead into — below ~2.4:1 it vanishes into the field.
      ok(`${name}/${p.name}: pending visible`, Palette.contrast(r.pending, bg) >= 2.4)
      ok(`${name}/${p.name}: caret visible`, Palette.contrast(r.caret, bg) >= 3.0)
      // The typed/pending boundary is the only cursor the test has. `default`
      // separates by brightness; `vivid` deliberately keeps both halves fully
      // readable and separates by hue instead, which a contrast ratio scores
      // as identical — so the check is perceptual, not luminance alone.
      ok(`${name}/${p.name}: typed distinguishable from pending`,
         Palette.distinguishable(r.typed, r.pending))
    }
  }
}

{ // vivid's promise: untyped words at full foreground strength, brighter
  // than any other variant. Enforced per theme because the earlier version
  // quietly degraded to `default` wherever the accent could not carry text.
  const { readdirSync, existsSync } = await import("node:fs")
  const dirs = ["/usr/share/omarchy/themes", `${process.env.HOME}/.config/omarchy/themes`]
  const themes = []
  for (const d of dirs) {
    try {
      for (const t of readdirSync(d))
        if (existsSync(`${d}/${t}/colors.toml`)) themes.push([t, `${d}/${t}/colors.toml`])
    } catch {}
  }
  for (const [name, file] of themes) {
    const colors = Palette.parse(readFileSync(file, "utf8"))
    const bg = Palette.role(colors, "background")
    const fg = Palette.role(colors, "foreground")
    const vivid = Palette.resolve(colors, "vivid", name)
    const dflt = Palette.resolve(colors, "default", name)
    eq(`${name}: vivid pending is the theme foreground`,
       vivid.pending.toLowerCase(), fg.toLowerCase())
    ok(`${name}: vivid pending outshines default`,
       Palette.contrast(vivid.pending, bg) > Palette.contrast(dflt.pending, bg))
    ok(`${name}: vivid is not just default`,
       vivid.typed.toLowerCase() !== dflt.typed.toLowerCase() ||
       vivid.pending.toLowerCase() !== dflt.pending.toLowerCase())
  }
}

{ // random varies by seed but is stable for one
  const colors = Palette.parse(readFileSync(
    "/usr/share/omarchy/themes/tokyo-night/colors.toml", "utf8"))
  const a = Palette.resolve(colors, "random", "seed-a")
  const b = Palette.resolve(colors, "random", "seed-a")
  eq("random: same seed is stable", [a.typed, a.caret], [b.typed, b.caret])
  const combos = new Set()
  for (let i = 0; i < 12; i++) {
    const r = Palette.resolve(colors, "random", `seed-${i}`)
    combos.add(r.typed + r.caret)
  }
  ok("random: seeds give different draws", combos.size >= 4)
}

{ // contrast maths
  eq("contrast: black on white", Math.round(Palette.contrast("#ffffff", "#000000")), 21)
  eq("contrast: identical", Palette.contrast("#7aa2f7", "#7aa2f7"), 1)
}

{ // a threadbare theme must still render through the fallback chains
  const bare = Palette.parse('foreground = "#ffffff"\nbackground = "#000000"\n')
  eq("fallback: missing role falls back", Palette.role(bare, "bright_foreground"), "#ffffff")
  eq("fallback: unknown role is empty", Palette.role(bare, "nonsense"), "")
  eq("fallback: absent role is empty", Palette.role(bare, "cyan"), "")
}

// ------------------------------------------------------------- word list

{
  const words = JSON.parse(readFileSync(new URL("./english.json", import.meta.url)))
  const list = words.words ?? words
  ok("words: list is a non-empty array", Array.isArray(list) && list.length > 0)
  ok("words: every entry is a non-empty string",
     list.every(w => typeof w === "string" && w.length > 0))
  ok("words: no entry contains a space", list.every(w => !w.includes(" ")))
  // No capitals: the list is typed as a burst with no shift reaches, and "I"
  // (the only capitalised word in the source list) is deliberately removed.
  ok("words: nothing capitalised", list.every(w => w === w.toLowerCase()))
  ok("words: no bare I", !list.includes("I"))
}

{ // perceptual distance: the check that lets vivid keep both halves readable
  eq("deltaE: identical is zero", Math.round(Palette.deltaE("#7aa2f7", "#7aa2f7")), 0)
  ok("deltaE: blue vs lavender is visible", Palette.deltaE("#7aa2f7", "#a9b1d6") >= 18)
  ok("distinguishable: same colour is not", !Palette.distinguishable("#dcd7ba", "#dcd7ba"))
  ok("distinguishable: hue-only pair is", Palette.distinguishable("#7aa2f7", "#a9b1d6"))
  ok("distinguishable: brightness-only pair is",
     Palette.distinguishable("#ffffff", "#555555"))
}

// ----------------------------------------------------------------- report

for (const f of failures) console.log(`FAIL  ${f}`)
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
