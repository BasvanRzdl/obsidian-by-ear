/**
 * The video is a display, not a clock — and the only real judgement in it is when to yank the
 * picture back to where the sound is.
 *
 * Both directions of getting this wrong are bad in ways that are hard to spot in a quick try:
 * too tight and the decoder seeks every frame, which reads as a stutter rather than as a sync
 * problem; too loose and the hands are visibly behind the note. So the threshold is asserted.
 */
import assert from "node:assert/strict";
import { needsSeek, DRIFT_TOLERANCE, SEEK_DEADBAND } from "./video.bundle.mjs";

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };

check("a frame or two of drift is left alone while playing", () => {
  for (const d of [0, 0.016, 0.033, 0.066, 0.1]) {
    assert.equal(needsSeek(d, true), false, `${d}s should not seek`);
    assert.equal(needsSeek(-d, true), false, `${-d}s should not seek`);
  }
});

check("real slippage is corrected, in both directions", () => {
  for (const d of [0.2, 0.5, 3]) {
    assert.equal(needsSeek(d, true), true);
    assert.equal(needsSeek(-d, true), true, "a picture running ahead matters as much as one behind");
  }
});

check("paused is held tighter than playing", () => {
  assert.ok(SEEK_DEADBAND < DRIFT_TOLERANCE);
  // Scrubbing while paused must land exactly: there is no stutter to trade against.
  assert.equal(needsSeek(0.06, false), true);
  assert.equal(needsSeek(0.06, true), false);
});

check("the tolerance stays wider than a 30fps frame and tighter than perception", () => {
  assert.ok(DRIFT_TOLERANCE > 1 / 30, "correcting sub-frame error only causes stutter");
  assert.ok(DRIFT_TOLERANCE <= 0.125, "beyond ~125ms a picture reads as out of sync");
});

console.log(`\n${passed} checks passed`);
