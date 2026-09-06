/**
 * A typed time is the one input where the user is asserting a number rather than hearing one.
 * Misreading it puts a loop edge somewhere nobody asked for, silently — so the parser is the part
 * that gets tested, and the dialogue around it is not.
 */
import { parseTime, formatTime } from "./time.bundle.mjs";

let failed = 0;
function ok(what, cond) {
	console.log(`  ${cond ? "ok " : "FAIL"}  ${what}`);
	if (!cond) failed++;
}
function near(a, b) {
	return a !== null && Math.abs(a - b) < 1e-9;
}

ok("the spelling the player itself writes reads back exactly", near(parseTime("1:34.100"), 94.1));
ok("minutes and seconds without a fraction", near(parseTime("1:34"), 94));
ok("bare seconds, because that is what a note often holds", near(parseTime("94.1"), 94.1));
ok("a bare number over 59 is seconds, not a broken minute", near(parseTime("90"), 90));
ok("hours, for a 19-minute medley's neighbours", near(parseTime("1:02:03"), 3723));
ok("a Dutch keyboard's comma is a decimal point", near(parseTime("1:34,5"), 94.5));
ok("surrounding space is not the user's mistake to pay for", near(parseTime("  0:12.250 "), 12.25));
ok("zero is a real time", near(parseTime("0:00.000"), 0));

ok("a seconds field behind a colon may not reach 60", parseTime("1:60") === null);
ok("words are refused rather than guessed at", parseTime("the solo") === null);
ok("an empty field is not zero", parseTime("   ") === null);
ok("a negative time is refused, not clamped", parseTime("-4") === null);
ok("four decimal places is a typo, not a microsecond", parseTime("1:34.1000") === null);

ok("format and parse round-trip", near(parseTime(formatTime(157.428)), 157.428));
ok("format pads so times sort and align", formatTime(9.5) === "0:09.500");

if (failed) {
	console.error(`\n${failed} check(s) failed`);
	process.exit(1);
}
console.log(`\n${15 - failed} checks passed`);
