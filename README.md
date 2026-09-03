# By Ear

An Obsidian plugin for learning songs by ear: loop a passage, slow it down, shift its pitch in
semitones **and cents**, watch the player's hands — and keep what you worked out in a note
instead of locked inside an app.

> **Status: Phase 0.** This repository currently contains a *spike* — a measuring instrument that
> answers three questions which would kill the project if the answer were no. There is no player
> yet. Don't install this expecting one.

## Why

Every good transcribing tool has the same hole in it. Transcribe! is excellent but desktop-only.
Transcribe+ is excellent but needs an Apple M1 for its Mac build, so older Intel Macs are locked
out permanently, and its features sit behind a subscription. The browser tools that are genuinely
free can't show video. Nothing that runs everywhere is free, and nothing free runs everywhere.

And all of them store your progress the same way: loop points in a proprietary blob. But loop
points are the cheap half. What actually costs a session to rebuild is the *understanding* — the
roots, the tuning, the bar you still can't name. That belongs in text, on every device you own.

Obsidian already runs on all of them, and already syncs. So the player goes there.

## What it will do

- Load audio or video from wherever you keep it — on desktop straight off disk, on iOS through
  the Files picker, so iCloud Drive works
- Waveform, drag to set an A→B loop, nudge the edges to the millisecond
- Tempo 25–150%, pitch-preserving
- Pitch shift **independent of tempo**, in semitones *and* cents
- Video, kept in sync by slaving the picture to the audio clock
- Named marks and saved loops, written into the song's own note as plain markdown
- A sitting log, so you can see what you actually worked on

## What it will never do

These are deliberate, and they are the point of the project rather than missing features:

- **No chord detection, key detection, or BPM detection.** A tool should assist the ear, not
  answer for it. If it tells you the chord, it has deleted the part you were trying to learn.
  Tapping your own beat grid is fine; being told is not.
- **No streaks, no stats, no scoreboard.** The log records what you worked on, never a count.
  Practice tools that gamify this make missing a day feel like a failure, which is how people
  quit.
- **No lyrics, and no bundled media.** Nothing copyrighted ships in this repo.

## Platform support

| | |
|---|---|
| macOS (Intel and Apple Silicon) | intended |
| iPadOS / iOS | intended, and the main reason this exists |
| Windows / Linux | should work, untested |
| **Android** | ⚠️ **probably not.** Obsidian audio plugins are reported not to work on Android because of WebView limitations. This is unverified by me and I have no Android device to test on. |

## Running the spike

```bash
npm install
./install.sh                       # or: ./install.sh "/path/to/your/vault"
```

Then in Obsidian: **Settings → Community plugins → refresh**, enable **By Ear**, and open
*By Ear — spike* from the ribbon or the command palette.

It measures four things, on whatever device you run it on. The fourth was not planned — it was
found the hard way, and it cost two wrong diagnoses before it was pinned down:

1. **Does an AudioWorklet carrying inlined WASM boot inside Obsidian's WebView?** The engine
   builds its worklet from a `blob:` URL, which a strict content-security policy could block.
2. **Does `<input type="file">` reach the iOS Files picker?** On iPad that is the only route to
   iCloud Drive, so if it fails there is no mobile story at all.
3. **Does `decodeAudioData` accept an `.mp4` directly**, or is an extracted audio sidecar
   genuinely required for video?
4. **Which `numberOfInputs` does this engine need?** ✅ **Answered: 1**, even though nothing is ever
   connected to that input. Obsidian agrees with the browser after all — the run that seemed to say
   otherwise was hitting the build hazard below. See the second hazard note for the mechanism. The
   spike no longer probes: a probe could only detect a *boot* failure, and zero inputs boots
   perfectly and then plays silence.

### ⚠️ The silent-processor hazard, for anyone driving this engine

Declare **`numberOfInputs: 1`**. The library's own default is 1; overriding it to 0 because you are
feeding the node from buffers rather than a live input is a trap. Its worklet does this
(`SignalsmithStretch.mjs:266`):

```js
let inputs = inputList[0];
if (!currentMapSegment.active) {
  outputList[0].forEach((_, c) => {
    let channelBuffer = inputs[c%inputs.length];   // reads .length unconditionally
```

A fresh node starts on a default time-map segment with `active: false`, so that branch runs on
every render quantum between `connect()` and the moment your scheduled segment takes effect. With
zero declared inputs the browser passes `inputList === []`, so `inputs` is `undefined` and the line
throws a `TypeError` on the audio thread. The processor is retired permanently — and it looks
alive: the node still exists, its message port still answers, `latency()` returns a plausible
number, and the output is silence forever. With one input and nothing connected, `inputs` is `[]`,
`inputs[c % 0]` is `undefined`, and the assignment is dead code in that branch. Harmless.

The general lesson, which cost more than the bug: **an AudioWorklet that has died is
indistinguishable from one that is working on a silent file, unless you measure the output.**
`processorerror` did not fire once during any of this. Every test here now reads peak amplitude.

### ⚠️ The build hazard, for anyone bundling this engine

Signalsmith Stretch has no separate worklet file. It builds one at runtime by stringifying its own
functions, and the template hard-codes the identifier `_scriptName` as *text* while the factory
that reads it is real code. **Any bundler transform that renames identifiers breaks the pair
silently** — minification rewrote the declaration and left the string, so the worklet reached for a
closure variable that does not exist on the audio thread.

It fails in the worst possible way. Module evaluation only *defines* the factory, so `addModule()`
resolves; the node constructs fine on the main thread; the `ReferenceError` fires on the audio
thread inside the processor constructor; and a processor that throws never posts its `ready`
message — so the boot promise never settles **and never rejects**. No error, no log line, no
timeout. Just silence.

Hence `minify: false` and `target: "es2022"` in `esbuild.config.mjs`, both load-bearing and both
guarded by a post-build assertion. The durable fix is to stop depending on
`Function.prototype.toString()` and ship the worklet as its own file.

Test A is a real measurement rather than a listening test: it plays 440 Hz through the stretcher
shifted down 37 cents and reports what actually came out, which proves both that the worklet runs
and that fractional semitones behave as cents.

## Built on

[Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) (MIT) for
independent time-stretching and pitch-shifting. `rubberband-web` sounds better but is GPL, which
would be incompatible with releasing this under MIT.

## Licence

MIT — see [LICENSE](LICENSE).
