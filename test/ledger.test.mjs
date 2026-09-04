/**
 * The one thing this plugin must never do is damage a chart Bas reads on stage.
 *
 * So the write path is tested against a real chart copied out of the vault: round-trip it, and
 * assert that every byte above the marker is identical to what went in.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyLedger, splitAtMarker, parseBelow, LEDGER_MARKER, sittingLine } from "./ledger.bundle.mjs";

const chart = fs.readFileSync(new URL("./fixture-chart.md", import.meta.url), "utf8");
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };

check("a chart with no ledger is left entirely intact", () => {
  const out = applyLedger(chart, { marks: [], loops: [], findings: "", sittings: [],
    tempo: null, semitones: null, mediaStart: null, mediaEnd: null });
  const { above } = splitAtMarker(out);
  assert.equal(above.replace(/\s+$/, ""), chart.replace(/\s+$/, "") + "\n\n---");
  assert.ok(out.includes(LEDGER_MARKER));
  assert.ok(out.includes("```chords"), "the chord grid survives");
  assert.ok(out.includes("[!note]- Full lyrics"), "the lyrics callout survives");
});

check("writing twice does not stack markers or grow the file", () => {
  const led = { marks: [{ time: 12.5, name: "solo" }], loops: [], findings: "bVII turnaround",
    sittings: ["2026-09-04 · 20 min"], tempo: 0.85, semitones: -1, mediaStart: null, mediaEnd: null };
  const once = applyLedger(chart, led);
  const twice = applyLedger(once, led);
  assert.equal(once, twice, "idempotent");
  assert.equal(twice.split(LEDGER_MARKER).length - 1, 1, "exactly one marker");
});

check("a round-trip preserves marks, findings and sittings", () => {
  const led = { marks: [{ time: 743.2, name: "head" }, { time: 12.25, name: "" }],
    loops: [{ name: "A", a: 1.5, b: 9.25 }], findings: "Two lines\n\nof prose.",
    sittings: ["2026-09-04 · 20 min"], tempo: 0.9, semitones: 0.05, mediaStart: null, mediaEnd: null };
  const { below } = splitAtMarker(applyLedger(chart, led));
  const back = parseBelow(below);
  assert.deepEqual(back.marks.map(m => m.name), ["", "head"], "sorted by time");
  assert.equal(Math.round(back.marks[1].time * 100) / 100, 743.2);
  assert.equal(back.loops.length, 1);
  assert.equal(back.findings, "Two lines\n\nof prose.");
  assert.deepEqual(back.sittings, ["2026-09-04 · 20 min"]);
});

check("empty placeholders do not come back as content", () => {
  const empty = { marks: [], loops: [], findings: "", sittings: [],
    tempo: null, semitones: null, mediaStart: null, mediaEnd: null };
  const { below } = splitAtMarker(applyLedger(chart, empty));
  const back = parseBelow(below);
  assert.equal(back.findings, "", "placeholder is not prose");
  assert.deepEqual(back.sittings, [], "placeholder is not a sitting");
  assert.deepEqual(back.marks, []);
});

check("a sitting line is facts only — no count, no judgement", () => {
  const line = sittingLine(24.6, 0.85, -1);
  assert.match(line, /^\d{4}-\d{2}-\d{2} · 25 min · 85% · -1 st$/);
  assert.equal(sittingLine(5, 1, 0).split(" · ").length, 2, "defaults are not mentioned");
});

console.log(`\n${passed} checks passed`);
