import SignalsmithStretch, { StretchNode } from "signalsmith-stretch";
import { ChannelMode, channelMatrix } from "./channels";
import { MIN_PASS, Switch, audibleAt, passLength, responseSwitches } from "./callresponse";
import { buildPyramid } from "./waveform";

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

/**
 * Call & response, in seconds.
 *
 * The horizon is long on purpose. The pump runs on `requestAnimationFrame`, and a browser that
 * stops painting -- Obsidian behind another window, an iPad whose screen has gone off while the
 * music keeps playing -- would leave the gate wherever it last landed. Twelve seconds of plan
 * outlives that; the cost is a few dozen automation events, which is nothing.
 *
 * The ramp is what keeps the gate from clicking. 8 ms is inaudible as a fade and comfortably
 * longer than the discontinuity it covers.
 */
const CR_HORIZON = 12;
const CR_MARGIN = 6;
const CR_RAMP = 0.008;

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
	/** 1 or 2. A mono file is shown no channel controls at all -- there is nothing to separate. */
	channels: number;
	/**
	 * The waveform's min/max pyramid, built here so no sample-grade array outlives the decode.
	 *
	 * This used to be `peaksSource`, a full mono downmix -- 219 MB for the 19-minute Woodstock
	 * file, on top of the copy the worklet holds and the decoded buffer it came from, and held by
	 * the caller for the whole of opening a song. About 8 MB now, and gone from every scope but
	 * the waveform's.
	 */
	pyramid: Float32Array[];
	totalSamples: number;
	/** What this song costs while it is open, in bytes. Arithmetic, not a measurement. */
	bytesHeld: number;
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
	/**
	 * The output gain, and the only thing call & response touches.
	 *
	 * Everything the player does to the sound after the stretcher hangs off these two: the mixer
	 * matrix, then this. `node -> splitter -> 4 gains -> merger -> master -> volume -> destination`.
	 */
	private master: GainNode | null = null;
	/**
	 * The listener's volume, after everything else.
	 *
	 * Its own node rather than a factor folded into `master`, because the call & response gate
	 * cancels and rewrites `master`'s schedule constantly -- a volume living there would be
	 * overwritten on the next pass. Two nodes, two owners, no shared parameter.
	 */
	private volumeNode: GainNode | null = null;
	/** 0..1 as the slider reads it. Kept so a node built later starts at the right level. */
	private level = 1;
	private muted = false;
	/** The 2x2 mixer, indexed `[out * 2 + in]` to match `channelMatrix()`. */
	private mix: GainNode[] = [];

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

	private channelMode: ChannelMode = "stereo";
	/** Call & response: armed by the user, and only actually gating while a loop is running. */
	private cr = false;
	/** The gate plan, and the state it started in. Both are needed to answer "audible right now?". */
	private crSwitches: Switch[] = [];
	private crFrom = { at: 0, audible: true };

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
		// ⚠️ No transfer list, so these are structured-cloned rather than detached -- which is what
		// keeps the AudioBuffer readable long enough to build the pyramid from it below. It also
		// means both copies exist at once, and for a 19-minute file that is 438 MB twice over. That
		// is the part of risk 4 still standing: undoing it needs a decoder that can be fed a range
		// of the file, and `decodeAudioData` only takes the whole thing.
		await node.addBuffers(channels);

		/*
		 * The pyramid is built here, from the very arrays just handed to the worklet, and the
		 * decoded buffer dies with this method.
		 *
		 * ⚠️ Ordering is the whole trick. Built from `channels` rather than from a mono downmix,
		 * nothing full-length is allocated; built *inside* `load()`, nothing sample-grade is
		 * returned. Before this, opening the Woodstock file allocated a 219 MB downmix and the
		 * caller then held it through the video load and two vault round-trips.
		 */
		const pyramid = buildPyramid(channels, buffer.length);

		this.duration = buffer.duration;
		this.state.playing = false;
		this.state.loopA = null;
		this.state.loopB = null;
		this.state.looping = false;
		this.anchorInput = 0;
		this.anchorOutput = ctx.currentTime;
		// A new song is heard, whatever the last one was left doing.
		this.cr = false;
		this.planCallResponse(true);

		return {
			name,
			duration: buffer.duration,
			sampleRate: buffer.sampleRate,
			channels: buffer.numberOfChannels,
			pyramid,
			totalSamples: buffer.length,
			// The worklet's copy plus the pyramid: what is still resident once the decode is
			// collected. Computed, never measured -- there is no heap instrument on iOS, and a
			// silent one reads as a clean one.
			bytesHeld:
				buffer.length * channels.length * 4 + pyramid.reduce((n, level) => n + level.byteLength, 0),
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
		// ⚠️ Never leave the gate closed on a paused player: pressing play would then be silent
		// until the next seam, which is the silent-no-op shape this project keeps relearning.
		this.planCallResponse(true);
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

	// ------------------------------------------------------------------ the loop features

	get mode(): ChannelMode {
		return this.channelMode;
	}

	/**
	 * Which channels reach both ears.
	 *
	 * Ramped rather than set, because a step in gain on a running signal is a click. 10 ms is
	 * below the ear's resolution for a level change and above the sample rate's for a jump.
	 */
	setChannelMode(mode: ChannelMode): void {
		this.channelMode = mode;
		if (!this.ctx || this.mix.length !== 4) return;
		const matrix = channelMatrix(mode);
		const now = this.ctx.currentTime;
		for (let out = 0; out < 2; out++) {
			for (let input = 0; input < 2; input++) {
				this.mix[out * 2 + input]?.gain.setTargetAtTime(matrix[out][input], now, 0.01);
			}
		}
	}

	get volume(): number {
		return this.level;
	}

	get isMuted(): boolean {
		return this.muted;
	}

	/**
	 * Volume, 0..1, as a fraction of the slider's travel.
	 *
	 * Squared on the way to the gain, because loudness is heard roughly logarithmically: a linear
	 * gain puts all the useful range in the bottom fifth of the slider, and halfway sounds barely
	 * quieter than full. Never above 1 -- a boost would clip, and the device has its own volume.
	 *
	 * Web Audio rather than `HTMLMediaElement.volume`, which iOS ignores entirely: on an iPad or an
	 * iPhone this gain is the only in-app volume there can be.
	 */
	setVolume(level: number): void {
		this.level = Math.min(1, Math.max(0, level));
		this.applyVolume();
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		this.applyVolume();
	}

	private applyVolume(): void {
		if (!this.ctx || !this.volumeNode) return;
		const target = this.muted ? 0 : this.level * this.level;
		// Ramped for the same reason as the mixer: a step on a running signal is a click.
		this.volumeNode.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01);
	}

	get callResponse(): boolean {
		return this.cr;
	}

	/**
	 * Whether a gap long enough to answer into can be made from the loop as it stands.
	 *
	 * A pass is measured in real time, not song time, so slowing down lengthens it -- a two-bar
	 * phrase at 50% is twice the gap. Below a quarter of a second it is a stutter, not a phrase.
	 */
	get callResponseReady(): boolean {
		const { loopA, loopB, rate } = this.state;
		if (loopA === null || loopB === null) return false;
		return passLength(loopA, loopB, rate) >= MIN_PASS;
	}

	/** True while the loop is running silently, waiting for an answer. */
	get responding(): boolean {
		if (!this.cr || !this.state.playing || !this.state.looping || !this.ctx) return false;
		return !audibleAt(this.crSwitches, this.crFrom.audible, this.ctx.currentTime);
	}

	setCallResponse(on: boolean): void {
		this.cr = on;
		this.planCallResponse(true);
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

	/** Call once per frame while playing: keeps the gate planned, and stops at the end of the song. */
	tick(): void {
		if (!this.state.playing) return;
		this.planCallResponse(false);
		if (this.state.looping) return;
		if (this.position() >= this.duration - 0.005) {
			this.pause();
			this.anchorInput = this.duration;
			this.onEnded?.();
		}
	}

	async destroy(): Promise<void> {
		this.node = null;
		this.master = null;
		this.volumeNode = null;
		this.mix = [];
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

		// ⚠️ Rebuilt, not extended, and it restarts on a heard pass. Every change of tempo, pitch,
		// loop or position invalidates the arithmetic the plan was built from -- and "change
		// something and you hear the next pass" is a rule worth being able to state in one line.
		this.planCallResponse(true);
	}

	/**
	 * Writes the gate onto the output gain, ahead of time, on the audio clock.
	 *
	 * `rebuild` is the difference between "something changed, work it out again" and the pump's
	 * "top the plan up before it runs out". A rebuild always lands on a heard pass, so the answer
	 * to "why did it go quiet?" is never something the user has to reconstruct.
	 *
	 * ⚠️ `cancelScheduledValues` alone does not stop a ramp already under way, and
	 * `cancelAndHoldAtTime` is not something an iPad WebView can be relied on for -- so the current
	 * value is read and pinned by hand before anything new is written. Without the pin, a cancel
	 * mid-fade leaves the gain at an arbitrary level for ever.
	 */
	private planCallResponse(rebuild: boolean): void {
		const param = this.master?.gain;
		if (!param || !this.ctx) return;
		const now = this.ctx.currentTime;
		const { loopA, loopB, looping, playing, rate } = this.state;
		const gating = this.cr && playing && looping && this.callResponseReady;

		if (!gating) {
			// Nothing to undo: leave the parameter alone rather than writing an event per frame.
			if (this.crSwitches.length === 0 && this.crFrom.audible) return;
			param.cancelScheduledValues(now);
			param.setValueAtTime(param.value, now);
			param.linearRampToValueAtTime(1, now + CR_RAMP);
			this.crSwitches = [];
			this.crFrom = { at: now, audible: true };
			return;
		}

		const planned = this.crSwitches[this.crSwitches.length - 1];
		if (!rebuild && planned && planned.at > now + CR_MARGIN) return;

		const audible = rebuild ? true : audibleAt(this.crSwitches, this.crFrom.audible, now);
		param.cancelScheduledValues(now);
		param.setValueAtTime(param.value, now);
		param.linearRampToValueAtTime(audible ? 1 : 0, now + CR_RAMP);

		const switches = responseSwitches({
			now,
			// ⚠️ NOT `position()`, and the difference is the point. `position()` answers "what am I
			// hearing", so it subtracts the output latency; these samples have not been heard yet.
			// The gate acts on audio as it passes the gain node, so it has to be timed against the
			// samples in the graph right now -- otherwise every flip lands `baseLatency` early.
			//
			// It is also exactly right across a scheduled change: extrapolating the newly scheduled
			// segment back over the lookahead gap gives the same arrival time at the seam that the
			// worklet will produce, even when the change was a seek to somewhere else entirely.
			position: this.positionAt(now),
			rate,
			loopA: loopA as number,
			loopB: loopB as number,
			horizon: CR_HORIZON,
			audible,
		});
		for (const flip of switches) {
			// The ramp begins *at* the seam rather than before it, so a call is never clipped short
			// -- the 8 ms of fade is spent on the front of the silence, where there is nothing to
			// lose.
			param.setValueAtTime(flip.audible ? 0 : 1, flip.at);
			param.linearRampToValueAtTime(flip.audible ? 1 : 0, flip.at + CR_RAMP);
		}
		this.crSwitches = switches;
		this.crFrom = { at: now, audible };
	}

	private async context(): Promise<AudioContext> {
		if (!this.ctx) {
			this.ctx = new AudioContext({ latencyHint: "playback" });
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

		/*
		 * node -> splitter -> four gains -> merger -> master -> volume -> destination.
		 *
		 * The four gains are a 2x2 matrix, which is enough for all five channel modes without the
		 * graph ever changing shape: only its numbers move, and they move on ramps. `side` needs the
		 * negative coefficient, which is why this is a matrix and not a pair of switches.
		 *
		 * The master is separate from the matrix because call & response has to be able to close the
		 * gate without disturbing which channels are selected, and vice versa.
		 */
		const splitter = ctx.createChannelSplitter(2);
		const merger = ctx.createChannelMerger(2);
		this.mix = [];
		for (let out = 0; out < 2; out++) {
			for (let input = 0; input < 2; input++) {
				const gain = ctx.createGain();
				gain.gain.value = out === input ? 1 : 0;
				splitter.connect(gain, input);
				gain.connect(merger, 0, out);
				this.mix[out * 2 + input] = gain;
			}
		}

		this.master = ctx.createGain();
		this.volumeNode = ctx.createGain();
		this.volumeNode.gain.value = this.muted ? 0 : this.level * this.level;
		node.connect(splitter);
		merger.connect(this.master);
		this.master.connect(this.volumeNode);
		this.volumeNode.connect(ctx.destination);
		// A song opened with a mode already chosen should sound the way the button says it does.
		this.setChannelMode(this.channelMode);

		this.node = node;
		return node;
	}
}

/**
 * ⚠️ THERE IS NO DROPOUT INSTRUMENT ON THIS PLATFORM. Measured, not assumed -- 4 September 2026.
 *
 * A `LoadMeter` used to live here, reading `AudioContext.renderCapacity.underrunRatio`: the one
 * number visible from the far side of `ctx.destination`, where an underrun actually happens.
 * Every other analyser taps before that line, which is how six instruments in a row read clean
 * through an evening of audible crackle.
 *
 * It never once reported. Obsidian 1.12.7 runs Electron 39 / Chromium 142, and that build has no
 * `AudioRenderCapacity` at all: `peakLoad`, `averageLoad` and `underrunRatio` are absent from the
 * framework binary while every control symbol (`baseLatency`, `audioWorklet`, `decodeAudioData`)
 * is present. iOS WKWebView does not have it either. So the cure the spike wrote down was never
 * administered, and the meter said so honestly -- "no data" was the truth, not a pass.
 *
 * It is deleted rather than left on screen dark, because a permanently silent instrument reads as
 * a clean one. **On this platform Bas's ear is the instrument.** If a dropout detector is ever
 * needed again, the honest path is a message channel from inside the worklet (nothing listens to
 * one today) -- and it must be validated by inducing a real dropout (`splitComputation: false`
 * reproduces Test J2's crackle) before a single reading from it is believed.
 */

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value));
}
