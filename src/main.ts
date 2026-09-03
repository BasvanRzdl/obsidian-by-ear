import { ItemView, Notice, Plugin, WorkspaceLeaf, Platform } from "obsidian";
import SignalsmithStretch, { StretchNode } from "signalsmith-stretch";

export const SPIKE_VIEW = "by-ear-spike";

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
    this.button(controls, "Copy report", () => this.copyReport());

    root.createEl("h3", { text: "Results" });
    this.logEl = root.createEl("pre", { cls: "by-ear-log" });
    this.write("ready.");
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
   * Plays a 440 Hz tone through the stretcher, shifted down 37 cents, and measures what
   * actually comes out. 440 * 2^(-0.37/12) = 430.68 Hz.
   *
   * Measuring rather than listening is the point: it proves the worklet runs AND that
   * fractional semitones behave as cents, which is the whole basis of the pitch control.
   */
  private async testEngine(): Promise<void> {
    try {
      const ctx = await this.audioContext();
      const stretch = await SignalsmithStretch(ctx, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.write(`engine booted. worklet latency ${(stretch.latency() * 1000).toFixed(1)} ms`);

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

      stretch.schedule({
        output: ctx.currentTime + 0.05,
        active: true,
        input: 0,
        rate: 1,
        semitones: -0.37,
        loopStart: 0,
        loopEnd: seconds,
      });
      this.stretch = stretch;

      await sleep(900);
      const measured = peakFrequency(analyser, ctx.sampleRate);
      const expected = 440 * Math.pow(2, -0.37 / 12);
      const errorCents = 1200 * Math.log2(measured / expected);

      this.write(
        `measured ${measured.toFixed(2)} Hz · expected ${expected.toFixed(2)} Hz · ` +
          `error ${errorCents.toFixed(1)} cents`
      );
      this.write(
        Math.abs(errorCents) < 5
          ? "TEST A PASS — worklet runs and fractional semitones behave as cents."
          : "TEST A SUSPECT — tone is audible but pitch is off. Investigate before trusting cents."
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
    if (!this.picked) {
      new Notice("Pick a file first (Test B).");
      return;
    }
    try {
      const ctx = await this.audioContext();
      const buffer = this.picked.buffer;
      const channels: Float32Array[] = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        channels.push(buffer.getChannelData(c));
      }

      const stretch = await SignalsmithStretch(ctx, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [buffer.numberOfChannels],
      });
      await stretch.addBuffers(channels);
      stretch.connect(ctx.destination);

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
        `TEST C playing — from ${from.toFixed(0)} s, 10 s loop, 0.75× rate, −100 cents. ` +
          "Listen for dropouts, crackle or drift, then press Stop."
      );
    } catch (err) {
      this.write(`TEST C FAIL — ${describe(err)}`);
    }
  }

  // ---------------------------------------------------------------- plumbing

  /** iOS will not start audio outside a user gesture, so this is only ever called from a click. */
  private async audioContext(): Promise<AudioContext> {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.write(`AudioContext created at ${this.ctx.sampleRate} Hz`);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  private stopAudio(): void {
    try {
      this.stretch?.schedule({ active: false });
      this.stretch?.disconnect();
    } catch {
      /* already gone */
    }
    this.stretch = null;
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
