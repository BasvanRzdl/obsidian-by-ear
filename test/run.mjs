/**
 * Builds each testable module on its own and runs its suite.
 *
 * A runner rather than a chain of `&&` in package.json: the list was getting long enough that
 * adding a suite meant editing a 400-character string in two places, which is how the media suite
 * came to be written and then not run.
 */
import { execFileSync } from "node:child_process";

const modules = [
	["src/ledger.ts", "ledger"],
	["src/media.ts", "media"],
	["src/player/waveform.ts", "waveform"],
	["src/player/video.ts", "video"],
];

for (const [entry, name] of modules) {
	execFileSync(
		"npx",
		["esbuild", entry, "--bundle", "--format=esm", `--outfile=test/${name}.bundle.mjs`,
			"--alias:obsidian=./test/obsidian-stub.mjs", "--log-level=error"],
		{ stdio: "inherit" }
	);
}

let failed = 0;
for (const [, name] of modules) {
	console.log(`\n${name}`);
	try {
		execFileSync("node", [`test/${name}.test.mjs`], { stdio: "inherit" });
	} catch {
		failed++;
	}
}
if (failed) {
	console.error(`\n${failed} suite(s) failed`);
	process.exit(1);
}
