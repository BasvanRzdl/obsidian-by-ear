/**
 * The pyramid replaced the raw samples, so the picture has to be shown to survive the swap.
 *
 * Section 8's risk 4 traded 219 MB for about 8 MB on the Woodstock file. That is only a good trade
 * if what gets drawn is still the truth, so: level 0 must equal a direct min/max, every coarser
 * level must envelope the finer one it was folded from, and the saving must actually be there.
 */
import assert from "node:assert/strict";
import { buildPyramid, bucketSize, PYRAMID_BASE } from "./waveform.bundle.mjs";

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };

// A signal with structure at several scales: a slow swell carrying a fast tone, plus one lone spike
// that a lazy pyramid would smooth away.
const N = 44100 * 60;
const samples = new Float32Array(N);
for (let i = 0; i < N; i++) {
  samples[i] = Math.sin(i / 900) * 0.4 * Math.sin(i / (N / 6)) + Math.sin(i / 7) * 0.05;
}
samples[1234567] = 0.99;
samples[1234568] = -0.99;

const pyramid = buildPyramid([samples], N);

check("level 0 min/max equals a direct scan of the same bucket", () => {
  for (const b of [0, 17, 4321, Math.floor(N / PYRAMID_BASE) - 1]) {
    let min = 0, max = 0;
    for (let i = b * PYRAMID_BASE; i < Math.min(N, (b + 1) * PYRAMID_BASE); i++) {
      if (samples[i] < min) min = samples[i];
      else if (samples[i] > max) max = samples[i];
    }
    assert.equal(pyramid[0][b * 2], min, `bucket ${b} min`);
    assert.equal(pyramid[0][b * 2 + 1], max, `bucket ${b} max`);
  }
});

check("each coarser level envelopes the finer one — no peak is lost", () => {
  for (let l = 1; l < pyramid.length; l++) {
    const coarse = pyramid[l], fine = pyramid[l - 1];
    for (let b = 0; b < coarse.length / 2; b++) {
      let min = 0, max = 0;
      for (let k = b * 4; k < Math.min(fine.length / 2, b * 4 + 4); k++) {
        if (fine[k * 2] < min) min = fine[k * 2];
        if (fine[k * 2 + 1] > max) max = fine[k * 2 + 1];
      }
      assert.equal(coarse[b * 2], min);
      assert.equal(coarse[b * 2 + 1], max);
    }
  }
});

check("the lone spike survives to the coarsest level", () => {
  const top = pyramid[pyramid.length - 1];
  let max = 0, min = 0;
  for (let b = 0; b < top.length / 2; b++) {
    if (top[b * 2 + 1] > max) max = top[b * 2 + 1];
    if (top[b * 2] < min) min = top[b * 2];
  }
  assert.ok(max >= 0.99, "a transient must not be averaged away: got " + max);
  assert.ok(min <= -0.99, "and neither must its negative half");
});

check("bucket sizes step by four and start at the base", () => {
  assert.equal(bucketSize(0), PYRAMID_BASE);
  assert.equal(bucketSize(1), PYRAMID_BASE * 4);
  assert.equal(bucketSize(3), PYRAMID_BASE * 64);
});

// The builder takes channels and averages them a bucket at a time, precisely so that no
// full-length mono array is ever allocated to feed it. That saving is only free if the arithmetic
// is the same arithmetic — a downmix folded into a loop is exactly where an off-by-a-channel or a
// sum-instead-of-average hides, and neither would be visible in the picture.
check("two channels downmix to the same pyramid as their average", () => {
  const M = 44100 * 5;
  const left = new Float32Array(M);
  const right = new Float32Array(M);
  const mixed = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    left[i] = Math.sin(i / 300) * 0.7;
    // Deliberately not a copy of the left: a bug that reads channel 0 twice would pass otherwise.
    right[i] = Math.sin(i / 511) * 0.5 - 0.2;
    mixed[i] = (left[i] + right[i]) / 2;
  }
  const stereo = buildPyramid([left, right], M);
  const mono = buildPyramid([mixed], M);
  assert.equal(stereo.length, mono.length);
  for (let l = 0; l < stereo.length; l++) {
    for (let i = 0; i < stereo[l].length; i++) {
      // Not exact: the folded version keeps the average in double precision, while the mono array
      // rounds every sample to float32 first. One ulp apart, and only one of them is a real number.
      assert.ok(Math.abs(stereo[l][i] - mono[l][i]) < 1e-7, `level ${l} slot ${i}`);
    }
  }
});

check("a centred signal cancels in the downmix, the way the picture should show it", () => {
  const M = 4096;
  const a = new Float32Array(M);
  const b = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    a[i] = Math.sin(i / 20);
    b[i] = -a[i];
  }
  const flat = buildPyramid([a, b], M);
  assert.ok(flat[0].every((v) => Math.abs(v) < 1e-7), "out-of-phase channels average to nothing");
});

check("the whole pyramid costs a fraction of the samples", () => {
  const bytes = pyramid.reduce((n, l) => n + l.byteLength, 0);
  const ratio = samples.byteLength / bytes;
  assert.ok(ratio > 20, `expected a >20x saving, got ${ratio.toFixed(1)}x`);
  // What that means for the file this risk was raised about.
  const woodstock = 19 * 60 * 48000 * 4;
  console.log(`      → Woodstock: ${(woodstock / 1e6).toFixed(0)} MB of samples becomes ` +
    `${(woodstock / ratio / 1e6).toFixed(1)} MB of pyramid`);
});

console.log(`\n${passed} checks passed`);
