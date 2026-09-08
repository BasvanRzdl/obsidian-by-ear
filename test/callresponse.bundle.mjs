// src/player/callresponse.ts
var MIN_PASS = 0.25;
var MAX_SWITCHES = 128;
function passLength(loopA, loopB, rate) {
  const length = loopB - loopA;
  if (!(length > 0) || !(rate > 0) || !isFinite(length) || !isFinite(rate)) return 0;
  return length / rate;
}
function responseSwitches(input) {
  const pass = passLength(input.loopA, input.loopB, input.rate);
  if (pass < MIN_PASS || !(input.horizon > 0)) return [];
  let ahead = (input.loopB - input.position) / input.rate;
  if (!isFinite(ahead)) return [];
  if (ahead <= 0) ahead = pass - -ahead % pass;
  const switches = [];
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
function audibleAt(switches, startAudible, t) {
  let audible = startAudible;
  for (const s of switches) {
    if (s.at > t) break;
    audible = s.audible;
  }
  return audible;
}
export {
  MIN_PASS,
  audibleAt,
  passLength,
  responseSwitches
};
