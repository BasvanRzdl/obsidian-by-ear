import SignalsmithStretch, { StretchNode } from "signalsmith-stretch";

/**
 * 📌 Measured, not chosen — 3 September 2026, Tests H and J on both an Intel Mac and an iPad.
 * Do not change these three numbers without re-running those tests.
 *
 *   intervalMs   the dominant term for *quality*. The library defaults it to `blockMs * 0.25`,
 *                which is far too coarse: 0.272% THD+N against a 0.001% bypass floor on the Mac,
 *                0.445% on the iPad. Dropping to 25 ms alone is 6.6x cleaner at zero latency cost,
 *                and it also removes what looked like a separate +5 cent pitch error but was the
 *                same misconfiguration wearing a different hat (+5.17 c -> +0.42 c).
 *   blockMs      buys another 1.8x for 80 ms of latency. 300 ms adds nothing worth having.
 *   splitComputation  the one that matters for *dropouts*. Without it the whole block's FFT is
 *                computed inside a single 128-frame render quantum -- a 2.9 ms budget -- and the
 *                iPad's WebView blows the deadline every time (Test J: J2 super crackly, J3 clean,
 *                same block size). It cannot be reached from any preset: the library only reads it
 *                on the `blockMs` branch, so the default configuration is spiky by construction.
 *
 * Cost: 225 ms of latency, which is invisible in a practice loop.
 * Never `preset: "cheaper"` -- it measured 10x worse than the default.
 */
export const ENGINE_CONFIG = { blockMs: 200, intervalMs: 25, splitComputation: true };

/**
 * How far ahead of `currentTime` every scheduled change is placed.
 *
 * The node compensates for its own latency, so a change scheduled at output time T is audible at
 * T. But `schedule()` interpolates the input position across the gap, so scheduling in the past
 * makes the engine "catch up" with a softer transition. 50 ms is enough to land cleanly and short
 * enough that a keypress still feels immediate.
 */
const LOOKAHEAD = 0.05;

/** Below this a loop region is treated as no loop at all. Matches the library's own test. */
const MIN_LOOP = 0.01;

export interface EngineState {
	playing: boolean;
	/** 1.0 == original speed. */
	rate: number;
	/** Fractional semitones. Cents are just semitones/100 -- one knob, not two systems. */
	semitones: number;
	loopA: number | null;
	loopB: number | null;
	looping: boolean;
}

export interface LoadedSong {
	name: string;
	duration: number;
	sampleRate: number;
	/**
	 * Mono downmix, kept for drawing the waveform at any zoom.
	 *
	 * ⚠️ Phase 4 (iOS) has to do better than this. A 19-minute video is ~220 MB here on top of the
	 * copy the worklet holds. On a Mac with a 3-minute mp3 it is nothing; on an iPad it is the
	 * whole problem. The fix is a min/max pyramid built at load and the samples then freed.
	 */
	peaksSource: Float32Array;
}

/**
 * Owns the AudioContext, the one worklet node, and the transport.
 *
 * ⚠️ **One node for the life of the session.** `process()` returns `true` unconditionally, which
 * sets the processor's active-source flag; the spec then requires the browser to keep it alive and
 * keep calling it forever. `disconnect()` does not stop it, dropping the reference does not stop
 * it, and `schedule({active: false})` does not stop it either -- the inactive branch still calls
 * `_process()`. Only closing the context does. (web-audio-api#2658, open.)
 *
 * An evening was lost to this: a spike that built seven nodes per button press got monotonically
 * slower, so identical code sounded clean on one run and crackled on the next. So: build once,
 * re-`configure()` and re-`schedule()` the node you have, and close the context on unload.
 */
export class Engine {
	private ctx: AudioContext | null = null;
	private node: StretchNode | null = null;
	private gain: GainNode | null = null;
	private meter: LoadMeter | null = null;

	private duration = 0;
	private state: EngineState = {
		playing: false,
		rate: 1,
		semitones: 0,
		loopA: null,
		loopB: null,
		looping: false,
	};

	/** The last scheduled segment, mirrored so the playhead needs no messages from the worklet. */
	private anchorInput = 0;
	private anchorOutput = 0;

	/** Fires when the engine stops itself at the end of the song. */
	onEnded: (() => void) | null = null;

	get transport(): Readonly<EngineState> {
		return this.state;
	}

	get songDuration(): number {
		return this.duration;
	}

	get ready(): boolean {
		return this.node !== null;
	}

	get sampleRate(): number {
		return this.ctx?.sampleRate ?? 0;
	}

	/**
	 * Decodes bytes and hands them to the worklet, replacing whatever was loaded.
	 *
	 * `decodeAudioData` takes an `.mp4` container straight -- measured on iPadOS with a 403 s file,
	 * decoded in 0.6 s -- so video files can be opened here without an extracted sidecar.
	 *
	 * ⚠️ It detaches the ArrayBuffer you give it. Pass a buffer nobody else needs.
	 */
	async load(bytes: ArrayBuffer, name: string): Promise<LoadedSong> {
		const ctx = await this.context();
		const buffer = await ctx.decodeAudioData(bytes);
		const node = await this.ensureNode();

		// Silence anything in flight, then reset the input timeline to zero. `dropBuffers()` with
		// no argument is the full reset; with a number it only releases what is before that point.
		node.stop(ctx.currentTime);
		await node.dropBuffers();

		// Two channels at most: the node is built stereo, and the worklet indexes what it is given
		// as `audioBuffer[c % audioBuffer.length]`, so a mono file correctly feeds both sides.
		const channels: Float32Array[] = [];
		for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
			channels.push(buffer.getChannelData(c));
		}
		// No transfer list, so these are structured-cloned rather than detached and the AudioBuffer
		// survives long enough to be downmixed below.
		await node.addBuffers(channels);

		this.duration = buffer.duration;
		this.state.playing = false;
		this.state.loopA = null;
		this.state.loopB = null;
		this.state.looping = false;
		this.anchorInput = 0;
		this.anchorOutput = ctx.currentTime;

		return {
			name,
			duration: buffer.duration,
			sampleRate: buffer.sampleRate,
			peaksSource: downmix(buffer),
		};
	}

	async play(): Promise<void> {
		if (!this.node || !this.ctx) return;
		if (this.ctx.state === "suspended") await this.ctx.resume();
		// Starting from the very end would play silence forever. Go back to the top instead.
		if (!this.state.looping && this.anchorInput >= this.duration - 0.01) this.anchorInput = 0;
		this.state.playing = true;
		// ⚠️ Explicit input, not the interpolated one. While paused the anchor pair is frozen, so
		// `positionAt()` would measure the wall-clock time spent paused and start the song that far
		// in -- press play a minute after loading and you would land a minute deep.
		this.commit({ input: this.anchorInput });
	}

	pause(): void {
		if (!this.node || !this.state.playing) return;
		const at = this.ctx!.currentTime + LOOKAHEAD;
		const frozen = this.positionAt(at);
		this.state.playing = false;
		this.anchorInput = frozen;
		this.anchorOutput = at;
		this.node.schedule({ output: at, input: frozen, active: false });
	}

	toggle(): void {
		if (this.state.playing) this.pause();
		else void this.play();
	}

	seek(seconds: number): void {
		const to = clamp(seconds, 0, this.duration);
		this.commit({ input: to });
	}

	/** Move by a delta in *song* seconds, independent of the playback rate. */
	nudge(seconds: number): void {
		this.seek(this.position() + seconds);
	}

	setRate(rate: number): void {
		this.state.rate = clamp(rate, 0.25, 1.5);
		this.commit({});
	}

	setSemitones(semitones: number): void {
		this.state.semitones = clamp(semitones, -12, 12);
		this.commit({});
	}

	/**
	 * Sets the loop region. Pass nulls to clear it.
	 *
	 * A→B looping is the engine's own `loopStart`/`loopEnd`, not something we time on the main
	 * thread -- which is why the seam is sample-accurate and why Test F cleared it of the crackle.
	 */
	setLoop(a: number | null, b: number | null): void {
		if (a === null || b === null) {
			this.state.loopA = a;
			this.state.loopB = b;
			this.state.looping = false;
		} else {
			this.state.loopA = clamp(Math.min(a, b), 0, this.duration);
			this.state.loopB = clamp(Math.max(a, b), 0, this.duration);
			this.state.looping = this.state.loopB - this.state.loopA >= MIN_LOOP;
		}
		this.commit({});
	}

	setLooping(on: boolean): void {
		if (on && !this.hasLoop()) return;
		this.state.looping = on;
		this.commit({});
	}

	hasLoop(): boolean {
		const { loopA, loopB } = this.state;
		return loopA !== null && loopB !== null && loopB - loopA >= MIN_LOOP;
	}

	/**
	 * Where the engine is *now*, in song seconds.
	 *
	 * Derived from the segment we last scheduled rather than from the worklet's `inputTime`
	 * messages: we know the input position and the output time we asked for, and rate is constant
	 * in between, so the arithmetic is the same arithmetic the worklet does -- with no message
	 * latency and no 100 ms quantisation. `baseLatency` is subtracted because the samples leaving
	 * the node still have the output buffer to cross before anyone hears them.
	 */
	position(): number {
		if (!this.ctx) return this.anchorInput;
		if (!this.state.playing) return this.anchorInput;
		return this.positionAt(this.ctx.currentTime - this.ctx.baseLatency);
	}

	/** Call once per frame while playing: stops the transport when the song runs out. */
	tick(): void {
		if (!this.state.playing || this.state.looping) return;
		if (this.position() >= this.duration - 0.005) {
			this.pause();
			this.anchorInput = this.duration;
			this.onEnded?.();
		}
	}

	/** Whatever the underrun meter last reported, or an honest "no data". */
	loadReading(): string {
		return this.meter?.read() ?? "engine idle";
	}

	async destroy(): Promise<void> {
		this.meter?.stop();
		this.meter = null;
		this.node = null;
		this.gain = null;
		// The only way to retire a leaked processor. Everything else in this file depends on it.
		try {
			await this.ctx?.close();
		} catch {
			/* already closed */
		}
		this.ctx = null;
	}

	// ------------------------------------------------------------------ internals

	/** Position the engine will be at at output time `t`, wrapped into the loop the way it wraps. */
	private positionAt(t: number): number {
		const raw = this.anchorInput + (t - this.anchorOutput) * this.state.rate;
		return this.wrap(raw);
	}

	private wrap(t: number): number {
		const { looping, loopA, loopB } = this.state;
		if (!looping || loopA === null || loopB === null) return clamp(t, 0, this.duration);
		const length = loopB - loopA;
		if (length < MIN_LOOP || t < loopB) return clamp(t, 0, this.duration);
		return loopA + ((t - loopA) % length);
	}

	/**
	 * Pushes the whole transport state to the node as one scheduled segment and re-anchors.
	 *
	 * Every control goes through here so there is exactly one place where our mirror of the time
	 * map and the worklet's copy of it can disagree.
	 */
	private commit(patch: { input?: number }): void {
		if (!this.node || !this.ctx) return;
		const at = this.ctx.currentTime + LOOKAHEAD;
		const input = patch.input ?? (this.state.playing ? this.positionAt(at) : this.anchorInput);
		const { loopA, loopB, looping } = this.state;

		this.node.schedule({
			output: at,
			input,
			active: this.state.playing,
			rate: this.state.rate,
			semitones: this.state.semitones,
			// Equal values disable looping, which is the library's own switch for it.
			loopStart: looping && loopA !== null ? loopA : 0,
			loopEnd: looping && loopB !== null ? loopB : 0,
		});

		this.anchorInput = input;
		this.anchorOutput = at;
	}

	private async context(): Promise<AudioContext> {
		if (!this.ctx) {
			this.ctx = new AudioContext({ latencyHint: "playback" });
			this.meter = new LoadMeter(this.ctx);
		}
		if (this.ctx.state === "suspended") await this.ctx.resume();
		return this.ctx;
	}

	private async ensureNode(): Promise<StretchNode> {
		if (this.node) return this.node;
		const ctx = await this.context();

		/**
		 * ⚠️ `numberOfInputs` **must be 1**, even though nothing is ever connected to it.
		 *
		 * The library's worklet reads `inputList[0][c % inputs.length]` on every render quantum
		 * where the current segment is inactive -- which includes every quantum between
		 * `connect()` and the moment a scheduled segment takes effect. With zero declared inputs
		 * the browser passes `[]`, `inputList[0]` is `undefined`, and that line throws a TypeError
		 * on the audio thread. The processor is then retired permanently and lies about it: the
		 * node stays alive, its port still answers, `latency()` returns a plausible number, and the
		 * output is silence forever. `processorerror` does not fire.
		 *
		 * Do not "optimise" this to 0 on the grounds that the node has no input.
		 */
		const node = await SignalsmithStretch(ctx, {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2],
		});

		node.configure(ENGINE_CONFIG);

		this.gain = ctx.createGain();
		node.connect(this.gain);
		this.gain.connect(ctx.destination);

		this.node = node;
		this.meter?.start();
		return node;
	}
}

/**
 * The only instrument here that can see a dropout.
 *
 * Anything tapping between the engine and `ctx.destination` measures the graph, and an underrun
 * happens *after* the graph -- which is how six instruments in a row read clean while the fault was
 * plainly audible. `renderCapacity.underrunRatio` reports from the far side of that line.
 *
 * ⚠️ Feature-detected, and a missing meter reads as "no data", never as a pass. It is Web Audio 1.1
 * and Chrome-only at the time of writing, so the iPad will most likely report nothing at all.
 */
class LoadMeter {
	private capacity: RenderCapacity | null;
	private peak = 0;
	private average = 0;
	private underrun = 0;
	private updates = 0;
	private running = false;

	private onUpdate = (event: Event) => {
		const e = event as unknown as { averageLoad: number; peakLoad: number; underrunRatio: number };
		this.updates++;
		this.average = e.averageLoad;
		this.peak = Math.max(this.peak, e.peakLoad);
		this.underrun = Math.max(this.underrun, e.underrunRatio);
	};

	constructor(ctx: AudioContext) {
		this.capacity = (ctx as unknown as { renderCapacity?: RenderCapacity }).renderCapacity ?? null;
	}

	start(): void {
		if (!this.capacity || this.running) return;
		try {
			this.capacity.addEventListener("update", this.onUpdate);
			this.capacity.start({ updateInterval: 0.5 });
			this.running = true;
		} catch {
			this.capacity = null;
		}
	}

	stop(): void {
		if (!this.capacity || !this.running) return;
		try {
			this.capacity.stop();
			this.capacity.removeEventListener("update", this.onUpdate);
		} catch {
			/* the reading is already taken */
		}
		this.running = false;
	}

	/** Resets the high-water marks, so a bad passage can be attributed to what was just changed. */
	reset(): void {
		this.peak = 0;
		this.underrun = 0;
		this.updates = 0;
	}

	read(): string {
		if (!this.capacity) return "underruns: no meter on this platform";
		if (this.updates === 0) return "underruns: no data yet";
		return (
			`load ${(this.average * 100).toFixed(0)}% now, ${(this.peak * 100).toFixed(0)}% peak · ` +
			`underruns ${(this.underrun * 100).toFixed(2)}%${this.underrun > 0 ? " ← DROPOUTS" : ""}`
		);
	}
}

interface RenderCapacity extends EventTarget {
	start(options: { updateInterval: number }): void;
	stop(): void;
}

/** One channel of peaks-grade samples. Averaged, not summed, so a mono file reads the same. */
function downmix(buffer: AudioBuffer): Float32Array {
	const length = buffer.length;
	const out = new Float32Array(length);
	const channels = Math.min(2, buffer.numberOfChannels);
	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i < length; i++) out[i] += data[i];
	}
	if (channels > 1) for (let i = 0; i < length; i++) out[i] /= channels;
	return out;
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}
