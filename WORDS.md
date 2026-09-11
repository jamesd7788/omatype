# Word list

`english.json` is the 200 most common English words, in frequency order —
the same list Monkeytype ships as its default `english` language, and the
same list every "most common words" typing test uses, because there is
essentially one such list.

It was taken from
[monkeytypegame/monkeytype](https://github.com/monkeytypegame/monkeytype)
(`frontend/static/languages/english.json`), with one change: **`I` is
removed**, because it is the only capitalised word in the set and reaching for
shift mid-burst breaks the rhythm of a short test. 199 words remain.

## On the licence

Monkeytype is GPL-3.0, and this project is GPL-3.0-or-later to stay
comfortably clear of any question about the vendored file.

That is a deliberately conservative choice rather than a conceded one. A
frequency-ordered list of the 200 commonest words in a language is a fact
about English, not an authored work — there is no meaningful creative
selection or arrangement to protect, and the same list falls out of any
corpus anyone cares to count. The plain reading is that it carries no
copyright at all.

The rest of the plugin was written from scratch. It is not a fork of
Monkeytype and shares none of its code.
