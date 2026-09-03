// Verifies the new frequency estimator against known tones, and compares it to the old
// bin-argmax + parabolic-interpolation ruler it replaces.
//
// Uses a plain DFT for the "analyser" seed rather than a real FFT: slow, but this only runs a
// handful of times and it removes any doubt about the seed being the thing under test.

const SAMPLE_RATE = 44100;
const FFT_SIZE = 32768;

function magnitudeAt(samples, frequency, sampleRate) {
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

// Stand-in for AnalyserNode.getFloatFrequencyData: Blackman window, dB magnitudes, as the spec says.
function spectrumDb(samples) {
  const n = samples.length;
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / (n - 1);
    windowed[i] = samples[i] * (0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x));
  }
  const bins = new Float64Array(n / 2);
  for (let k = 0; k < bins.length; k++) {
    bins[k] = 20 * Math.log10(magnitudeAt(windowed, (k * SAMPLE_RATE) / n, SAMPLE_RATE) / n + 1e-30);
  }
  return bins;
}

function oldRuler(bins) {
  let peak = 1;
  for (let i = 1; i < bins.length - 1; i++) if (bins[i] > bins[peak]) peak = i;
  const a = bins[peak - 1], b = bins[peak], c = bins[peak + 1];
  const denominator = a - 2 * b + c;
  const offset = denominator === 0 ? 0 : (0.5 * (a - c)) / denominator;
  return ((peak + offset) * SAMPLE_RATE) / FFT_SIZE;
}

function newRuler(samples, seedHz) {
  const n = samples.length;
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    windowed[i] = samples[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  const binWidth = SAMPLE_RATE / FFT_SIZE;
  let low = Math.max(binWidth, seedHz - 2 * binWidth);
  let high = seedHz + 2 * binWidth;
  let iterations = 0;
  for (let i = 0; i < 60 && high - low > 1e-4; i++) {
    iterations++;
    const a = low + (high - low) / 3;
    const b = high - (high - low) / 3;
    if (magnitudeAt(windowed, a, SAMPLE_RATE) < magnitudeAt(windowed, b, SAMPLE_RATE)) low = a;
    else high = b;
  }
  return { hz: (low + high) / 2, iterations };
}

const cents = (measured, truth) => 1200 * Math.log2(measured / truth);

// The two pitches Test A actually reads, plus a worst case: a tone sitting exactly halfway
// between two bins, where interpolation error peaks.
const binWidth = SAMPLE_RATE / FFT_SIZE;
const cases = [
  ["reference (unshifted)", 440],
  ["shifted −37 cents", 440 * Math.pow(2, -0.37 / 12)],
  ["worst case: half-bin offset", (326 + 0.5) * binWidth],
  ["with 1% harmonic + noise", 440 * Math.pow(2, -0.37 / 12)],
];

console.log(`bin width ${binWidth.toFixed(4)} Hz = ${cents(440 + binWidth, 440).toFixed(2)} cents at 440 Hz\n`);
console.log("case                          truth Hz    old ruler        new ruler");
console.log("-".repeat(78));

for (const [label, truth] of cases) {
  const dirty = label.includes("noise");
  const samples = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    const phase = (2 * Math.PI * truth * i) / SAMPLE_RATE;
    samples[i] = 0.5 * Math.sin(phase + 0.3);
    if (dirty) samples[i] += 0.005 * Math.sin(2 * phase) + 0.002 * (Math.random() - 0.5);
  }

  const bins = spectrumDb(samples);
  const old = oldRuler(bins);
  const seed = (bins.reduce((best, v, i) => (v > bins[best] ? i : best), 1) * SAMPLE_RATE) / FFT_SIZE;
  const fresh = newRuler(samples, seed);

  console.log(
    label.padEnd(30) +
      truth.toFixed(3).padStart(9) +
      `  ${old.toFixed(3)} (${cents(old, truth) >= 0 ? "+" : ""}${cents(old, truth).toFixed(2)} ¢)`.padEnd(17) +
      `  ${fresh.hz.toFixed(4)} (${cents(fresh.hz, truth) >= 0 ? "+" : ""}${cents(fresh.hz, truth).toFixed(3)} ¢, ${fresh.iterations} its)`
  );
}

// And the number that actually matters: the reported delta between the two reads.
console.log("\nThe measurement Test A reports — delta between the two reads, asked for −37.00:");
for (const ruler of ["old", "new"]) {
  const reads = [440, 440 * Math.pow(2, -0.37 / 12)].map((truth) => {
    const samples = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      samples[i] = 0.5 * Math.sin((2 * Math.PI * truth * i) / SAMPLE_RATE + 0.3);
    }
    const bins = spectrumDb(samples);
    if (ruler === "old") return oldRuler(bins);
    const seed = (bins.reduce((best, v, i) => (v > bins[best] ? i : best), 1) * SAMPLE_RATE) / FFT_SIZE;
    return newRuler(samples, seed).hz;
  });
  const delta = cents(reads[1], reads[0]);
  console.log(`  ${ruler.padEnd(4)} ruler: ${delta.toFixed(2)} cents  (error ${(delta + 37).toFixed(2)} ¢)`);
}
