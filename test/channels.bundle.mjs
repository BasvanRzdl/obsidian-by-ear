// src/player/channels.ts
var CHANNEL_MODES = ["stereo", "left", "right", "mono", "side"];
var CHANNEL_LABELS = {
  stereo: "Stereo",
  left: "L",
  right: "R",
  mono: "Mono",
  side: "Side"
};
var CHANNEL_NAMES = {
  stereo: "Both channels as recorded",
  left: "Left channel in both ears",
  right: "Right channel in both ears",
  mono: "Both channels summed",
  side: "Left minus right \u2014 cancels whatever sits in the centre"
};
function channelMatrix(mode) {
  switch (mode) {
    case "left":
      return [
        [1, 0],
        [1, 0]
      ];
    case "right":
      return [
        [0, 1],
        [0, 1]
      ];
    // Halved, not summed: two correlated channels at full gain clip, and the point of the
    // control is to hear the mix rather than to make it louder.
    case "mono":
      return [
        [0.5, 0.5],
        [0.5, 0.5]
      ];
    case "side":
      return [
        [0.5, -0.5],
        [0.5, -0.5]
      ];
    case "stereo":
    default:
      return [
        [1, 0],
        [0, 1]
      ];
  }
}
export {
  CHANNEL_LABELS,
  CHANNEL_MODES,
  CHANNEL_NAMES,
  channelMatrix
};
