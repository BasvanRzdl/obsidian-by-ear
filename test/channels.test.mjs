/**
 * The mixer is four numbers, and a sign error in one of them is the difference between "the centre
 * is cancelled" and "the mix is quieter". Both sound plausible through a laptop speaker, so the
 * matrix is checked arithmetically rather than by ear.
 */
import { CHANNEL_LABELS, CHANNEL_MODES, CHANNEL_NAMES, channelMatrix } from "./channels.bundle.mjs";

let failed = 0;
let ran = 0;
// Counted rather than written down: this suite's total was wrong within an hour of being written.
function ok(what, cond) {
	ran++;
	console.log(`  ${cond ? "ok " : "FAIL"}  ${what}`);
	if (!cond) failed++;
}

/** What comes out of both ears for a given sample pair. */
function mix(mode, l, r) {
	const m = channelMatrix(mode);
	return [m[0][0] * l + m[0][1] * r, m[1][0] * l + m[1][1] * r];
}
function same(pair, [l, r]) {
	return Math.abs(pair[0] - l) < 1e-9 && Math.abs(pair[1] - r) < 1e-9;
}

ok("stereo is the recording, untouched", same(mix("stereo", 0.8, -0.3), [0.8, -0.3]));
ok("left puts the left channel in both ears", same(mix("left", 0.8, -0.3), [0.8, 0.8]));
ok("...and none of the right one", same(mix("left", 0, 1), [0, 0]));
ok("right puts the right channel in both ears", same(mix("right", 0.8, -0.3), [-0.3, -0.3]));
ok("mono sums the two without clipping them together", same(mix("mono", 1, 1), [1, 1]));
ok("...and is the average, not the sum", same(mix("mono", 1, 0), [0.5, 0.5]));

// The one that earns the feature: on 1960s stereo the guitar is often hard on one side.
ok("side cancels whatever sits in the centre", same(mix("side", 0.7, 0.7), [0, 0]));
ok("side keeps what is only on one side", same(mix("side", 1, 0), [0.5, 0.5]));
ok("side is a subtraction, so the right side comes back inverted", same(mix("side", 0, 1), [-0.5, -0.5]));
ok("side of silence is silence", same(mix("side", 0, 0), [0, 0]));

ok("mono and side are complementary halves of the same pair", same(mix("mono", 0.4, 0.2), [0.3, 0.3]) && same(mix("side", 0.4, 0.2), [0.1, 0.1]));

ok("no mode can make a signal louder than the loudest channel it was given",
	CHANNEL_MODES.every((mode) => {
		const [l, r] = mix(mode, 1, 1);
		return Math.abs(l) <= 1 + 1e-9 && Math.abs(r) <= 1 + 1e-9;
	})
);
ok("every mode is a finite 2x2", CHANNEL_MODES.every((mode) => channelMatrix(mode).flat().every(Number.isFinite) && channelMatrix(mode).flat().length === 4));
ok("every mode has a label short enough for a 44px button", CHANNEL_MODES.every((mode) => CHANNEL_LABELS[mode] && CHANNEL_LABELS[mode].length <= 6));
ok("every mode has an accessible name that is not the label again", CHANNEL_MODES.every((mode) => CHANNEL_NAMES[mode] && CHANNEL_NAMES[mode] !== CHANNEL_LABELS[mode]));
ok("stereo is first, because it is the one you start in", CHANNEL_MODES[0] === "stereo");

if (failed) {
	console.error(`\n${failed} check(s) failed`);
	process.exit(1);
}
console.log(`\n${ran - failed} checks passed`);
