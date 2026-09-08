/**
 * Call & response — the arithmetic, on its own so it can be tested.
 *
 * S1 in the spec, and the reason Phase 5 exists at all: play the loop, then leave an *equal*
 * silence to answer into. Hum it, hunt it, and the next pass tells you whether you were right.
 *
 * ⚠️ The whole feature is a gate on the output gain, and nothing else. The loop keeps running
 * underneath the silence, on the worklet's own sample-accurate `loopStart`/`loopEnd`, so the
 * answering gap is exactly as long as the phrase and lands exactly on the seam. What is switched
 * is whether you can hear it.
 *
 * That is the second design. The first was to schedule the silence into the engine's time map --
 * a play segment, then an inactive one, then the next play segment -- and it cannot be built:
 * `schedule()` prunes every queued segment whose output time is at or after its reference time
 * (`SignalsmithStretch.mjs:88`), so a second queued event silently deletes the first. The
 * library's own `start(when, offset, duration)` has the same bug for the same reason. Reading that
 * loop is what turned a fiddly scheduler into a gain ramp.
 *
 * The playhead sweeps the loop during the silent pass, which is a small gift rather than a cost:
 * you can see where you are while you answer.
 */

/** A moment on the AudioContext clock where the gate flips, and what it flips to. */
export interface Switch {
	/** Output-clock time, the same clock `AudioContext.currentTime` is on. */
	at: number;
	/** True when the loop is heard from here, false while it is left silent to answer into. */
	audible: boolean;
}

/**
 * A pass shorter than this makes a gate that chatters rather than a phrase you can answer.
 * At 25% tempo -- the slowest the engine goes -- that is a 62 ms phrase, which is not one.
 */
export const MIN_PASS = 0.25;

/** Never plan more than this many switches, whatever the arithmetic says. */
const MAX_SWITCHES = 128;

export interface GateInput {
	/** Where the output clock is now. */
	now: number;
	/** Where the playhead is, in song seconds. */
	position: number;
	/** Playback rate: 0.5 is half speed, so a pass takes twice as long to hear. */
	rate: number;
	loopA: number;
	loopB: number;
	/** How far ahead to plan, in output seconds. */
	horizon: number;
	/** Whether the pass in progress is being heard. The first switch is always its opposite. */
	audible: boolean;
}

/** How long one pass of the loop lasts in real time, which is not its length in the song. */
export function passLength(loopA: number, loopB: number, rate: number): number {
	const length = loopB - loopA;
	if (!(length > 0) || !(rate > 0) || !isFinite(length) || !isFinite(rate)) return 0;
	return length / rate;
}

/**
 * Every gate flip between `now` and `now + horizon`, alternating from the pass in progress.
 *
 * Planned far ahead rather than one flip at a time on purpose: the pump runs on
 * `requestAnimationFrame`, and a browser that stops painting -- Obsidian behind another window,
 * an iPad with the screen off -- would otherwise leave the gate wherever it last landed, which is
 * silence half the time. A long horizon means the plan outlives the pause in painting.
 */
export function responseSwitches(input: GateInput): Switch[] {
	const pass = passLength(input.loopA, input.loopB, input.rate);
	if (pass < MIN_PASS || !(input.horizon > 0)) return [];

	// Time to the seam. The position is already wrapped into the loop by the caller, so this is
	// normally in (0, pass] -- the modulo only catches a playhead left outside the region.
	let ahead = (input.loopB - input.position) / input.rate;
	if (!isFinite(ahead)) return [];
	if (ahead <= 0) ahead = pass - ((-ahead) % pass);

	const switches: Switch[] = [];
	let at = input.now + ahead;
	let audible = input.audible;
	const until = input.now + input.horizon;
	while (at <= until && switches.length < MAX_SWITCHES) {
		audible = !audible;
		switches.push({ at, audible });
		at += pass;
	}
	return switches;
}

/** What the gate is doing at `t`, given a plan and the state it started in. */
export function audibleAt(switches: Switch[], startAudible: boolean, t: number): boolean {
	let audible = startAudible;
	for (const s of switches) {
		if (s.at > t) break;
		audible = s.audible;
	}
	return audible;
}
