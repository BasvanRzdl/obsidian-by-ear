/**
 * Call & response is a gate on silence, which means every way it can be wrong is inaudible until
 * you are already playing: a gap a beat too short, a gap that never reopens, an alternation that
 * starts on the silent pass so the first thing the tool does is nothing. None of that shows up in
 * a screenshot, so it is tested here instead.
 */
import { MIN_PASS, audibleAt, passLength, responseSwitches } from "./callresponse.bundle.mjs";

let failed = 0;
let ran = 0;
// Counted rather than written down: this suite's total was wrong within an hour of being written.
function ok(what, cond) {
	ran++;
	console.log(`  ${cond ? "ok " : "FAIL"}  ${what}`);
	if (!cond) failed++;
}
function near(a, b, tol = 1e-9) {
	return Math.abs(a - b) < tol;
}

const base = { now: 100, position: 10, rate: 1, loopA: 10, loopB: 14, horizon: 12, audible: true };

// --- the shape of a plan ---------------------------------------------------------------------

const plan = responseSwitches(base);
ok("the first flip is the seam, four seconds away", near(plan[0].at, 104));
ok("and it flips to silence, because the call is what you just heard", plan[0].audible === false);
ok("the answer lasts exactly as long as the call", near(plan[1].at - plan[0].at, 4));
ok("and then you hear it again", plan[1].audible === true);
ok("call and answer alternate, without exception", plan.every((s, i) => s.audible === (i % 2 === 1)));
ok("evenly spaced, all the way out", plan.every((s, i) => i === 0 || near(s.at - plan[i - 1].at, 4)));
ok("nothing is planned past the horizon", plan.every((s) => s.at <= base.now + base.horizon));
ok("and the horizon is filled, not sampled", plan.length === 3);

// --- the rate is the whole reason a pass is not a length ------------------------------------

// The horizon is widened here on purpose: at half speed two flips no longer fit inside twelve
// seconds, which is itself the point being made.
const slow = responseSwitches({ ...base, rate: 0.5, horizon: 24 });
ok("at half speed the call takes twice as long to play", near(slow[0].at, 108));
ok("so the answering gap is twice as long too", near(slow[1].at - slow[0].at, 8));
ok("a slower pass means fewer flips fit in the same plan", responseSwitches({ ...base, rate: 0.5 }).length === 1);
ok("passLength is real time, not song time", near(passLength(10, 14, 0.5), 8));

// --- where the playhead actually is ----------------------------------------------------------

const early = responseSwitches({ ...base, position: 4 });
ok("a playhead before the loop still flips at the seam, not at A", near(early[0].at, 110));

const late = responseSwitches({ ...base, position: 13 });
ok("mid-pass, the flip is what is left of it", near(late[0].at, 101));

const seam = responseSwitches({ ...base, position: 14 });
ok("standing exactly on the seam is the start of a pass, not the end of one", near(seam[0].at, 104));

const started = responseSwitches({ ...base, audible: false });
ok("planning from a silent pass flips to sound first", started[0].audible === true);

// --- refusals ---------------------------------------------------------------------------------

ok("a loop too short to answer into is refused, not stuttered", responseSwitches({ ...base, loopB: 10.1 }).length === 0);
ok("the floor is a quarter second of real time", MIN_PASS === 0.25);
ok(
	"...measured after the rate, so slowing down can rescue a short loop",
	responseSwitches({ ...base, loopB: 10.2, rate: 0.25 }).length > 0
);
ok("an empty loop plans nothing", responseSwitches({ ...base, loopB: 10 }).length === 0);
ok("a backwards loop plans nothing", responseSwitches({ ...base, loopA: 14, loopB: 10 }).length === 0);
ok("a stopped rate plans nothing rather than dividing by zero", responseSwitches({ ...base, rate: 0 }).length === 0);
ok("no horizon, no plan", responseSwitches({ ...base, horizon: 0 }).length === 0);
ok("a playhead left far past the loop wraps the way the engine wraps it", near(responseSwitches({ ...base, position: 43 })[0].at, 103));

// --- reading the plan back ---------------------------------------------------------------------

ok("before the first flip, nothing has changed", audibleAt(plan, true, 103.9) === true);
ok("a flip counts from the instant it is scheduled for", audibleAt(plan, true, 104) === false);
ok("and the state holds until the next one", audibleAt(plan, true, 107.9) === false);
ok("two flips in and you are listening again", audibleAt(plan, true, 108.5) === true);
ok("an empty plan is whatever it started as", audibleAt([], false, 999) === false);

if (failed) {
	console.error(`\n${failed} check(s) failed`);
	process.exit(1);
}
console.log(`\n${ran - failed} checks passed`);
