.pragma library

// Typing engine for the bar test. Pure functions over a plain state object —
// no QML types in here, so the same file runs under node for tests.
//
// Master rules: the first wrong character ends the run. There is no
// backspace, no correction, and therefore no per-character error state to
// carry: `typed` is always a correct prefix of `target`.

var STATE = {
  IDLE: "idle",
  READY: "ready",     // words drawn, clock not started
  RUNNING: "running", // first key landed
  DONE: "done",
  FAILED: "failed"
}

function create(target) {
  return {
    phase: target ? STATE.READY : STATE.IDLE,
    target: target || "",
    typed: "",
    started: false,
    ended: false,
    startedAt: 0,
    endedAt: 0,
    keystrokes: 0   // every accepted key, including the fatal one
  }
}

// Feed one character. Returns the state (mutated in place) so callers can
// chain or just re-read. `now` is milliseconds; the caller owns the clock so
// tests can drive it deterministically.
function press(state, ch, now) {
  if (state.phase !== STATE.READY && state.phase !== STATE.RUNNING) return state
  if (typeof ch !== "string" || ch.length !== 1) return state

  if (state.phase === STATE.READY) {
    state.phase = STATE.RUNNING
    state.started = true
    state.startedAt = now
  }

  state.keystrokes++
  var expected = state.target.charAt(state.typed.length)

  if (ch !== expected) {
    state.phase = STATE.FAILED
    state.ended = true
    state.endedAt = now
    return state
  }

  state.typed += ch
  if (state.typed.length === state.target.length) {
    state.phase = STATE.DONE
    state.ended = true
    state.endedAt = now
  }
  return state
}

function elapsedMs(state, now) {
  // `started` rather than `startedAt !== 0`: a caller driving the clock from a
  // zero origin (tests, or a monotonic timer) has a legitimate start of 0.
  if (!state.started) return 0
  var end = state.ended ? state.endedAt : (now === undefined ? state.startedAt : now)
  return Math.max(0, end - state.startedAt)
}

// Standard typing-test WPM: a "word" is five characters, correct ones only.
function wpm(state, now) {
  var ms = elapsedMs(state, now)
  if (ms <= 0) return 0
  return (state.typed.length / 5) / (ms / 60000)
}

// Raw counts every keystroke the user made, including the one that killed a
// failed run — the speed they were actually moving at.
function raw(state, now) {
  var ms = elapsedMs(state, now)
  if (ms <= 0) return 0
  return (state.keystrokes / 5) / (ms / 60000)
}

// Whole words fully committed. A word counts once its trailing space is typed,
// or, for the final word, once the run completes.
function wordsTyped(state) {
  if (state.typed.length === 0) return 0
  if (state.typed.length === state.target.length) {
    return state.target.split(" ").length
  }
  var committed = state.typed.lastIndexOf(" ")
  return committed === -1 ? 0 : state.typed.slice(0, committed).split(" ").length
}

function summary(state, now) {
  var seconds = elapsedMs(state, now) / 1000
  return {
    failed: state.phase === STATE.FAILED,
    wpm: Math.round(wpm(state, now)),
    raw: Math.round(raw(state, now)),
    words: wordsTyped(state),
    seconds: seconds
  }
}

function formatSummary(s) {
  var secs = s.seconds.toFixed(1) + "s"
  // A failed run reports the speed it reached and says so in words. The line
  // is already drawn in the theme's urgent colour; a glyph on top of that is
  // one signal too many.
  if (s.failed) return "failed · " + s.wpm + " wpm · " + secs
  return s.wpm + " wpm · " + s.raw + " raw · " + s.words + " words · " + secs
}
