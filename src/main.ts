import { ItemView, Notice, Plugin, WorkspaceLeaf, Platform } from "obsidian";
import SignalsmithStretch, { StretchNode } from "signalsmith-stretch";

export const SPIKE_VIEW = "by-ear-spike";

/**
 * Bumped by hand whenever the spike changes. Obsidian caches a plugin's `main.js` until the
 * plugin is toggled off and on, so "I already fixed that" and "you are running the old build"
 * look identical from the log. Printing this makes that question answerable in one glance.
 */
const SPIKE_BUILD = "spike-6 (numberOfInputs: 1, output measured not assumed)";

/**
 * Phase 0 spike.
 *
 * This view exists to answer three questions that are fatal to the project if the answer is
 * "no", and that cannot be answered by reading documentation:
 *
 *   1. Does an AudioWorklet carrying inlined WASM boot inside Obsidian's WebView?
 *      (Signalsmith Stretch builds its worklet from a blob: URL, which a strict CSP could block.)
 *   2. Does `<input type="file">` reach the iOS Files picker, i.e. iCloud Drive?
 *   3. Does `decodeAudioData` accept an .mp4 straight, or do we genuinely need the mp3 sidecar?
 *
 * Everything here is throwaway. It is a measuring instrument, not a foundation.
 */
class SpikeView extends ItemView {
  private ctx: AudioContext | null = null;
  private stretch: StretchNode | null = null;
  private picked: { name: string; size: number; buffer: AudioBuffer } | null = null;
  /** Analyser tapped between the stretch node and the speakers, so silence is measured not guessed. */
  private tap: AnalyserNode | null = null;
  private log: string[] = [];
  private logEl!: HTMLElement;

  getViewType(): string {
    return SPIKE_VIEW;
  }

  getDisplayText(): string {
    return "By Ear — spike";
  }

  getIcon(): string {
    return "audio-lines";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("by-ear-spike");

    root.createEl("h2", { text: "By Ear — Phase 0 spike" });
    root.createEl("p", {
      text:
        "Three fatal unknowns, measured rather than assumed. Run every test on every device, " +
        "then copy the report.",
      cls: "by-ear-muted",
    });

    this.renderEnvironment(root.createDiv());

    const controls = root.createDiv({ cls: "by-ear-controls" });

    this.button(controls, "Test A — boot engine + measure pitch", () => this.testEngine());

    const fileRow = controls.createDiv();
    fileRow.createEl("label", { text: "Test B — pick a file (iCloud Drive is in here): " });
    const input = fileRow.createEl("input", { type: "file" });
    input.setAttr("accept", "audio/*,video/*");
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void this.testDecode(file);
    });

    this.button(controls, "Test C — play the picked file at 0.75× / −100 cents", () =>
      this.testPlayback()
    );
    this.button(controls, "Stop", () => this.stopAudio());
    this.button(controls, "Reset audio", () => void this.resetAudio());
    this.button(controls, "Copy report", () => this.copyReport());

    root.createEl("h3", { text: "Results" });
    this.logEl = root.createEl("pre", { cls: "by-ear-log" });
    this.write(`ready · ${SPIKE_BUILD}`);
  }

  async onClose(): Promise<void> {
    this.stopAudio();
    await this.ctx?.close();
    this.ctx = null;
  }

  // ---------------------------------------------------------------- environment

  private renderEnvironment(el: HTMLElement): void {
    el.createEl("h3", { text: "Environment" });
    const table = el.createEl("table", { cls: "by-ear-env" });

    const add = (label: string, value: string) => {
      const tr = table.createEl("tr");
      tr.createEl("td", { text: label });
      tr.createEl("td", { text: value });
    };

    add("Platform", Platform.isMobile ? (Platform.isIosApp ? "iOS" : "mobile") : "desktop");
    add("AudioContext", typeof AudioContext !== "undefined" ? "yes" : "MISSING");
    add(
      "AudioWorklet",
      typeof AudioWorklet !== "undefined" && "audioWorklet" in AudioContext.prototype
        ? "yes"
        : "MISSING"
    );
    add("WebAssembly", typeof WebAssembly !== "undefined" ? "yes" : "MISSING");
    add("Blob URLs", this.blobUrlWorks() ? "yes" : "BLOCKED");
    add("User agent", navigator.userAgent);
  }

  /** Signalsmith builds its worklet module from a blob: URL. If CSP blocks that, nothing works. */
  private blobUrlWorks(): boolean {
    try {
      const url = URL.createObjectURL(new Blob(["// probe"], { type: "text/javascript" }));
      URL.revokeObjectURL(url);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- test A

  /**
   * Boots the engine and measures whether fractional semitones really behave as cents.
   *
   * It plays one 440 Hz tone through one node and reads the output frequency twice: once
   * unshifted, once asked for −37 cents. The answer is the *ratio* between the two, not
   * either absolute reading.
   *
   * That matters. A single absolute reading can't separate an engine error from the FFT's
   * own resolution — at 32768 bins and 44.1 kHz a bin is 1.35 Hz, which is about 4 cents at
   * this pitch, so an honest engine still looks a few cents off. Measuring the same tone
   * twice through the same analyser cancels that bias and leaves only the engine.
   */
  private async testEngine(): Promise<void> {
    this.write("TEST A — starting.");
    try {
      const ctx = await this.stage("resuming the AudioContext", this.audioContext());
      const stretch = await this.createStretch(ctx, 1);
      const latency = await stretch.latency();
      this.write(
        "TEST A — engine booted" +
          (Number.isFinite(latency) ? `, worklet latency ${(latency * 1000).toFixed(1)} ms` : "")
      );

      const seconds = 2;
      const length = Math.floor(ctx.sampleRate * seconds);
      const tone = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate);
      }
      await stretch.addBuffers([tone]);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 32768;
      const gain = ctx.createGain();
      gain.gain.value = 0.15;

      stretch.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      this.stretch = stretch;

      const readAt = async (semitones: number): Promise<number> => {
        stretch.schedule({
          output: ctx.currentTime + 0.05,
          active: true,
          input: 0,
          rate: 1,
          semitones,
          loopStart: 0,
          loopEnd: seconds,
        });
        await sleep(900);
        return peakFrequency(analyser, ctx.sampleRate);
      };

      // The shifted read comes first, because that ordering is the one verified working in a
      // browser harness. The unshifted read is a refinement, and re-scheduling a live node is
      // not yet proven, so the verdict degrades to the absolute measurement if it comes back
      // silent. A quirk in the second schedule must not masquerade as a broken engine.
      const shifted = await readAt(-0.37);
      if (!Number.isFinite(shifted)) {
        this.write("TEST A FAIL — the node produced silence. The worklet is not processing.");
        return;
      }

      const reference = await readAt(0);
      if (Number.isFinite(reference)) {
        const cents = 1200 * Math.log2(shifted / reference);
        this.write(
          `reference ${reference.toFixed(2)} Hz · shifted ${shifted.toFixed(2)} Hz · ` +
            `delta ${cents.toFixed(2)} cents (asked for −37.00)`
        );
        this.write(
          Math.abs(cents + 37) < 2
            ? "TEST A PASS — worklet runs and fractional semitones behave as cents."
            : "TEST A SUSPECT — audible, but the pitch shift is off. Don't trust cents yet."
        );
        return;
      }

      const expected = 440 * Math.pow(2, -0.37 / 12);
      const errorCents = 1200 * Math.log2(shifted / expected);
      this.write(
        `measured ${shifted.toFixed(2)} Hz · expected ${expected.toFixed(2)} Hz · ` +
          `error ${errorCents.toFixed(1)} cents`
      );
      this.write("(the unshifted reference read came back silent — re-scheduling a live node)");
      this.write(
        Math.abs(errorCents) < 8
          ? "TEST A PASS — worklet runs and the shift is right to within FFT resolution."
          : "TEST A SUSPECT — audible, but the pitch shift is off. Don't trust cents yet."
      );
    } catch (err) {
      this.write(`TEST A FAIL — ${describe(err)}`);
    }
  }

  // ---------------------------------------------------------------- test B

  private async testDecode(file: File): Promise<void> {
    this.write(`picked "${file.name}" · ${(file.size / 1e6).toFixed(1)} MB · type "${file.type}"`);
    this.write("TEST B PASS — the file picker returned a file.");

    try {
      const ctx = await this.audioContext();
      const started = performance.now();
      const bytes = await file.arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes);
      const elapsed = performance.now() - started;

      this.picked = { name: file.name, size: file.size, buffer };
      this.write(
        `decoded in ${(elapsed / 1000).toFixed(1)} s · ${buffer.duration.toFixed(1)} s · ` +
          `${buffer.numberOfChannels} ch · ${buffer.sampleRate} Hz · ` +
          `~${((buffer.length * buffer.numberOfChannels * 4) / 1e6).toFixed(0)} MB in memory`
      );
      const isVideo = /\.(mp4|mov|m4v|webm)$/i.test(file.name);
      this.write(
        isVideo
          ? "NOTE — decodeAudioData handled a video container directly. The mp3 sidecar may be optional here."
          : "decode OK."
      );
    } catch (err) {
      this.write(`decode FAILED — ${describe(err)}`);
      this.write("NOTE — this is why /by-ear should extract an mp3 sidecar for video.");
    }
  }

  // ---------------------------------------------------------------- test C

  private async testPlayback(): Promise<void> {
    // Always the first thing on the page, before any await. A test that can print nothing at all
    // teaches nothing: "the button does nothing" is indistinguishable from a hang, a throw, an
    // unreloaded build, and a handler that never fired.
    this.write("TEST C — starting.");

    if (!this.picked) {
      // Written to the log, not only to a Notice — Test B reports PASS the moment the picker
      // returns, so a file whose decode then failed leaves nothing here and a toast is easy to miss.
      this.write("TEST C — nothing to play. Pick a file with Test B first (and check it decoded).");
      new Notice("Pick a file first (Test B).");
      return;
    }
    try {
      const ctx = await this.stage("resuming the AudioContext", this.audioContext());
      // One node into the destination at a time, or Test A's tone plays under the music.
      this.stopAudio();

      const buffer = this.picked.buffer;
      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        channels.push(buffer.getChannelData(c));
      }
      this.write(
        `preparing ${channels.length} × ${buffer.length} samples ` +
          `(${((channels.length * buffer.length * 4) / 1e6).toFixed(0)} MB)`
      );

      const stretch = await this.createStretch(ctx, buffer.numberOfChannels);
      await this.stage("handing the audio to the worklet", stretch.addBuffers(channels), 30000);

      // Deliberately connected *before* the schedule, which leaves a few render quanta running on
      // the default inactive segment. That is precisely the window that killed spike-5, so the
      // test is worth keeping honest by exercising it rather than scheduling first to dodge it.
      const tap = ctx.createAnalyser();
      tap.fftSize = 2048;
      stretch.connect(tap);
      tap.connect(ctx.destination);
      this.tap = tap;

      // Loop ten seconds from a minute in — far enough into any track to be real music.
      const from = Math.min(60, Math.max(0, buffer.duration - 15));
      stretch.schedule({
        output: ctx.currentTime + 0.05,
        active: true,
        input: from,
        rate: 0.75,
        semitones: -1,
        loopStart: from,
        loopEnd: from + 10,
      });
      this.stretch = stretch;

      this.write(
        `TEST C — from ${from.toFixed(0)} s, 10 s loop, 0.75× rate, −100 cents. Measuring output…`
      );

      // "Was there sound?" is not a question to leave to a human ear and a report pasted twenty
      // minutes later. spike-5 logged "playing" while emitting pure silence, and the log looked
      // like a pass. Peak amplitude over a second of real audio settles it before Bas listens.
      await sleep(1200);
      const peak = peakAmplitude(tap);
      if (peak < 0.001) {
        this.write(
          `TEST C FAIL — output is silent (peak ${peak.toFixed(5)}). The worklet is not processing.`
        );
        return;
      }
      this.write(
        `TEST C PASS — output is live (peak ${peak.toFixed(3)}). ` +
          "Now listen for dropouts, crackle or drift, then press Stop."
      );
    } catch (err) {
      this.write(`TEST C FAIL — ${describe(err)}`);
    }
  }

  // ---------------------------------------------------------------- plumbing

  /**
   * Builds a stretch node.
   *
   * `numberOfInputs` **must be 1**, even though nothing is ever connected to that input. The
   * reason is one line in the library's own worklet (`SignalsmithStretch.mjs:266`):
   *
   * ```js
   * let inputs = inputList[0];
   * if (!currentMapSegment.active) {
   *   outputList[0].forEach((_, c) => {
   *     let channelBuffer = inputs[c%inputs.length];   // reads .length unconditionally
   * ```
   *
   * A fresh node starts on a default time-map segment with `active: false` (line 38), so this
   * branch always runs at least once — every render quantum between `connect()` and the moment
   * the scheduled segment takes effect. With zero declared inputs the browser passes
   * `inputList === []`, so `inputList[0]` is `undefined` and that line throws a TypeError on the
   * audio thread. The processor is then retired permanently, and it fails in the most misleading
   * way available: the node stays alive, its port still answers — `latency()` returns a perfectly
   * plausible 120 ms — and the output is silence forever.
   *
   * With one declared input and nothing connected, `inputList` is `[[]]`, so `inputs` is `[]`,
   * `inputs[c % 0]` is `inputs[NaN]` is `undefined` — assigned to a variable this branch never
   * reads. Harmless. Once a segment is active, `inputs?.length` is 0, so it correctly falls
   * through to buffer playback instead of the live-input path.
   *
   * ⚠️ Do not change this back to 0 on the grounds that the node has no input. That is not an
   * optimisation; it is the difference between audio and silence.
   *
   * This replaces spike-4's `[0, 1]` probe, which was a broken instrument: it treated "the node
   * booted" as "the node works", and `inputs: 0` boots perfectly and then plays nothing. So it
   * locked itself to 0 on the first call and never tried 1 again. Note that the library's own
   * default is 1 — overriding it was the original mistake.
   */
  private async createStretch(ctx: AudioContext, channels: number): Promise<StretchNode> {
    const options = {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
    };
    const watcher = this.watchForProcessorDeath(ctx, options);
    try {
      const stretch = await this.stage("building the worklet node", SignalsmithStretch(ctx, options), 8000);
      // A dead worklet is otherwise indistinguishable from a working one playing a silent file.
      // ⚠️ Necessary but not sufficient: under spike-5 the processor provably died on its first
      // render quantum and this event never fired once. That is why every test now *measures*
      // the output rather than trusting the absence of an error.
      stretch.addEventListener("processorerror", () => {
        this.write("‼️ WORKLET DIED — the processor threw and is now permanently silent.");
      });
      return stretch;
    } finally {
      watcher.cancel();
    }
  }

  /**
   * Catches a worklet processor dying while it is still booting.
   *
   * `SignalsmithStretch()` resolves only when the processor posts `ready` from the audio thread.
   * It never rejects and never times out, so a processor that throws inside its constructor
   * produces a promise that simply never settles. The `processorerror` event that carries the real
   * reason fires on a node held in the library's own local variable — by the time it hands that
   * node back, the moment has passed, which is why attaching the listener after the `await` (as
   * spike-4 did) can never work.
   *
   * The way in is that `addModule()` registers the processor by *name* on the context. Once that
   * has happened anyone can build a node under the same name, and ours fails in exactly the same
   * way — so its `processorerror` carries the message the library swallowed. This is the whole
   * difference between `HUNG at "building the worklet node"` and a named ReferenceError.
   *
   * The probe is also a second, independent reading: if it never manages to construct a node, the
   * module never registered and the fault is in loading, not in the processor.
   */
  private watchForProcessorDeath(
    ctx: AudioContext,
    options: AudioWorkletNodeOptions
  ): { cancel(): void } {
    let cancelled = false;
    let probe: AudioWorkletNode | null = null;
    let attempts = 0;

    const tick = () => {
      if (cancelled) return;
      try {
        probe = new AudioWorkletNode(ctx, "signalsmith-stretch", options);
      } catch {
        // Not registered yet — addModule() is still in flight. Keep looking, but not forever.
        if (++attempts < 40) window.setTimeout(tick, 250);
        else this.write("   ↳ the processor never registered — the module itself failed to load.");
        return;
      }
      probe.onprocessorerror = (event: Event) => {
        const detail =
          event instanceof ErrorEvent && event.message
            ? event.message
            : "no message on the event — open the developer console for the audio thread's error";
        this.write(`   ‼️ the processor threw while starting: ${detail}`);
      };
    };

    window.setTimeout(tick, 250);
    return {
      cancel() {
        cancelled = true;
        probe?.disconnect();
      },
    };
  }

  /**
   * Announces a step, then fails loudly if it never finishes.
   *
   * A promise that simply never settles is the worst failure this spike can have: no log line,
   * no error, no clue. `ctx.resume()` does exactly that when the browser sees no user gesture,
   * and it sits ahead of every other step, so one missing gesture silences the entire test.
   * Losing the race is not proof the step failed — the work carries on — but it converts an
   * invisible hang into a named one, which is the whole job of a measuring instrument.
   */
  private async stage<T>(label: string, work: Promise<T>, ms = 10000): Promise<T> {
    this.write(`… ${label}`);
    let timer = 0;
    const expiry = new Promise<never>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new Error(`HUNG at "${label}" — no answer after ${ms / 1000} s`)),
        ms
      );
    });
    try {
      return await Promise.race([work, expiry]);
    } finally {
      window.clearTimeout(timer);
    }
  }

  /** iOS will not start audio outside a user gesture, so this is only ever called from a click. */
  private async audioContext(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.write(`AudioContext created at ${this.ctx.sampleRate} Hz`);
    }
    if (this.ctx.state === "suspended") {
      // Worth naming: a suspended context that will not resume means the click was not treated
      // as a user gesture, which is a platform finding rather than a bug in the test.
      this.write("AudioContext is suspended — resuming (needs a real user gesture)");
      await this.ctx.resume();
      this.write(`AudioContext is now "${this.ctx.state}"`);
    }
    return this.ctx;
  }

  /**
   * Tears the AudioContext down so the next test starts from a clean engine.
   *
   * Electron pools AudioWorklet threads and reuses them across contexts, so worklet nodes and
   * contexts left behind by earlier runs do not necessarily go away when the plugin is toggled.
   * This is the cheap thing to try before restarting Obsidian.
   */
  private async resetAudio(): Promise<void> {
    this.stopAudio();
    try {
      await this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = null;
    this.write("audio reset — context closed. Re-run Test A.");
  }

  private stopAudio(): void {
    try {
      this.stretch?.schedule({ active: false });
      this.stretch?.disconnect();
      this.tap?.disconnect();
    } catch {
      /* already gone */
    }
    this.stretch = null;
    this.tap = null;
  }

  private button(parent: HTMLElement, label: string, onClick: () => void): void {
    const btn = parent.createEl("button", { text: label });
    btn.addEventListener("click", onClick);
  }

  private write(line: string): void {
    this.log.push(line);
    this.logEl.setText(this.log.join("\n"));
  }

  private async copyReport(): Promise<void> {
    const header = `By Ear spike — ${new Date().toISOString()}\n${navigator.userAgent}\n\n`;
    await navigator.clipboard.writeText(header + this.log.join("\n"));
    new Notice("Report copied.");
  }
}

/** Quadratic interpolation around the loudest bin, for sub-bin frequency accuracy. */
function peakFrequency(analyser: AnalyserNode, sampleRate: number): number {
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);

  let peak = 1;
  for (let i = 1; i < bins.length - 1; i++) {
    if (bins[i] > bins[peak]) peak = i;
  }
  const a = bins[peak - 1];
  const b = bins[peak];
  const c = bins[peak + 1];
  const denominator = a - 2 * b + c;
  const offset = denominator === 0 ? 0 : (0.5 * (a - c)) / denominator;

  return ((peak + offset) * sampleRate) / analyser.fftSize;
}

/** Loudest sample in the analyser's current window. 0 means the node is emitting nothing at all. */
function peakAmplitude(analyser: AnalyserNode): number {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);

  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default class ByEarPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(SPIKE_VIEW, (leaf: WorkspaceLeaf) => new SpikeView(leaf));

    this.addCommand({
      id: "open-spike",
      name: "Open Phase 0 spike",
      callback: () => void this.openSpike(),
    });

    this.addRibbonIcon("audio-lines", "By Ear — spike", () => void this.openSpike());
  }

  private async openSpike(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SPIKE_VIEW);
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: SPIKE_VIEW, active: true });
    workspace.revealLeaf(leaf);
  }
}
