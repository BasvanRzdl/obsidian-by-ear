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

It measures three things, on whatever device you run it on:

1. **Does an AudioWorklet carrying inlined WASM boot inside Obsidian's WebView?** The engine
   builds its worklet from a `blob:` URL, which a strict content-security policy could block.
2. **Does `<input type="file">` reach the iOS Files picker?** On iPad that is the only route to
   iCloud Drive, so if it fails there is no mobile story at all.
3. **Does `decodeAudioData` accept an `.mp4` directly**, or is an extracted audio sidecar
   genuinely required for video?

Test A is a real measurement rather than a listening test: it plays 440 Hz through the stretcher
shifted down 37 cents and reports what actually came out, which proves both that the worklet runs
and that fractional semitones behave as cents.

## Built on

[Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch) (MIT) for
independent time-stretching and pitch-shifting. `rubberband-web` sounds better but is GPL, which
would be incompatible with releasing this under MIT.

## Licence

MIT — see [LICENSE](LICENSE).
