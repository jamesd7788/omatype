import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import "Engine.js" as Engine
import "Settings.js" as Settings
import "Palette.js" as Palette

// A typing test that wears the bar. Summoned over IPC, it maps a layer-shell
// strip the same height as the bar across the middle 80% of the screen edge,
// takes the keyboard, and hands it back when the run ends.
//
// Why a panel and not a bar widget: bar widgets live inside the bar's own
// layer surface, which is created with keyboardFocus None and is Omarchy-owned
// code we must not edit. A widget there can never see a keystroke. An overlay
// strip parked on the same edge looks identical and can take focus.
Item {
  id: root

  property bool opened: false

  // Fraction of the bar the test covers. The surviving slivers at each end
  // keep the real bar's outermost widgets visible, so it still reads as the
  // bar rather than an unrelated black bar.
  readonly property real coverage: 0.8

  // Padding inside the field, each side, that the fitted line must stay clear of.
  readonly property int fieldPadding: Style.space(10)
  // How long the results line stays up before the test dismisses itself.
  readonly property int resultDwellMs: 2000
  // An untouched test releases its keyboard grab after this long.
  readonly property int idleReleaseMs: 10000
  // How many times `deal` may re-post itself waiting for the strip to map.
  readonly property int maxDealRetries: 60
  property int dealRetries: 0
  // Unselected config options fade back to this, so one row reads as active.
  readonly property real configDimOpacity: 0.55
  // Caret style indices, in Settings.CARETS order.
  readonly property int caretUnderline: 0
  readonly property int caretOutline: 1
  readonly property int caretBlock: 2
  readonly property int caretTint: 3
  readonly property int caretInvert: 4

  readonly property int barSize: Style.bar.sizeHorizontal
  // Bar position is user config, not a style token, so it comes from
  // shell.json — the same file the bar itself reads. A vertical bar has no
  // room for a line of words, so the test still draws as a horizontal strip
  // on the top edge in that case.
  property string barPosition: "top"
  readonly property bool onBottom: barPosition === "bottom"

  FileView {
    path: Quickshell.env("HOME") + "/.config/omarchy/shell.json"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: {
      try {
        var cfg = JSON.parse(text())
        var pos = cfg && cfg.bar ? cfg.bar.position : "top"
        root.barPosition = (pos === "bottom") ? "bottom" : "top"
      } catch (e) {
        root.barPosition = "top"
      }
    }
  }

  readonly property color fg: Color.foreground
  readonly property color bg: Color.background
  readonly property color urgent: Color.urgent
  readonly property color dim: Qt.rgba(fg.r, fg.g, fg.b, 0.34)

  // Test length, caret style and palette all come from the saved config; see
  // Settings.js for the option lists. The line is still measured rather than
  // assumed, so a count that cannot fit the field stops early instead of
  // overrunning into the real bar's widgets.
  property var config: Settings.defaults()
  readonly property int wordCount: Settings.wordCount(config)
  readonly property int caretStyle: Settings.caretStyle(config)
  readonly property int fontPx: Style.font.body === undefined ? 12 : Style.font.body

  // Active theme palette, parsed from colors.toml. The shell's Color
  // singleton carries only five roles; the variants measure across the full set.
  property var themeColors: ({})
  readonly property var activePalette: Settings.palette(config)
  // Reseeded on every deal so `random` is a different draw each test, while
  // staying fixed for the length of a run — the colours must not shift under
  // you mid-line.
  property string paletteSeed: "0"
  readonly property var resolvedPalette:
    Palette.resolve(root.themeColors, activePalette.variant, root.paletteSeed)
  readonly property color typedColor:   resolvedPalette.typed   || root.fg
  readonly property color pendingColor: resolvedPalette.pending || root.dim
  readonly property color caretColor:   resolvedPalette.caret   || Color.accent

  property var state: Engine.create("")
  property var pool: []
  // Covers the race where the test is summoned before the word list finishes
  // loading: the panel is already up and waiting, so deal the moment it lands.
  onPoolChanged: if (opened && state.target.length === 0) deal()
  // Bumped on every state mutation. QML cannot see inside a plain JS object,
  // so the renderer binds to this counter to know when to repaint.
  property int revision: 0

  // The three strings the line is drawn from, recomputed once per mutation
  // rather than by three separate `revision, state.foo` comma-expression
  // bindings. Those worked, but each re-ran its own slice on every keystroke
  // and the dependency on `revision` was invisible to anyone reading them.
  // `revision` is listed first so the binding re-evaluates when it changes;
  // `state` is deliberately also read so a whole-state swap (a fresh deal)
  // repaints even if the counter were ever missed.
  readonly property string typedPart: (root.revision, root.state.typed)
  readonly property string pendingPart: (root.revision, root.state.target.slice(root.state.typed.length))
  readonly property string caretChar: (root.revision, root.state.target.charAt(root.state.typed.length))
  readonly property bool hasTarget: (root.revision, root.state.target.length > 0)
  readonly property bool runFailed: (root.revision, root.state.phase === Engine.STATE.FAILED)

  property string resultText: ""
  property bool showingResult: false

  // Config mode. `configRow` is the selected option (h/l), and j/k cycle that
  // option's value. Entering pauses nothing — the run is abandoned and a
  // fresh one is dealt on exit, since a paused clock would flatter the wpm.
  property bool configMode: false
  property int configRow: 0

  // Active theme palette.
  //
  // `omarchy theme set` does not rewrite the theme directory — it stages a new
  // one and then `rm -rf`s the old and `mv`s the replacement into place. So the
  // colors.toml a watcher is holding gets unlinked on the first switch and the
  // watch never fires again: the test would keep painting the palette it read
  // at startup while the bar around it had already recoloured.
  //
  // `current/theme.name` is rewritten in place and keeps its inode across every
  // switch, so it is the one reliable signal. Watch that, and re-read the
  // palette by path whenever it changes.
  FileView {
    id: themeNameFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme.name"
    watchChanges: true
    onFileChanged: reload()
    onLoaded: colorsFile.reload()
  }

  FileView {
    id: colorsFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    onLoaded: root.themeColors = Palette.parse(text())
  }

  // Saved config. Written on every change so a choice survives a shell
  // restart; `sanitize` clamps a stale or hand-edited file into range.
  FileView {
    id: configFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/type-config.json"
    watchChanges: false
    // Write through a temp file and rename, as the rest of the shell does, so
    // a crash mid-write cannot leave a truncated file that reads back as
    // corrupt on the next start.
    atomicWrites: true
    // First run has no file yet; defaults cover it, so don't log a read error.
    printErrors: false
    onLoaded: {
      try { root.config = Settings.sanitize(JSON.parse(text())) }
      catch (e) { root.config = Settings.defaults() }
    }
    onLoadFailed: root.config = Settings.defaults()
  }

  function saveConfig() {
    configFile.setText(JSON.stringify(root.config))
  }

  // ---------------------------------------------------------------- words

  FileView {
    path: Qt.resolvedUrl("english.json").toString().replace("file://", "")
    onLoaded: {
      try {
        var parsed = JSON.parse(text())
        var list = parsed && parsed.words ? parsed.words : parsed
        if (!Array.isArray(list)) return
        // Keep only non-empty strings. A stray null or number in the list
        // would reach TextMetrics and the Engine as a non-string and only
        // show up as a broken run much later.
        var clean = []
        for (var i = 0; i < list.length; i++)
          if (typeof list[i] === "string" && list[i].length > 0) clean.push(list[i])
        if (clean.length > 0) root.pool = clean
      } catch (e) {
        console.warn("io.github.jamesd7788.omatype: bad word list:", e)
      }
    }
  }

  // Measures the real rendered width of a string in the bar font, so the test
  // fills the strip exactly rather than guessing from an average glyph width.
  TextMetrics {
    id: metrics
    font.family: Style.fontFamily
    font.pixelSize: root.fontPx
  }

  // Build a line that actually fits `pixels`, measuring the real string as it
  // grows. Deriving a character count from an average glyph advance was wrong
  // in practice: `Style.fontFamily` is the alias "monospace", and the width
  // TextMetrics reports for it does not match what the Text item renders, so
  // the estimate ran ~30% long and the words overran the field. Measuring the
  // candidate itself is exact for any font, monospace or not.
  // Measuring each candidate whole was O(n^2) in both string building and
  // TextMetrics work: 40 words meant 40 layouts of an ever-longer line, and
  // 40 intermediate strings. Instead each word is measured once on its own
  // and the advances are summed — the bar font is monospace, so the sum is
  // exact. It is only ever an estimate for a proportional font, so the joined
  // line is measured once at the end and trimmed if the estimate ran long;
  // that keeps the "never overrun the field" guarantee for any font while
  // costing one extra layout instead of n.
  function fitLine(pool, pixels) {
    if (!pool || pool.length === 0 || pixels <= 0) return ""
    var words = []
    var used = 0
    var spaceWidth = root.measure(" ")
    for (var i = 0; i < root.wordCount; i++) {
      var word = root.randomWord(pool)
      var advance = root.measure(word) + (words.length === 0 ? 0 : spaceWidth)
      if (used + advance > pixels) break
      words.push(word)
      used += advance
    }
    // Nothing fit: fall back to a single word so the test is never empty.
    if (words.length === 0) return root.randomWord(pool)

    var line = words.join(" ")
    while (words.length > 1 && root.widthOf(line) > pixels) {
      words.pop()
      line = words.join(" ")
    }
    return line
  }

  function randomWord(pool) {
    return pool[Math.floor(Math.random() * pool.length)]
  }

  // Uncached measurement, for one-off strings.
  function widthOf(text) {
    metrics.text = text
    return metrics.width
  }

  // Width of one word, memoised. `fitLine` draws from the same fixed pool on
  // every run, so after the first test the per-word advances are all hits and
  // the only layout left is the single whole-line check. The key space is the
  // pool, so the cache is bounded by it.
  property var widthCache: ({})
  function measure(word) {
    var hit = root.widthCache[word]
    if (hit !== undefined) return hit
    var w = root.widthOf(word)
    root.widthCache[word] = w
    return w
  }
  // A font change invalidates every cached advance.
  onFontPxChanged: root.widthCache = ({})

  // ---------------------------------------------------------------- flow

  function open() {
    if (root.opened) return
    root.showingResult = false
    root.resultText = ""
    root.dealRetries = 0
    root.opened = true
    // Deferred: the strip has no width until the surface maps, and the word
    // count is measured off that width.
    Qt.callLater(root.deal)
  }

  function deal() {
    // Measure the field, not the strip: the strip spans the whole edge but
    // only the centre `coverage` fraction is the test surface. Measuring the
    // strip overruns the field and the words collide with the real bar
    // widgets showing through at each end.
    // The word list loads asynchronously, so the first summon after a shell
    // start can land before it arrives. Wait rather than dealing an empty
    // line; `onPoolChanged` deals as soon as the list is in.
    if (root.pool.length === 0) return
    var usable = field.width - (root.fieldPadding * 2)
    // The surface may not have mapped yet, so the field has no width to
    // measure against. Retry on the next tick — but bounded, because an
    // unconditional re-post is an infinite busy loop if the strip never maps
    // (a closed test, a missing output). `dealRetries` resets on every open.
    if (usable <= 0) {
      if (root.opened && root.dealRetries < root.maxDealRetries) {
        root.dealRetries++
        Qt.callLater(root.deal)
      }
      return
    }
    root.dealRetries = 0
    root.paletteSeed = String(Date.now()) + ":" + String(Math.random())
    root.state = Engine.create(root.fitLine(root.pool, usable))
    root.revision++
    idleGuard.restart()
  }

  function close() {
    root.opened = false
    root.showingResult = false
    // Leaving from the config strip must not leave the mode set, or the next
    // summon opens into settings instead of a test.
    root.configMode = false
    root.configRow = 0
    resultTimer.stop()
    idleGuard.stop()
  }

  function finish() {
    var summary = Engine.summary(root.state, Date.now())
    root.resultText = Engine.formatSummary(summary)
    root.showingResult = true
    idleGuard.stop()
    resultTimer.restart()
  }

  function enterConfig() {
    root.configMode = true
    root.showingResult = false
    resultTimer.stop()
    idleGuard.restart()
  }

  function exitConfig() {
    root.configMode = false
    root.deal()          // fresh test under the new settings
  }

  function configKey(event) {
    var k = event.key
    var opts = Settings.OPTIONS

    // esc, backspace and enter all leave the strip.
    if (k === Qt.Key_Escape || k === Qt.Key_Backspace
        || k === Qt.Key_Return || k === Qt.Key_Enter) { root.exitConfig(); return }

    // h/l (and left/right) move between options; j/k (up/down) change value.
    if (k === Qt.Key_H || k === Qt.Key_Left)  { root.configRow = (root.configRow - 1 + opts.length) % opts.length; return }
    if (k === Qt.Key_L || k === Qt.Key_Right) { root.configRow = (root.configRow + 1) % opts.length; return }

    var delta = 0
    if (k === Qt.Key_J || k === Qt.Key_Down) delta = 1
    else if (k === Qt.Key_K || k === Qt.Key_Up) delta = -1
    if (delta === 0) return

    // Reassigned rather than mutated: QML only re-evaluates the bindings that
    // read `config` when the property itself changes identity. `sanitize`
    // doubles as the copy — it builds a fresh object from known keys, so a
    // mutated clone can never alias the one the bindings are still holding.
    var next = Settings.sanitize(root.config)
    Settings.cycle(next, opts[root.configRow].key, delta)
    root.config = next
    root.saveConfig()
  }

  function handleKey(event) {
    // Any key is a sign of life, so the abandon timer goes back to full — but
    // not while the results line is up. There `finish` has deliberately
    // stopped the guard and handed the dismissal to `resultTimer`; restarting
    // it here revived a timer that was meant to stay dead. Harmless, since
    // `close` stops it again, but it meant a live 10s timer for every key
    // pressed at a finished run.
    if (!root.showingResult) idleGuard.restart()

    if (root.configMode) { root.configKey(event); return }

    if (event.key === Qt.Key_Escape) { root.close(); return }

    // Backspace opens settings. Master mode has no use for it as an edit key:
    // a wrong character has already ended the run, so it is free.
    if (event.key === Qt.Key_Backspace) { root.enterConfig(); return }

    // Tab restarts, mid-run or from the results line — the same key the web
    // app uses. It is the only way to start another run: during the results
    // window every other key is ignored so a stray keystroke cannot relaunch
    // a test you were done with.
    if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
      resultTimer.stop()
      root.showingResult = false
      root.deal()
      return
    }

    if (root.showingResult) return

    var ch = event.text
    if (!ch || ch.length !== 1) return
    // Control characters (ctrl+a arrives as \x01) are not test input.
    if (ch.charCodeAt(0) < 0x20) return

    Engine.press(root.state, ch, Date.now())
    root.revision++

    // `ended` is the engine's own "this run is over" flag, set for both DONE
    // and FAILED — checking the two phases separately duplicated a rule the
    // engine already owns.
    if (root.state.ended) root.finish()
  }

  Timer {
    id: resultTimer
    interval: root.resultDwellMs
    onTriggered: root.close()
  }

  // The test holds an exclusive keyboard grab. If a run is abandoned the grab
  // would otherwise outlive any way of reaching the shell to release it, so an
  // untouched test releases the keyboard on its own.
  Timer {
    id: idleGuard
    interval: root.idleReleaseMs
    onTriggered: root.close()
  }

  IpcHandler {
    target: "io.github.jamesd7788.omatype"
    function toggle(): string { root.opened ? root.close() : root.open(); return "ok" }
    function open(): string { root.open(); return "ok" }
    function close(): string { root.close(); return "ok" }
    function ping(): string { return "ok" }
  }

  // ---------------------------------------------------------------- surface

  PanelWindow {
    id: strip

    visible: root.opened
    color: "transparent"
    // The real bar keeps its own exclusion zone; this strip sits on top of it
    // and must not reserve a second one or the desktop would shift on summon.
    exclusionMode: ExclusionMode.Ignore

    WlrLayershell.namespace: "omarchy-type"
    // Above the bar (Top) so it covers it rather than hiding behind it.
    WlrLayershell.layer: WlrLayer.Overlay

    // Exclusive for the whole run, not the Exclusive-then-OnDemand settle the
    // shell's KeyboardPanel uses. That panel is a full-screen surface, so
    // OnDemand still finds the pointer inside it; this one is a 20px strip the
    // pointer is essentially never over, and under OnDemand the keystrokes go
    // to whatever window is underneath instead. Measured: with OnDemand not a
    // single key reached the test.
    //
    // Holding an exclusive grab is why close() must be reachable without the
    // keyboard cooperating: esc is handled first, the idle guard releases an
    // abandoned run, and a throwing key handler closes rather than stranding.
    WlrLayershell.keyboardFocus: root.opened
      ? WlrKeyboardFocus.Exclusive
      : WlrKeyboardFocus.None

    anchors {
      top: !root.onBottom
      bottom: root.onBottom
      left: true
      right: true
    }

    implicitHeight: root.barSize

    onVisibleChanged: {
      if (visible) Qt.callLater(function () {
        if (root.opened) keyCatcher.forceActiveFocus()
      })
    }

    // The covered span, computed once. The input mask and the painted field
    // must agree exactly — they were two copies of the same two expressions,
    // so a change to one could silently leave a strip that accepts clicks
    // where it paints nothing, or vice versa.
    readonly property int fieldX: Math.round(strip.width * (1 - root.coverage) / 2)
    readonly property int fieldWidth: Math.round(strip.width * root.coverage)

    // Only the middle 80% is opaque; the ends stay click-through so the bar
    // widgets there keep working while the test is up.
    mask: Region {
      x: strip.fieldX
      y: 0
      width: strip.fieldWidth
      height: strip.height
    }

    Rectangle {
      id: field
      x: strip.fieldX
      width: strip.fieldWidth
      height: strip.height
      color: root.bg
      // Belt and braces: if the fitted line ever overruns the field, it gets
      // cut at the edge rather than painted across the real bar's widgets.
      clip: true

      Item {
        id: keyCatcher
        anchors.fill: parent
        focus: true
        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function (event) {
          event.accepted = true
          // A throw inside the handler would leave the grab up with no way to
          // dismiss it, so failure closes the test rather than stranding it.
          try {
            root.handleKey(event)
          } catch (e) {
            console.warn("io.github.jamesd7788.omatype: key handler threw:", e)
            root.close()
          }
        }
      }

      // Result line. Replaces the words in place.
      Text {
        anchors.centerIn: parent
        visible: root.showingResult && !root.configMode
        text: root.resultText
        color: root.runFailed ? root.urgent : root.typedColor
        font.family: Style.fontFamily
        font.pixelSize: root.fontPx
      }

      // The test line: one Text per segment, laid out as a row, so the typed
      // prefix can carry a different colour without per-character items.
      Row {
        id: line
        anchors.centerIn: parent
        visible: !root.showingResult && !root.configMode
        spacing: 0

        Text {
          id: typedText
          text: root.typedPart
          color: root.typedColor
          font.family: Style.fontFamily
          font.pixelSize: root.fontPx
        }

        Text {
          text: root.pendingPart
          color: root.pendingColor
          font.family: Style.fontFamily
          font.pixelSize: root.fontPx
        }
      }

      // Caret variants. `invert` is the loudest and `tint` the quietest; the
      // glyph is redrawn only for the styles that need it in another colour.
      Rectangle {
        id: caret
        visible: !root.showingResult && !root.configMode && root.hasTarget
        width: caretMetrics.width / caretMetrics.text.length
        height: root.fontPx + Style.space(3)
        x: line.x + typedText.implicitWidth
        y: line.y + (line.height - height) / 2

        // Styles, in Settings.CARETS order.
        color: {
          if (root.caretStyle === root.caretBlock) return root.caretColor
          if (root.caretStyle === root.caretTint) return Qt.rgba(root.caretColor.r, root.caretColor.g, root.caretColor.b, 0.22)
          if (root.caretStyle === root.caretInvert) return root.typedColor
          return "transparent"
        }
        radius: root.caretStyle === root.caretBlock || root.caretStyle === root.caretTint ? 2 : 0

        border.width: root.caretStyle === root.caretOutline ? 1 : 0
        border.color: root.caretColor

        // Slide between cells rather than teleporting.
        Behavior on x { NumberAnimation { duration: 45; easing.type: Easing.OutCubic } }

        // Underline: a rule under the cell rather than a block over it.
        Rectangle {
          visible: root.caretStyle === root.caretUnderline
          anchors.bottom: parent.bottom
          anchors.horizontalCenter: parent.horizontalCenter
          width: parent.width
          height: Math.max(1, Math.round(root.fontPx / 8))
          color: root.caretColor
        }

        // The pending character. Styles that fill the cell need it repainted
        // in the background colour; the quiet styles leave the line's own
        // dim glyph showing through and draw nothing here.
        Text {
          anchors.centerIn: parent
          visible: root.caretStyle === root.caretBlock || root.caretStyle === root.caretInvert
          text: root.caretChar
          color: root.bg
          font.family: Style.fontFamily
          font.pixelSize: root.fontPx
        }
      }

      // Measures option labels so each value cell can be pinned to its widest
      // rendering. Shared by every row; `text` is set transiently during the
      // measurement loop and nothing binds to it.
      TextMetrics {
        id: cellMetrics
        font.family: Style.fontFamily
        font.pixelSize: root.fontPx
      }

      // Total width of the config strip at its widest, so it can be centred
      // once and then stay put.
      readonly property real configStripWidth: {
        var opts = Settings.OPTIONS
        var total = 0
        for (var i = 0; i < opts.length; i++) {
          cellMetrics.text = opts[i].label
          total += cellMetrics.width + Style.space(5)
          var widest = 0
          for (var j = 0; j < opts[i].values.length; j++) {
            cellMetrics.text = "\u2039 " + opts[i].values[j] + " \u203a"
            if (cellMetrics.width > widest) widest = cellMetrics.width
          }
          total += widest
          if (i < opts.length - 1) total += Style.space(18)
        }
        return Math.ceil(total)
      }

      // ------------------------------------------------------- config UI
      // Three options on one row: selected one in the caret colour with its
      // value bracketed, the others dimmed. j/k cycle the value, h/l move.
      Row {
        // Not `configRow`: that is the root's selected-option index, and
        // having an id and an unrelated property share a name in one scope
        // means every reference has to be root-qualified to stay correct.
        id: configStrip
        // Centred once on a fixed width rather than on its own content: with
        // every value cell pinned the total is already constant, and anchoring
        // to content would still recentre the strip if a label ever changed.
        width: configStripWidth
        x: Math.round((parent.width - width) / 2)
        anchors.verticalCenter: parent.verticalCenter
        visible: root.configMode
        spacing: Style.space(18)

        Repeater {
          // The option objects are the model directly; the old
          // `model: OPTIONS.length` plus an `OPTIONS[index]` lookup in every
          // delegate was an index round-trip for no gain.
          model: Settings.OPTIONS

          // `id`-qualified rather than `parent.`-qualified: inside the inner
          // Texts `parent` is this Row only by accident of nesting, and each
          // reference re-walked the chain.
          Row {
            id: optionEntry
            spacing: Style.space(5)
            required property int index
            required property var modelData
            readonly property bool sel: optionEntry.index === root.configRow

            // Widest rendering this option can ever have, measured once, so
            // the cell never resizes as values cycle.
            readonly property real valueCellWidth: {
              var values = optionEntry.modelData.values
              var widest = 0
              for (var i = 0; i < values.length; i++) {
                cellMetrics.text = "‹ " + values[i] + " ›"
                if (cellMetrics.width > widest) widest = cellMetrics.width
              }
              return Math.ceil(widest)
            }

            Text {
              text: optionEntry.modelData.label
              color: optionEntry.sel ? root.caretColor : root.pendingColor
              font.family: Style.fontFamily
              font.pixelSize: root.fontPx
              opacity: optionEntry.sel ? 1.0 : root.configDimOpacity
              Behavior on opacity { NumberAnimation { duration: 110 } }
            }

            Text {
              id: optionValue
              // The value sits in a fixed-width cell wide enough for the
              // longest option in this row, and the brackets are always
              // present — only their opacity changes. Sizing to the current
              // text instead made every row reflow sideways when a value
              // changed width or the selection moved, which made the strip
              // feel unstable while reading it.
              width: optionEntry.valueCellWidth
              horizontalAlignment: Text.AlignHCenter
              text: "‹ " + Settings.valueLabel(root.config, optionEntry.modelData.key) + " ›"
              color: optionEntry.sel ? root.typedColor : root.pendingColor
              font.family: Style.fontFamily
              font.pixelSize: root.fontPx
              opacity: optionEntry.sel ? 1.0 : root.configDimOpacity
              Behavior on opacity { NumberAnimation { duration: 110 } }
              // A value change nudges vertically: enough to register as "that
              // changed" at a glance without becoming a distraction.
              // `target` is the Text by id: inside a Behavior, `parent` is the
              // Behavior's own parent, which reads as a coincidence even when
              // it happens to be right.
              Behavior on text {
                SequentialAnimation {
                  NumberAnimation { target: optionValue; property: "y"; to: -2; duration: 60; easing.type: Easing.OutQuad }
                  PropertyAction {}
                  NumberAnimation { target: optionValue; property: "y"; to: 0; duration: 90; easing.type: Easing.OutBack }
                }
              }
            }
          }
        }
      }

      // The hint sits under the options, faded, so the controls are
      // discoverable without having to be remembered.
      Text {
        anchors.right: configStrip.left
        anchors.rightMargin: Style.space(16)
        anchors.verticalCenter: parent.verticalCenter
        visible: root.configMode
        text: "hjkl"
        color: root.pendingColor
        opacity: 0.4
        font.family: Style.fontFamily
        font.pixelSize: root.fontPx
      }

      // The advance of one cell, taken as the width of a run divided by its
      // length. A single glyph's reported width is its ink extent, which is
      // narrower than the advance and left the caret clipping the character
      // it was supposed to cover.
      TextMetrics {
        id: caretMetrics
        font.family: Style.fontFamily
        font.pixelSize: root.fontPx
        text: "mmmmmmmmmm"
      }
    }
  }
}
