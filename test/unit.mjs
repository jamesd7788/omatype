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
  ok("format: failure is marked", Engine.formatSummary(Engine.summary(failed)).startsWith("✗"))
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
  for (const key of Object.keys(Settings.defaults())) {
    const v = Settings.sanitize({ [key]: 999 })[key]
    ok(`sanitize: ${key} stays in range`, v >= 0)
  }
}

{
  eq("options: three rows", Settings.OPTIONS.length, 3)
  eq("labels: reads the current value", Settings.valueLabel(Settings.defaults(), "words"), "25")
  for (const opt of Settings.OPTIONS)
    ok(`options: ${opt.key} has values`, Array.isArray(opt.values) && opt.values.length > 0)
}

// --------------------------------------------------------------- palette

{
  eq("parse: hex is not eaten as a comment", Palette.parse('accent = "#123456"').accent, "#123456")
  eq("parse: trailing comment stripped", Palette.parse('accent = "#123456" # hi').accent, "#123456")
  eq("parse: blank input", Object.keys(Palette.parse("")).length, 0)
  eq("parse: junk input", Object.keys(Palette.parse("nonsense\n[section]\n")).length, 0)
}

{ // every preset must resolve against a real theme, and stay readable
  const home = process.env.HOME
  let colors
  try {
    colors = Palette.parse(readFileSync(
      `${home}/.local/state/omarchy/current/theme/colors.toml`, "utf8"))
  } catch {
    colors = Palette.parse(`
      foreground = "#c2c2b0"\nbright_foreground = "#ffffff"\nlight_foreground = "#8a8a7e"
      dark_foreground = "#555555"\nmuted = "#666666"\nselection = "#383838"
      background = "#222222"\naccent = "#78824b"\ncyan = "#c9a554"\nblue = "#78824b"
      green = "#5f875f"\norange = "#8d6242"\n`)
  }
  ok("theme: palette parsed", Object.keys(colors).length > 8)

  for (const p of Settings.PALETTES) {
    for (const slot of ["typed", "pending", "caret"]) {
      ok(`${p.name}.${slot} (${p[slot]}) resolves`,
         /^#[0-9a-f]{3,8}$/i.test(Palette.role(colors, p[slot])))
    }
    // If typed and pending resolved the same, the test would be unreadable —
    // you could not see how far you had got.
    ok(`${p.name}: typed differs from pending`,
       Palette.role(colors, p.typed).toLowerCase() !==
       Palette.role(colors, p.pending).toLowerCase())
  }
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
}

// ----------------------------------------------------------------- report

for (const f of failures) console.log(`FAIL  ${f}`)
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
