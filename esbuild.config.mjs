import esbuild from "esbuild";
import process from "process";
import { readFileSync } from "fs";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";

/**
 * ⚠️ Do not minify, and do not lower the target, however tempting it looks.
 *
 * Signalsmith Stretch does not ship its AudioWorklet as a separate file. It builds one at
 * runtime by stringifying two of its own functions:
 *
 *   `(${registerWorkletProcessor})((_scriptName=>${Module})(),${JSON.stringify(audioNodeKey)})`
 *
 * That template hard-codes the identifier `_scriptName` as *text*, while the Emscripten factory
 * that reads it is real code. Any bundler transform that renames identifiers therefore breaks the
 * pair silently: minification rewrote the declaration to `h` and left the string untouched, so the
 * generated worklet handed the factory a `_scriptName` nobody asks for while its body reached for
 * an `h` that exists only in the bundle's closure, not in the worklet's global scope.
 *
 * The failure is invisible from the outside. Module evaluation only *defines* the factory, so
 * `addModule()` resolves; `new AudioWorkletNode()` succeeds on the main thread; the ReferenceError
 * fires on the audio thread inside the processor constructor, and a processor that throws never
 * posts its `ready` message — so the library's boot promise never settles and never rejects.
 * Cost of learning this the hard way: one full session (3 September 2026).
 *
 * `es2022` matters for the same reason: at `es2018` esbuild downlevels `?.` into hoisted `_a`
 * temporaries, which is the same hazard by a different route. Obsidian 1.12 is Chrome 142 and
 * Obsidian mobile is comparably modern, so nothing here needs lowering.
 *
 * The durable fix is to stop relying on `Function.prototype.toString()` at all — ship the worklet
 * as its own file and load it by URL. Until then, this config is load-bearing.
 */
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: false,
});

/**
 * Guards the contract described above. `_scriptName` must appear at least twice in the output:
 * once inside the library's template *string*, and at least once as real code the wrapper feeds.
 * One lone occurrence means a transform renamed the code and left the string — the exact state
 * that hung spike-4. Cheap check, and it fails at build time instead of on the audio thread.
 */
function verifyWorkletContract() {
  const bundle = readFileSync("main.js", "utf8");
  const hits = bundle.split("_scriptName").length - 1;
  if (hits < 2) {
    throw new Error(
      `Broken worklet contract: '_scriptName' appears ${hits}× in main.js (expected 2+). ` +
        "A bundler transform renamed the identifier the stringified worklet depends on. " +
        "Check minify/target in esbuild.config.mjs — see the note above."
    );
  }
  console.log(`worklet contract OK — '_scriptName' intact (${hits} occurrences)`);
}

if (production) {
  await context.rebuild();
  verifyWorkletContract();
  process.exit(0);
} else {
  await context.watch();
}
