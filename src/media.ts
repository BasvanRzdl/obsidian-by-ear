/**
 * Getting bytes off disk.
 *
 * The media folder lives *outside* the vault -- iCloud Drive, in the setup this was written for --
 * because Obsidian Sync Standard caps files at 5 MB and a folder of songs is hundreds. So this
 * cannot go through the vault adapter; it is Node's `fs`, which exists on desktop only.
 *
 * ⚠️ `require` is reached through `window` deliberately. A top-level `import "fs"` becomes a bare
 * `require("fs")` in the CJS bundle, which throws at *module load* on mobile and takes the whole
 * plugin down before it can say anything useful. Reached this way it is a runtime lookup that
 * returns nothing on mobile, and the view can explain itself instead.
 */

export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".flac", ".aac", ".ogg", ".opus", ".aiff"];
/** Listed because `decodeAudioData` takes a video container straight -- measured on iPadOS, 403 s
 *  in 0.6 s. The *picture* is Phase 2; the sound already works. */
export const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm"];

export interface MediaEntry {
	name: string;
	path: string;
	bytes: number;
	video: boolean;
}

interface NodeFs {
	existsSync(path: string): boolean;
	readdirSync(path: string): string[];
	statSync(path: string): { size: number; isFile(): boolean };
	readFileSync(path: string): Uint8Array;
}

export function nodeFs(): NodeFs | null {
	const require = (window as unknown as { require?: (id: string) => unknown }).require;
	if (typeof require !== "function") return null;
	try {
		return require("fs") as NodeFs;
	} catch {
		return null;
	}
}

export function folderExists(folder: string): boolean {
	const fs = nodeFs();
	if (!fs || !folder) return false;
	try {
		return fs.existsSync(folder);
	} catch {
		return false;
	}
}

/** The one path this plugin knows by name, offered as a suggestion and never assumed. */
export function suggestedICloudFolder(): string | null {
	const home = (window as unknown as { process?: { env?: Record<string, string> } }).process?.env?.HOME;
	if (!home) return null;
	const guess = `${home}/Library/Mobile Documents/com~apple~CloudDocs/Music/By Ear`;
	return folderExists(guess) ? guess : null;
}

export function listMedia(folder: string): MediaEntry[] {
	const fs = nodeFs();
	if (!fs || !folder) return [];
	let names: string[];
	try {
		names = fs.readdirSync(folder);
	} catch {
		return [];
	}

	const entries: MediaEntry[] = [];
	for (const name of names) {
		if (name.startsWith(".")) continue;
		const dot = name.lastIndexOf(".");
		if (dot < 0) continue;
		const ext = name.slice(dot).toLowerCase();
		const video = VIDEO_EXTENSIONS.includes(ext);
		if (!video && !AUDIO_EXTENSIONS.includes(ext)) continue;
		const path = `${folder}/${name}`;
		try {
			const stat = fs.statSync(path);
			if (!stat.isFile()) continue;
			entries.push({ name, path, bytes: stat.size, video });
		} catch {
			// An iCloud file that is evicted rather than downloaded still stats fine, so a failure
			// here is a real one -- a permission or a race. Skip it rather than break the list.
		}
	}
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reads a whole file into an ArrayBuffer for `decodeAudioData`.
 *
 * Whole-file, because the engine's streaming path (`addBuffers` in chunks) is Phase 4 work and
 * this is the desktop. The largest file in the folder this was built against is 113 MB.
 */
export function readMedia(path: string): ArrayBuffer {
	const fs = nodeFs();
	if (!fs) throw new Error("Reading files off disk needs the desktop app.");
	const data = fs.readFileSync(path);
	// Node hands back a Buffer that is a view onto a shared pool, so slice to our own bytes --
	// otherwise decodeAudioData detaches memory belonging to something else entirely.
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
