# Engineering notes

Hard-won notes from building By Ear on Signalsmith Stretch inside Obsidian's WebView. If you are
building anything on this engine, read these first.

## What the Phase 0 spike settled

The Phase 0 spike lives at the `phase-0-spike` tag. It measured five things, on whatever device it
was run on. Only the first three were planned; the last two were found the hard way, which is
rather the point of a spike:

1. **Does an AudioWorklet carrying inlined WASM boot inside Obsidian's WebView?** The engine
   builds its worklet from a `blob:` URL, which a strict content-security policy could block.
   ✅ **Answered: yes, on desktop and on iPadOS.** This was the one that could have ended the
   project, and it doesn't.
2. **Does `<input type="file">` reach the iOS Files picker?** On iPad that is the only route to
   iCloud Drive, so if it fails there is no mobile story at all. ✅ **Answered: yes.**
3. **Does `decodeAudioData` accept an `.mp4` directly**, or is an extracted audio sidecar
   genuinely required for video? ✅ **Answered: it takes the video container straight**, on iPadOS,
   including a 403 s file. Note what that costs though: decoded to float samples it was **155 MB
   resident**, so caching, not decoding, is the real mobile problem.
4. **Can a node be re-tuned while it is playing?** Every pitch drag and tempo nudge is a
   `schedule()` on a node already making sound. If not, parameters could be set once and never
   changed, which is not a player. ✅ **Answered: yes** — four ways out of four on iPadOS (50 ms
   ahead, 300 ms ahead, an explicit `outputTime`, and `stop()`/`start()`), landing within 6 cents
   of a requested octave every time.
5. **Which `numberOfInputs` does this engine need?** ✅ **Answered: 1**, even though nothing is ever
   connected to that input. Obsidian agrees with the browser after all — the run that seemed to say
   otherwise was hitting the build hazard below. See the second hazard note for the mechanism. The
   spike no longer probes: a probe could only detect a *boot* failure, and zero inputs boots
   perfectly and then plays silence.

### ⚠️ The configuration, for anyone else using Signalsmith Stretch

```js
stretch.configure({ blockMs: 200, intervalMs: 25, splitComputation: true });
```

Those three numbers were arrived at by measurement, not taste, and the library's defaults are not
close to them.

**`intervalMs` is the quality knob.** It defaults to `blockMs * 0.25`, which is far too coarse.
Feeding the engine one pure 440 Hz sine and measuring what came back, against a 0.001% bypass
floor: the default read **0.272%** THD+N on an Intel Mac and **0.445%** on an iPad. Dropping the
interval to 25 ms alone is **6.6× cleaner at zero latency cost**; adding the 200 ms block buys
another 1.8× for 80 ms. A pitch error of about +5 cents that looked like a separate defect turned
out to be the same misconfiguration — it falls to +0.42 cents with the same change, because the hop
was too coarse to resynthesise the phase correctly.

**`splitComputation` is the dropout knob, and no preset can reach it.** Without it the whole
block's FFT is computed inside a single 128-frame render quantum — a 2.9 ms budget at 44.1 kHz. A
desktop i5 finishes in time; the iPad's WebView does not, the device is handed nothing, and that
gap is an audible crackle. The library only reads the flag on the `blockMs` branch, so the default
configuration is spiky by construction. Cost of switching it on: 25 ms of latency.

And **never `preset: 'cheaper'`** — it measured 10× worse than the default.

### ⚠️ The leaked-processor hazard, for anyone building nodes at runtime

`process()` returns `true` unconditionally, which sets the processor's active-source flag. The spec
then requires the browser to retain the node **and keep calling it with no inputs connected**
([web-audio-api#2658](https://github.com/WebAudio/web-audio-api/issues/2658), open, reproduced in
Chrome and Firefox). `disconnect()` does not stop it. Dropping the reference does not stop it.
`schedule({active: false})` does not stop it either — the inactive branch still calls `_process()`.
**Only closing the `AudioContext` does.**

So build **one node for the life of a session** and re-`configure()`/`re-schedule()` it, rather
than building one per parameter change. Left alone this degrades a long session silently, and it is
why an audible fault looked random for an evening: the same code sounded clean on one run and
crackled on the next, because every button press left another processor running.

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

### Test A measures, and it also measures itself

Test A is not a listening test. It plays 440 Hz through the stretcher shifted down 37 cents and
reports what came out, which is what proves fractional semitones behave as cents rather than being
rounded to whole ones — the one result the whole pitch control depends on.

It takes three readings, because a single number cannot say *whose* fault it is:

1. **bypass** — the tone straight to the analyser, no engine in the path. Our tone, our ruler,
   nothing else. It should read 440.000, and if it doesn't the test aborts rather than blame the
   engine for its own error.
2. **engine at 0 semitones** — any gap from the bypass is the engine, with the measurement ruled
   out.
3. **engine at −37 cents** — read against 2, so whatever the engine does at rest cancels out.

Each reading is the median of three, and the spread between them is printed: a tight spread that
sits in the wrong place is a steady error, a wide one is resynthesis that never settles, and those
are different bugs.

A note on the ruler, because the obvious version of it is a trap in the other direction. Finding a
frequency by taking the loudest FFT bin and interpolating a parabola through its neighbours *looks*
far too coarse to answer a question posed in cents — bins here are 1.35 Hz apart, about 5 cents at
this pitch. Simulated against the exact tones this test plays, it is accurate to **0.02 cents**. It
was blamed for a 4-cent error it could not have caused. The DFT search used now is exact and
robust to messier signals, but the lesson is the general one: check whether your instrument is
actually the problem before rebuilding it.

