import { ItemView, Notice, Plugin, WorkspaceLeaf, Platform } from "obsidian";
import SignalsmithStretch, { StretchNode } from "signalsmith-stretch";

export const SPIKE_VIEW = "by-ear-spike";

/**
 * Bumped by hand whenever the spike changes. Obsidian caches a plugin's `main.js` until the
 * plugin is toggled off and on, so "I already fixed that" and "you are running the old build"
 * look identical from the log. Printing this makes that question answerable in one glance.
 */
const SPIKE_BUILD = "spike-11 (one test at a time · excerpt bug fixed · crackle counted)";

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
  /** Name of the test currently running, or null. See `run()` for why this exists. */
  private busy: string | null = null;
  /** True between the picker returning and the decode finishing — a real state, not "nothing here". */
  private decoding = false;
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
        "The unknowns that are fatal if the answer is no, measured rather than assumed. Run every " +
        "test on every device, then copy the report.",
      cls: "by-ear-muted",
    });

    this.renderEnvironment(root.createDiv());

    const controls = root.createDiv({ cls: "by-ear-controls" });

    this.button(controls, "Test A — boot engine + measure pitch", () =>
      this.run("Test A", () => this.testEngine())
    );

    const fileRow = controls.createDiv();
    fileRow.createEl("label", { text: "Test B — pick a file (iCloud Drive is in here): " });
    const input = fileRow.createEl("input", { type: "file" });
    // ⚠️ Explicit extensions alongside the wildcards. On 3 September 2026 the iOS Files picker
    // greyed out every mp3 with `accept="audio/*,video/*"` — it maps `accept` onto UTIs, and the
    // audio wildcard did not come back with one that includes mp3. Named extensions are the
    // portable way to say what we mean, and a picker that hides the file is indistinguishable
    // from a device that cannot read it.
    input.setAttr(
      "accept",
      "audio/*,video/*,.mp3,.m4a,.aac,.wav,.aiff,.aif,.flac,.ogg,.opus,.mp4,.m4v,.mov"
    );
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void this.run("Test B", () => this.testDecode(file));
    });

    this.button(controls, "Test C — play the picked file at 0.75× / −100 cents", () =>
      this.run("Test C", () => this.testPlayback())
    );
    this.button(controls, "Test D — re-tune a node while it is playing", () =>
      this.run("Test D", () => this.testRescheduling())
    );
    this.button(controls, "Test E — hunt the dropouts (needs a file)", () =>
      this.run("Test E", () => this.testDropouts())
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
   * It plays one 440 Hz tone and reads the output frequency three times — with no engine at all,
   * with the engine asked for no shift, and with the engine asked for −37 cents. Each reading gets
   * its **own freshly booted node**, scheduled exactly once; see the note at the readings.
   *
   * ⚠️ An earlier version of this comment claimed that reading the same tone twice through the
   * same analyser cancels the FFT's own error. It does not, and the mistake produced a false
   * accusation against the engine on 3 September 2026. Bin quantisation and interpolation error
   * depend on where a tone happens to fall between two bins, so they differ between two reads at
   * two different pitches — they are not a constant bias, and a difference cancels nothing. The
   * two reads that day were 1.6 and 4.3 cents high, and the 2.7 cent gap between those errors was
   * reported as a 2.7 cent engine fault.
   *
   * ⚠️ And then the obvious follow-up theory was wrong too. Simulating that day's readings offline
   * showed the old bin-and-parabola ruler is good to **0.02 cents** on a clean tone, and that the
   * analyser's default 0.8 smoothing does not move the peak either (the first read has no history
   * to smooth against, so it only ever contributed 0.16 weight to the second). Neither suspect can
   * produce 4 cents. So the error is not in the arithmetic — it is in the *signal*, which means the
   * engine's output is not the clean stationary tone we assumed.
   *
   * Hence the shape of this test. It takes **three** readings, and each comparison isolates one
   * thing:
   *
   *   1. **bypass** — the tone straight from an AudioBufferSourceNode to the analyser, no engine
   *      in the path. This measures our own tone with our own ruler, and it should read 440.000.
   *      If it doesn't, nothing below means anything and the instrument is the story after all.
   *   2. **engine at 0 semitones** — the same tone through the stretcher, asked for no shift. Any
   *      gap between this and the bypass is the engine, provably, with the ruler ruled out.
   *   3. **engine at −37 cents** — measured against reading 2, so whatever the engine does at rest
   *      cancels and what is left is the shift.
   *
   * Each reading is the median of three, and the spread across those three is reported: a stable
   * number means a steady tone that is genuinely off, a wandering one means resynthesis that never
   * settles. Those are different bugs.
   */
  private async testEngine(): Promise<void> {
    this.write("TEST A — starting.");
    try {
      const ctx = await this.stage("resuming the AudioContext", this.audioContext());

      const seconds = 2;
      const length = Math.floor(ctx.sampleRate * seconds);
      const tone = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate);
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 32768;
      // ⚠️ Load-bearing. The default is 0.8, and the spec smooths each spectrum against the
      // *previous* getFloatFrequencyData call — which here is the other pitch, a second earlier.
      // Cross-contaminating the two reads is the last thing this test wants.
      analyser.smoothingTimeConstant = 0;
      const gain = ctx.createGain();
      gain.gain.value = 0.15;

      analyser.connect(gain);
      gain.connect(ctx.destination);

      /** Median of three reads a fifth of a second apart, plus how far apart they were. */
      const read = async (): Promise<{ hz: number; spread: number }> => {
        const reads: number[] = [];
        for (let i = 0; i < 3; i++) {
          const hz = toneFrequency(analyser, ctx.sampleRate);
          if (Number.isFinite(hz)) reads.push(hz);
          if (i < 2) await sleep(200);
        }
        if (reads.length === 0) return { hz: NaN, spread: NaN };
        reads.sort((a, b) => a - b);
        return {
          hz: reads[Math.floor(reads.length / 2)],
          spread: 1200 * Math.log2(reads[reads.length - 1] / reads[0]),
        };
      };

      const describeRead = (label: string, r: { hz: number; spread: number }, against: number) =>
        `${label}: ${r.hz.toFixed(3)} Hz · ${offsetCents(r.hz, against)} · ` +
        `spread ${r.spread.toFixed(2)} cents across 3 reads`;

      // ---- 1. the ruler, with no engine in the path at all.
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      buffer.copyToChannel(tone, 0);
      const bypass = ctx.createBufferSource();
      bypass.buffer = buffer;
      bypass.loop = true;
      bypass.connect(analyser);
      bypass.start();
      await sleep(900);
      const clean = await read();
      bypass.stop();
      bypass.disconnect();

      if (!Number.isFinite(clean.hz)) {
        this.write("TEST A FAIL — even the bypass tone read as silence. The analyser tap is wrong.");
        return;
      }
      this.write(describeRead("ruler check (no engine)", clean, 440));

      const rulerError = 1200 * Math.log2(clean.hz / 440);
      if (Math.abs(rulerError) > 0.5) {
        this.write(
          "⚠️ TEST A ABORTED — the ruler cannot find a tone we generated ourselves. Everything " +
            "below would be measuring the instrument, so it is not worth printing."
        );
        return;
      }

      // ---- 2 and 3. the same tone through the engine.
      //
      // ⚠️ A *fresh node per reading*, which looks wasteful and is not. Until spike-8 both readings
      // came from one node scheduled twice, and on the iPad the second schedule produced silence —
      // so the reading that attributes the error is exactly the reading we lost, on the platform we
      // most needed it from. Whether re-scheduling a live node works is a real question, but it is
      // Test D's question, and it has no business being a hidden dependency of this one.
      const readAt = async (semitones: number): Promise<{ hz: number; spread: number }> => {
        const node = await this.createStretch(ctx, 1);
        const latency = await this.stage("asking the worklet its latency", node.latency(), 5000);
        if (Number.isFinite(latency)) {
          this.write(`… engine booted, worklet latency ${(latency * 1000).toFixed(1)} ms`);
        }
        await this.stage("handing the tone to the worklet", node.addBuffers([tone]), 10000);

        node.connect(analyser);
        this.stretch = node;
        node.schedule({
          output: ctx.currentTime + 0.05,
          active: true,
          input: 0,
          rate: 1,
          semitones,
          loopStart: 0,
          loopEnd: seconds,
        });
        await sleep(900);

        const result = await read();
        node.disconnect();
        return result;
      };

      const rest = await readAt(0);
      if (!Number.isFinite(rest.hz)) {
        this.write("TEST A FAIL — the node produced silence. The worklet is not processing.");
        return;
      }
      const shifted = await readAt(-0.37);
      if (!Number.isFinite(shifted.hz)) {
        this.write("TEST A FAIL — the node went silent when asked for a fractional shift.");
        return;
      }

      this.write(describeRead("engine at 0 semitones", rest, clean.hz));
      this.write(describeRead("engine at −37 cents", shifted, rest.hz));

      const atRest = 1200 * Math.log2(rest.hz / clean.hz);
      if (Math.abs(atRest) > 1) {
        this.write(
          `⚠️ the engine moves the pitch by ${atRest.toFixed(2)} cents when asked for no shift ` +
            "at all. The ruler is clean on the bypass, so that is the engine — and it is the " +
            "number to chase, not the shift below."
        );
      }

      this.write(this.pitchVerdict(1200 * Math.log2(shifted.hz / rest.hz)));
    } catch (err) {
      this.write(`TEST A FAIL — ${describe(err)}`);
    }
  }

  /**
   * Two questions live in this one number, and only the first is fatal.
   *
   * **Does the engine round fractional semitones to whole ones?** If it does, the pitch control
   * this whole plugin is built around cannot exist, and we would need a different engine. An
   * engine that rounds lands on 0 or −100 cents; nothing else does.
   *
   * **Is the shift accurate?** Merely nice. Nobody hears two cents, and a tuning error that size
   * would be a bug report against Signalsmith, not a reason to abandon the approach. So it is
   * reported honestly and separately, and it never says FAIL.
   */
  private pitchVerdict(cents: number): string {
    const asked = -37;
    const off = cents - asked;

    if (Math.abs(off) < 2) {
      return "TEST A PASS — worklet runs and fractional semitones behave as cents.";
    }
    if (Math.abs(cents) < 5 || Math.abs(cents + 100) < 5) {
      return (
        `TEST A FAIL — asked for ${asked} cents and got ${cents.toFixed(2)}: the engine is ` +
        "rounding fractional semitones to whole ones. The pitch control needs another engine."
      );
    }
    return (
      `TEST A SUSPECT — no rounding (a rounding engine would read 0 or −100, not ` +
      `${cents.toFixed(2)}), so cents do work. But the shift is ${off.toFixed(2)} cents off what ` +
      "was asked, which is worth chasing before the pitch control ships."
    );
  }

  // ---------------------------------------------------------------- test E

  /**
   * Hunts the dropouts Bas can hear, and tries to find the setting that stops them.
   *
   * On the iPad the audio "cuts out a bit, worst on Test C". That is the most serious thing the
   * spike has found — a player that stutters is not usable for transcription, and unlike a 1.5 cent
   * pitch offset it is not a number nobody can hear. But "a bit" cannot be optimised against, and
   * asking a person to A/B four configurations by ear is both unkind and unreliable, so this
   * measures it: play for six seconds, sample the output every 40 ms, and count both **holes** in
   * the sound and **clicks** in it.
   *
   * ⚠️ Counting only holes was the first version's mistake. Bas reported *crackle*, and a level
   * meter is blind to it — a click is not an absence of signal but a discontinuity, a step between
   * adjacent samples far bigger than the waveform's own slew. So `windowStats()` returns both, and
   * a window is only checked for clicks when it is not already inside a dropout, or every gap gets
   * counted twice under two names.
   *
   * Two suspects, so the runs vary two things independently:
   *
   *   1. **How much audio the worklet is holding.** Test C hands it the whole song — 155 MB of
   *      float samples on the iPad, likely copied across the port, so plausibly 310 MB resident.
   *      Memory pressure means collection pauses, and a collection pause on the audio thread *is*
   *      a dropout. If a 12 second excerpt is clean where the whole song is not, then chunked
   *      loading stops being Phase 4 tidying and becomes Phase 1 architecture.
   *   2. **How much work the engine does per render quantum.** `splitComputation` spreads the FFT
   *      across quanta instead of spending it all in one, which is the library's own answer to
   *      missing the deadline; `preset: "cheaper"` simply does less.
   *
   * A window counts as a dropout when its peak falls below a **twentieth of the run's own median**.
   * Relative rather than absolute on purpose: music has quiet passages, and a fixed floor would
   * either miss dropouts in a loud passage or invent them in a soft one.
   */
  private async testDropouts(): Promise<void> {
    this.write(
      "TEST E — hunting dropouts and crackle. Six runs, about a minute and a half. Listen along."
    );

    if (!this.picked) {
      this.write(
        this.decoding
          ? "TEST E — the file is still decoding. Wait for the 'decoded in …' line, then try again."
          : "TEST E — nothing to play. Pick a file with Test B first."
      );
      new Notice(this.decoding ? "Still decoding — wait a moment." : "Pick a file first (Test B).");
      return;
    }

    try {
      const ctx = await this.stage("resuming the AudioContext", this.audioContext());
      this.stopAudio();

      const buffer = this.picked.buffer;
      const from = Math.min(60, Math.max(0, buffer.duration - 15));

      /**
       * The whole song, or just the loop region plus a margin — the first suspect.
       *
       * ⚠️ `offset` is the position **within the buffer we hand over**, which is not the same
       * number as the position within the song. Getting that wrong is what silenced both excerpt
       * runs on 3 September 2026: the slice starts at the loop point, so inside it the loop begins
       * at **0**, but the schedule asked for 60 s — past the end of a 12 second buffer. The runs
       * reported `SILENT — nothing to measure`, which read like a finding and was a subtraction
       * I failed to do. It also killed exactly the comparison the test exists for.
       */
      const slice = (whole: boolean): { channels: Float32Array[]; offset: number } => {
        if (whole) {
          const channels: Float32Array[] = [];
          for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
          return { channels, offset: from };
        }
        const start = Math.floor(from * buffer.sampleRate);
        const end = Math.min(buffer.length, Math.floor((from + 12) * buffer.sampleRate));
        const channels: Float32Array[] = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          channels.push(buffer.getChannelData(c).slice(start, end));
        }
        return { channels, offset: 0 };
      };

      // ⚠️ `splitComputation` is only read on the branch that also sets `blockMs`
      // (`SignalsmithStretch.mjs:203`): with no `blockMs` the library takes a preset path and the
      // flag is silently ignored. Passing it alone would have produced a run identical to the
      // default one, labelled as though it were a different setting — so the split run sets an
      // explicit block size, and is honest about changing two things at once.
      const runs: {
        label: string;
        whole: boolean;
        configure?: Parameters<StretchNode["configure"]>[0];
      }[] = [
        { label: "whole song, default", whole: true },
        { label: "12 s excerpt, default", whole: false },
        { label: "whole song, preset cheaper", whole: true, configure: { preset: "cheaper" } },
        {
          label: "whole song, 100 ms block + split",
          whole: true,
          configure: { blockMs: 100, intervalMs: 25, splitComputation: true },
        },
        { label: "12 s excerpt, preset cheaper", whole: false, configure: { preset: "cheaper" } },
        // The control, and the only reason the four above can be compared at all. It repeats run 1
        // verbatim at the end. If it comes back worse than run 1 did, the runs are not independent
        // — the device is simply more tired — and the differences between them mean nothing. On
        // 3 September the numbers got monotonically worse in the order they ran (18.3 → 19.2 →
        // 23.3 %), which is what memory accumulation looks like and what a config difference does
        // not.
        { label: "whole song, default (repeat — the control)", whole: true },
      ];

      for (const run of runs) {
        const { channels, offset } = slice(run.whole);
        const megabytes = (channels.length * channels[0].length * 4) / 1e6;

        const node = await this.createStretch(ctx, buffer.numberOfChannels);
        if (run.configure) node.configure(run.configure);
        await this.stage("handing the audio to the worklet", node.addBuffers(channels), 30000);

        const tap = ctx.createAnalyser();
        tap.fftSize = 2048;
        node.connect(tap);
        tap.connect(ctx.destination);
        this.tap = tap;
        this.stretch = node;

        node.schedule({
          output: ctx.currentTime + 0.05,
          active: true,
          input: offset,
          rate: 0.75,
          semitones: -1,
          loopStart: offset,
          loopEnd: offset + 10,
        });

        // Let it settle before judging it: the first render quanta after a schedule are not
        // representative of anything, and counting them as dropouts would flatter the later runs.
        await sleep(600);

        const windows: { peak: number; jump: number }[] = [];
        for (let i = 0; i < 120; i++) {
          windows.push(windowStats(tap));
          await sleep(40);
        }
        const peaks = windows.map((w) => w.peak);

        // Hand the memory back before the next run rather than leaving five nodes' worth of
        // decoded audio for the collector to find later. `dropBuffers()` with no argument releases
        // everything and transfers the ArrayBuffers back out of the worklet, which is the
        // library's own mechanism and does not disturb the AudioContext — closing and reopening
        // that would be the obvious alternative and a bad one, because iOS only reliably resumes a
        // context from inside a user gesture and there isn't one in the middle of a loop.
        try {
          await this.stage("releasing the worklet's audio", node.dropBuffers(), 10000);
        } catch (err) {
          this.write(`  (could not release buffers: ${describe(err)})`);
        }
        node.disconnect();
        tap.disconnect();
        this.stretch = null;
        this.tap = null;

        const sorted = [...peaks].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        if (median < 0.001) {
          this.write(`  ${run.label} (${megabytes.toFixed(0)} MB): SILENT — nothing to measure.`);
          continue;
        }

        const jumpsSorted = [...windows.map((w) => w.jump)].sort((a, b) => a - b);
        const medianJump = jumpsSorted[Math.floor(jumpsSorted.length / 2)];

        const floor = median / 20;
        let quiet = 0;
        let longestRun = 0;
        let currentRun = 0;
        let clicks = 0;
        for (const w of windows) {
          if (w.peak < floor) {
            quiet++;
            currentRun++;
            longestRun = Math.max(longestRun, currentRun);
          } else {
            currentRun = 0;
            // Only outside a dropout: the edges of a hole in the sound are themselves large jumps,
            // and counting those would report every gap twice under two different names.
            if (medianJump > 0 && w.jump > 8 * medianJump) clicks++;
          }
        }

        const percent = (100 * quiet) / windows.length;
        const verdict =
          quiet === 0 && clicks === 0
            ? "✅ clean"
            : [
                quiet > 0 ? `⚠️ ${quiet}/${windows.length} quiet (${percent.toFixed(1)}%)` : null,
                clicks > 0 ? `⚠️ ${clicks} windows with clicks` : null,
              ]
                .filter(Boolean)
                .join(", ");

        this.write(
          `  ${run.label} (${megabytes.toFixed(0)} MB): ${verdict}` +
            `${longestRun > 1 ? `, worst gap ~${longestRun * 40} ms` : ""}` +
            ` · median peak ${median.toFixed(3)}, quietest ${sorted[0].toFixed(3)}` +
            ` · jump ${medianJump.toFixed(3)}→${jumpsSorted[jumpsSorted.length - 1].toFixed(3)}`
        );
      }

      this.write(
        "TEST E done. Read the control line first: if the repeat is worse than run 1, the runs " +
          "are not independent and the differences between them mean nothing. Then compare pairs — " +
          "excerpt beating whole song means the fix is chunked loading, cheaper/split beating " +
          "default means it is CPU."
      );
    } catch (err) {
      this.write(`TEST E FAIL — ${describe(err)}`);
    }
  }

  // ---------------------------------------------------------------- test D

  /**
   * Can the engine be re-tuned **while it is playing**? Phase 1's entire interface depends on yes.
   *
   * Dragging a pitch slider, nudging the tempo, moving the A or B marker — every one of those is a
   * `schedule()` call on a node that is already making sound. On the Mac that has always worked. On
   * the iPad, spike-8's Test A scheduled one node twice and **the second schedule produced silence**,
   * which is a far bigger finding than the pitch error it was chasing: it would mean the player can
   * set its parameters once and never change them, which is not a player.
   *
   * So this test does the one thing that matters and does it four ways, each on its own fresh node,
   * because a node that has already gone silent cannot answer the next question. Each attempt plays
   * at 0 semitones, is checked for output, is then asked to drop an octave, and is checked again.
   * An octave rather than a few cents on purpose — 220 Hz against 440 Hz needs no interpretation.
   *
   * The variants exist because the library's `schedule()` distinguishes `output` (when the new
   * segment takes effect, on the AudioContext clock) from `outputTime` (the moment it prunes and
   * re-anchors the time map, defaulting to the *worklet's* own clock). Those are two different
   * clocks, and the gap between them is exactly the kind of thing that behaves differently under a
   * mobile WebView's larger buffers.
   */
  private async testRescheduling(): Promise<void> {
    this.write("TEST D — can a playing node be re-tuned? Four ways, fresh node each time.");
    try {
      const ctx = await this.stage("resuming the AudioContext", this.audioContext());

      const seconds = 2;
      const length = Math.floor(ctx.sampleRate * seconds);
      const tone = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        tone[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / ctx.sampleRate);
      }

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 32768;
      analyser.smoothingTimeConstant = 0;
      const gain = ctx.createGain();
      gain.gain.value = 0.15;
      analyser.connect(gain);
      gain.connect(ctx.destination);

      const base = {
        active: true,
        input: 0,
        rate: 1,
        loopStart: 0,
        loopEnd: seconds,
      };

      const variants: { label: string; retune: (node: StretchNode) => void }[] = [
        {
          label: "schedule() 50 ms ahead",
          retune: (node) =>
            node.schedule({ ...base, output: ctx.currentTime + 0.05, semitones: -12 }),
        },
        {
          label: "schedule() 300 ms ahead",
          retune: (node) =>
            node.schedule({ ...base, output: ctx.currentTime + 0.3, semitones: -12 }),
        },
        {
          label: "schedule() with an explicit outputTime",
          retune: (node) =>
            node.schedule({
              ...base,
              output: ctx.currentTime + 0.05,
              outputTime: ctx.currentTime,
              semitones: -12,
            }),
        },
        {
          label: "stop() then start()",
          retune: (node) => {
            node.stop(ctx.currentTime);
            node.start(ctx.currentTime + 0.05);
            node.schedule({ ...base, output: ctx.currentTime + 0.06, semitones: -12 });
          },
        },
      ];

      for (const variant of variants) {
        const node = await this.createStretch(ctx, 1);
        await this.stage("handing the tone to the worklet", node.addBuffers([tone]), 10000);
        node.connect(analyser);
        this.stretch = node;

        node.schedule({ ...base, output: ctx.currentTime + 0.05, semitones: 0 });
        await sleep(800);
        const before = toneFrequency(analyser, ctx.sampleRate);

        if (!Number.isFinite(before)) {
          this.write(`  ${variant.label}: SKIPPED — the first schedule never played.`);
          node.disconnect();
          continue;
        }

        variant.retune(node);
        await sleep(800);
        const after = toneFrequency(analyser, ctx.sampleRate);
        node.disconnect();

        if (!Number.isFinite(after)) {
          this.write(`  ${variant.label}: ❌ SILENT after re-tuning (was ${before.toFixed(1)} Hz).`);
          continue;
        }
        const moved = 1200 * Math.log2(after / before);
        this.write(
          `  ${variant.label}: ${Math.abs(moved + 1200) < 25 ? "✅" : "⚠️"} ` +
            `${before.toFixed(1)} → ${after.toFixed(1)} Hz (${offsetCents(after, before)}, ` +
            "asked for −1200)"
        );
      }

      this.write(
        "TEST D done. A ✅ on any line is enough — that is the way the player will re-tune. " +
          "All four silent means parameters can only be set at schedule time, and Phase 1 needs a " +
          "different design (a new node per change, crossfaded)."
      );
    } catch (err) {
      this.write(`TEST D FAIL — ${describe(err)}`);
    }
  }

  // ---------------------------------------------------------------- test B

  private async testDecode(file: File): Promise<void> {
    this.write(`picked "${file.name}" · ${(file.size / 1e6).toFixed(1)} MB · type "${file.type}"`);
    this.write("TEST B PASS — the file picker returned a file.");

    this.decoding = true;
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
    } finally {
      this.decoding = false;
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
      // And "still decoding" is a different state from "nothing here": Test B prints PASS as soon
      // as the picker returns, so there is a real window, seconds long on a big file, where the
      // log looks finished and the buffer does not exist yet.
      this.write(
        this.decoding
          ? "TEST C — the file is still decoding. Wait for the 'decoded in …' line, then try again."
          : "TEST C — nothing to play. Pick a file with Test B first (and check it decoded)."
      );
      new Notice(this.decoding ? "Still decoding — wait a moment." : "Pick a file first (Test B).");
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
      if (Platform.isMobile) {
        // Every test here decides PASS by measuring the signal, which means a muted device passes
        // silently and reads as "the engine is broken" to whoever is holding it. Say so up front,
        // because on iOS the ring/silent switch really does mute a WebView.
        this.write(
          "📱 note: PASS below means the samples are moving, not that you can hear them. " +
            "If a test passes in silence, check the silent switch and the volume first."
        );
      }
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

  /**
   * Runs a test, and refuses to start a second one while the first is still going.
   *
   * ⚠️ Not defensive tidying — the lack of this produced three separate false findings in one
   * report on 3 September 2026, and each looked exactly like a platform limitation:
   *
   *   - Two Test A runs at once each tried to build a worklet node, and both reported
   *     `HUNG at "building the worklet node"` after 8 s. Read as a CSP or WebView failure.
   *   - Test C started while Test D was mid-variant. Test C opens by calling `stopAudio()`, which
   *     acts on the shared `this.stretch` — so it tore down **Test D's** node, and Test D honestly
   *     reported `❌ SILENT after re-tuning`. The identical run had passed four out of four
   *     minutes earlier.
   *   - Test C ran twice concurrently, each holding 155 MB.
   *
   * A spike exists to produce trustworthy facts. One that lets two tests share an AudioContext and
   * a `this.stretch` field produces confident, well-formatted fiction instead.
   */
  private async run(name: string, test: () => Promise<void>): Promise<void> {
    if (this.busy) {
      this.write(`⏳ ${name} ignored — ${this.busy} is still running. One at a time.`);
      new Notice(`${this.busy} is still running.`);
      return;
    }
    this.busy = name;
    try {
      await test();
    } finally {
      this.busy = null;
    }
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
/**
 * Frequency of the strongest partial, to a small fraction of a cent. NaN if there is no signal.
 *
 * ⚠️ **This is not the fix for the 3 September mismeasurement, and it is worth being clear about
 * that, because it looks like it should be.** The previous ruler took the loudest of the
 * analyser's bins and interpolated a parabola through its neighbours. Bins are 1.35 Hz apart here
 * — about 5 cents at this pitch — so that method *looks* far too coarse to answer a question posed
 * in cents. It isn't: simulated against the exact tones Test A plays, it came back accurate to
 * **0.02 cents**, because log-magnitude parabolic interpolation on a Blackman-windowed spectrum is
 * very nearly exact for a clean sine. The 4 cents we actually saw cannot be blamed on it.
 *
 * So this exists for a different reason: it removes the bin grid from the argument entirely. It
 * uses the bins only to find the neighbourhood, then evaluates the DFT directly at arbitrary
 * frequencies inside it and hunts the true maximum by ternary search — converging to 0.0001 Hz,
 * under a thousandth of a cent. Where it genuinely earns its place is on the signal we are *not*
 * sure about: parabolic interpolation assumes one clean symmetric peak, and phase-vocoder output
 * with harmonics or a wandering partial is exactly where that assumption quietly stops holding.
 */
function toneFrequency(analyser: AnalyserNode, sampleRate: number): number {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);

  let loudest = 0;
  for (const sample of samples) loudest = Math.max(loudest, Math.abs(sample));
  if (loudest < 1e-3) return NaN;

  // Hann window. Without one, the tone's leakage skirts run the length of the spectrum and the
  // magnitude curve we are about to search is not smooth enough to trust a maximum on.
  const windowed = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    windowed[i] = samples[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (samples.length - 1)));
  }

  const coarse = loudestBin(analyser, sampleRate);
  if (!Number.isFinite(coarse) || coarse <= 0) return NaN;

  const binWidth = sampleRate / analyser.fftSize;
  let low = Math.max(binWidth, coarse - 2 * binWidth);
  let high = coarse + 2 * binWidth;

  for (let i = 0; i < 60 && high - low > 1e-4; i++) {
    const a = low + (high - low) / 3;
    const b = high - (high - low) / 3;
    if (magnitudeAt(windowed, a, sampleRate) < magnitudeAt(windowed, b, sampleRate)) low = a;
    else high = b;
  }
  return (low + high) / 2;
}

/** Centre frequency of the loudest bin — a seed for the search above, not an answer. */
function loudestBin(analyser: AnalyserNode, sampleRate: number): number {
  const bins = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(bins);

  let peak = 1;
  for (let i = 1; i < bins.length - 1; i++) {
    if (bins[i] > bins[peak]) peak = i;
  }
  return Number.isFinite(bins[peak]) ? (peak * sampleRate) / analyser.fftSize : NaN;
}

/**
 * |DFT| of `samples` at one arbitrary frequency, by Goertzel's recurrence.
 *
 * Two multiplies and two adds per sample with no trigonometry inside the loop, which is what makes
 * it cheap enough to call a hundred times per read while searching.
 */
function magnitudeAt(samples: Float32Array, frequency: number, sampleRate: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
  let previous = 0;
  let beforeThat = 0;

  for (const sample of samples) {
    const current = sample + coefficient * previous - beforeThat;
    beforeThat = previous;
    previous = current;
  }

  return Math.sqrt(
    Math.max(0, previous * previous + beforeThat * beforeThat - coefficient * previous * beforeThat)
  );
}

/**
 * Peak level *and* the largest sample-to-sample step in the analyser's current window.
 *
 * The step is there to catch what a level meter cannot: **crackle**. A dropout is a hole in the
 * sound and shows up as a window with no level, but a click has plenty of level — it is a
 * discontinuity, a jump between two adjacent samples far larger than the waveform's own slew. Bas
 * reported both on the iPad on 3 September 2026, and the test at the time could only see one of
 * them, so it agreed the audio was fine while he was listening to it not be.
 *
 * Absolute thresholds are useless here (a cymbal has bigger steps than a bass note), so the caller
 * compares each window's jump against the median jump of the whole run.
 */
function windowStats(analyser: AnalyserNode): { peak: number; jump: number } {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);

  let peak = 0;
  let jump = 0;
  for (let i = 0; i < samples.length; i++) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > peak) peak = magnitude;
    if (i > 0) {
      const step = Math.abs(samples[i] - samples[i - 1]);
      if (step > jump) jump = step;
    }
  }
  return { peak, jump };
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

/** Signed distance in cents, formatted. Uses a real minus sign so the log copies cleanly. */
function offsetCents(measured: number, reference: number): string {
  const cents = 1200 * Math.log2(measured / reference);
  return `${cents >= 0 ? "+" : "−"}${Math.abs(cents).toFixed(2)} cents`;
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
