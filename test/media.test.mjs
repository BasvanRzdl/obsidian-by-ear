/**
 * A blob URL carries no file name, so the type on the Blob is the only thing a <video> has to go on.
 *
 * Chromium sniffs the bytes and plays anyway; WebKit does not and shows nothing at all. That is the
 * whole of the v0.4.0 bug — video on the Mac, a blank box on iPad and iPhone — so the mapping is
 * asserted rather than eyeballed, including the case that caused it.
 */
import assert from "node:assert/strict";
import { mimeFor } from "./media.bundle.mjs";

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log("  ok  " + name); };

check("every video container in the folder gets a type", () => {
  assert.equal(mimeFor("Jimi Hendrix - Hear My Train A Comin (acoustic, 1967).mp4"), "video/mp4");
  assert.equal(mimeFor("clip.m4v"), "video/mp4");
  assert.equal(mimeFor("clip.mov"), "video/quicktime");
  assert.equal(mimeFor("clip.webm"), "video/webm");
});

check("audio too, since the same blob feeds the decoder", () => {
  assert.equal(mimeFor("Creedence Clearwater Revival - Sinister Purpose.mp3"), "audio/mpeg");
  assert.equal(mimeFor("x.m4a"), "audio/mp4");
  assert.equal(mimeFor("x.wav"), "audio/wav");
  assert.equal(mimeFor("x.flac"), "audio/flac");
});

check("case and dots in the name do not matter", () => {
  assert.equal(mimeFor("A Song - Live At The Fillmore.MP4"), "video/mp4");
  assert.equal(mimeFor("1969.06.20 - set.two.MOV"), "video/quicktime");
});

check("an unknown extension says nothing rather than something wrong", () => {
  // An empty type still lets a sniffing engine try; a wrong one would stop it dead.
  assert.equal(mimeFor("mystery.xyz"), "");
  assert.equal(mimeFor("noextension"), "");
});

console.log(`\n${passed} checks passed`);
