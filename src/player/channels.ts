/**
 * The channel mixer -- S3, and the cheapest large payoff in the spec.
 *
 * Hendrix-era stereo is wide to the point of eccentricity: on a 1968 mix the guitar can sit almost
 * entirely on one side, with the drums on the other. Being able to take one side, or to subtract
 * one from the other, is often the difference between hearing a part and guessing at it. On this
 * repertoire it does more than any filter.
 *
 * Five modes, one 2x2 matrix of gains from the two input channels to the two output ones. It is
 * expressed as a matrix rather than five special cases because the graph that applies it is a
 * splitter, four gain nodes and a merger, and that graph never changes shape -- only its numbers.
 *
 * ⚠️ `side` is L - R, so it cancels whatever is equal in both channels: the centre, which is
 * usually the vocal, the bass and the snare. It is a subtraction, not an extraction, and on a mono
 * or a narrow mix it correctly leaves almost nothing. That is why a mono file shows no channel
 * controls at all rather than five buttons, four of which do nothing.
 *
 * ⚠️ And it sits *after* the stretcher, because the stretcher owns the buffers -- so at tempos
 * other than 100% the cancellation is as good as the engine's channel coherence, not perfect.
 * Mixing before the engine would be exact, and would cost a second copy of the song in memory plus
 * a reload on every press. The ear decides whether that trade was right; nothing else can.
 */

export type ChannelMode = "stereo" | "left" | "right" | "mono" | "side";

export const CHANNEL_MODES: ChannelMode[] = ["stereo", "left", "right", "mono", "side"];

/** Human labels, short enough for a 44 px target in a rail. */
export const CHANNEL_LABELS: Record<ChannelMode, string> = {
	stereo: "Stereo",
	left: "L",
	right: "R",
	mono: "Mono",
	side: "Side",
};

export const CHANNEL_NAMES: Record<ChannelMode, string> = {
	stereo: "Both channels as recorded",
	left: "Left channel in both ears",
	right: "Right channel in both ears",
	mono: "Both channels summed",
	side: "Left minus right — cancels whatever sits in the centre",
};

/**
 * Gains from each input channel to each output channel.
 *
 * `matrix[out][in]`, so `matrix[0][1]` is how much of the right input reaches the left output.
 */
export type ChannelMatrix = [[number, number], [number, number]];

export function channelMatrix(mode: ChannelMode): ChannelMatrix {
	switch (mode) {
		case "left":
			return [
				[1, 0],
				[1, 0],
			];
		case "right":
			return [
				[0, 1],
				[0, 1],
			];
		// Halved, not summed: two correlated channels at full gain clip, and the point of the
		// control is to hear the mix rather than to make it louder.
		case "mono":
			return [
				[0.5, 0.5],
				[0.5, 0.5],
			];
		case "side":
			return [
				[0.5, -0.5],
				[0.5, -0.5],
			];
		case "stereo":
		default:
			return [
				[1, 0],
				[0, 1],
			];
	}
}
