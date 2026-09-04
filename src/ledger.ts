import { App, TFile, normalizePath } from "obsidian";

/**
 * The ledger: a song's marks, loops, findings and sittings, kept in the song's own note.
 *
 * ⚠️ The rule this file exists to enforce, settled 4 September 2026 after counting the folder:
 * **one song, one note.** A song learned by ear does not get a second file. Fourteen of the
 * seventeen songs in the media folder are already in the Songbook, so the ordinary home for a
 * ledger is that chart; a study note is next; a fresh note in the By Ear folder is the exception.
 *
 * ⚠️ And the line. Everything written here goes **below a marker at the very bottom** of the note.
 * Above it is the user's own document -- a chart that gets read on a music stand, or an essay -- and
 * this file must never touch a byte of it. Reads take the whole note, writes replace only the
 * region from the marker to the end. That is the same discipline the vault's Writing domain uses
 * for prose, and it is the reason a machine may write into a gig document at all.
 */

/** Invisible in reading mode (Obsidian comment syntax), unique enough to find, honest about itself. */
export const LEDGER_MARKER =
	"%% by-ear:ledger — written by the By Ear plugin. Everything above this line is yours. %%";

export interface Mark {
	time: number;
	name: string;
}

export interface SavedLoop {
	name: string;
	a: number;
	b: number;
}

export interface Ledger {
	marks: Mark[];
	loops: SavedLoop[];
	/** Free prose, preserved exactly as written -- the plugin round-trips it, never reformats it. */
	findings: string;
	sittings: string[];
	tempo: number | null;
	semitones: number | null;
	/** The song's region inside the media file. A 19-minute medley holds more than one song. */
	mediaStart: number | null;
	mediaEnd: number | null;
}

export function emptyLedger(): Ledger {
	return {
		marks: [],
		loops: [],
		findings: "",
		sittings: [],
		tempo: null,
		semitones: null,
		mediaStart: null,
		mediaEnd: null,
	};
}

// --------------------------------------------------------------------- finding the note

/** `Artist - Song.mp4` -> `{ artist, song }`. The convention `/by-ear` writes files with. */
export function splitMediaName(fileName: string): { artist: string; song: string } {
	const stem = fileName.replace(/\.[^.]+$/, "");
	const dash = stem.indexOf(" - ");
	if (dash < 0) return { artist: "", song: stem.trim() };
	return { artist: stem.slice(0, dash).trim(), song: stem.slice(dash + 3).trim() };
}

/**
 * Loose title comparison: case, accents, punctuation and any parenthetical all ignored.
 *
 * "I Can't Go for That" must match "I Can't Go for That (No Can Do)", and "Andre Hazes Jr" must
 * match "André Hazes Jr.". Deliberately generous -- a wrong match is visible and fixable in one
 * frontmatter line, while a missed match silently creates a duplicate note, which is the thing
 * this whole module exists to prevent.
 */
function loose(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\(.*?\)/g, "")
		.replace(/[^a-z0-9]+/g, "");
}

export interface NoteMatch {
	file: TFile;
	/** How it was found -- shown to the user, because "which note is this writing to?" matters. */
	how: "media" | "chart" | "study" | "byear";
	artist: string;
	bands: string[];
}

interface IndexEntry {
	file: TFile;
	media: string;
	type: string;
	song: string;
	artist: string;
	artistRaw: string;
	bands: string[];
}

/** Every song-ish note in the vault, read once. Rebuilt per library refresh, not per lookup. */
export type NoteIndex = IndexEntry[];

export function buildIndex(app: App): NoteIndex {
	const index: NoteIndex = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		const type = String(fm.type ?? "");
		const song = String(fm.song ?? "");
		// A study note carries no `song:`, so its filename stands in -- `Villanova Junction.md`.
		const title = song || file.basename.split(" — ")[0];
		if (!title) continue;
		const bands = Array.isArray(fm.bands)
			? fm.bands.map((b: unknown) => String(b).replace(/^\[\[|\]\]$/g, ""))
			: [];
		index.push({
			file,
			media: String(fm.media ?? ""),
			type,
			song: loose(title),
			artist: loose(String(fm.artist ?? file.parent?.name ?? "")),
			artistRaw: String(fm.artist ?? file.parent?.name ?? ""),
			bands,
		});
	}
	return index;
}

/**
 * Finds the note a media file belongs to, in the settled priority order.
 *
 * An explicit `media:` in frontmatter always wins: once a note is bound to a file, the binding is
 * a fact rather than a guess, and renaming the song no longer breaks it.
 */
export function findNote(index: NoteIndex, mediaName: string): NoteMatch | null {
	const { song, artist } = splitMediaName(mediaName);
	const wantSong = loose(song);
	const wantArtist = loose(artist);

	let chart: IndexEntry | null = null;
	let study: IndexEntry | null = null;
	let byear: IndexEntry | null = null;

	for (const entry of index) {
		if (entry.media && entry.media === mediaName) return asMatch(entry, "media");
		if (entry.song !== wantSong) continue;
		// The artist is a tie-breaker, not a requirement: a study note is filed under an artist
		// folder and often carries no `artist:` key at all.
		if (entry.artist && wantArtist && entry.artist !== wantArtist) continue;

		if (entry.type === "chart") chart ??= entry;
		else if (entry.type === "byear") byear ??= entry;
		else study ??= entry;
	}

	if (chart) return asMatch(chart, "chart");
	if (study) return asMatch(study, "study");
	if (byear) return asMatch(byear, "byear");
	return null;
}

function asMatch(entry: IndexEntry, how: NoteMatch["how"]): NoteMatch {
	return { file: entry.file, how, artist: entry.artistRaw, bands: entry.bands };
}

/** Creates the fallback note, used only when a song has neither a chart nor a study. */
export async function createNote(app: App, folder: string, mediaName: string): Promise<TFile> {
	const { song, artist } = splitMediaName(mediaName);
	const base = artist ? `${song} — ${artist}` : song;
	const dir = normalizePath(folder);
	if (dir && !app.vault.getAbstractFileByPath(dir)) {
		await app.vault.createFolder(dir).catch(() => undefined);
	}

	let path = normalizePath(dir ? `${dir}/${base}.md` : `${base}.md`);
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = normalizePath(dir ? `${dir}/${base} (${n}).md` : `${base} (${n}).md`);
		n++;
	}

	// `bands` is spelled the way a Songbook chart spells it, on purpose -- the join-key rule from
	// the design note's section 6. It is what lets a dashboard be a query later, not a migration.
	const front = [
		"---",
		"type: byear",
		`song: ${song}`,
		`artist: ${artist}`,
		"bands: []",
		`media: ${mediaName}`,
		"status: working",
		"---",
		"",
		`# ${base}`,
		"",
	].join("\n");

	return app.vault.create(path, front + "\n" + LEDGER_MARKER + "\n");
}

// --------------------------------------------------------------------- reading

function parseTime(value: string): number | null {
	const text = value.trim();
	if (!text) return null;
	// Accepts 1:23.456 and plain seconds, because a human edits this table by hand too.
	const parts = text.split(":");
	let seconds = 0;
	for (const part of parts) {
		const n = Number(part);
		if (!Number.isFinite(n)) return null;
		seconds = seconds * 60 + n;
	}
	return seconds;
}

export function formatTime(seconds: number): string {
	const s = Math.max(0, seconds);
	const m = Math.floor(s / 60);
	const rest = s - m * 60;
	return `${m}:${rest.toFixed(3).padStart(6, "0")}`;
}

/** Splits a note into the part that is the user's and the part that is ours. */
export function splitAtMarker(content: string): { above: string; below: string } {
	const at = content.indexOf(LEDGER_MARKER);
	if (at < 0) return { above: content, below: "" };
	return { above: content.slice(0, at), below: content.slice(at + LEDGER_MARKER.length) };
}

/**
 * The placeholders an empty section is rendered with.
 *
 * They have to be filtered on the way back in, or a round-trip turns "*No sittings yet.*" into an
 * actual sitting and then writes it back as one. Found by reading the two halves against each
 * other rather than by running it, which is the cheaper way to find this class of bug.
 */
const PLACEHOLDERS = new Set(["*None yet.*", "*Nothing written yet.*", "*No sittings yet.*"]);

function sectionOf(below: string, heading: string): string {
	const lines = below.split("\n");
	const out: string[] = [];
	let inside = false;
	for (const line of lines) {
		if (/^##\s+/.test(line)) {
			inside = line.trim() === `## ${heading}`;
			continue;
		}
		if (inside) out.push(line);
	}
	return out.join("\n").trim();
}

function parseRows(section: string): string[][] {
	return section
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith("|") && !/^\|[\s|:-]+\|$/.test(l))
		.map((l) => l.slice(1, -1).split("|").map((c) => c.trim()))
		.filter((cells, i) => !(i === 0 && /^(time|name)$/i.test(cells[0] ?? "")));
}

export function parseBelow(below: string): Ledger {
	return readSections(below, emptyLedger());
}

export function readLedger(app: App, file: TFile, content: string): Ledger {
	const ledger = emptyLedger();
	const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};

	const num = (v: unknown): number | null => {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	};
	ledger.tempo = num(fm.tempo);
	ledger.semitones = num(fm.pitch);
	ledger.mediaStart = num(fm.media_start);
	ledger.mediaEnd = num(fm.media_end);

	const { below } = splitAtMarker(content);
	if (!below) return ledger;
	return readSections(below, ledger);
}

function readSections(below: string, ledger: Ledger): Ledger {
	for (const cells of parseRows(sectionOf(below, "Marks"))) {
		const time = parseTime(cells[0] ?? "");
		if (time === null) continue;
		ledger.marks.push({ time, name: cells[1] ?? "" });
	}
	ledger.marks.sort((a, b) => a.time - b.time);

	for (const cells of parseRows(sectionOf(below, "Loops"))) {
		const a = parseTime(cells[1] ?? "");
		const b = parseTime(cells[2] ?? "");
		if (a === null || b === null) continue;
		ledger.loops.push({ name: cells[0] ?? "", a, b });
	}

	const findings = sectionOf(below, "Findings");
	ledger.findings = PLACEHOLDERS.has(findings.trim()) ? "" : findings;
	ledger.sittings = sectionOf(below, "Sittings")
		.split("\n")
		.map((l) => l.replace(/^-\s*/, "").trim())
		.filter((l) => l && !PLACEHOLDERS.has(l));

	return ledger;
}

// --------------------------------------------------------------------- writing

function renderLedger(ledger: Ledger): string {
	const out: string[] = ["", ""];

	out.push("## Marks", "");
	if (ledger.marks.length === 0) {
		out.push("*None yet.*", "");
	} else {
		out.push("| time | name |", "| --- | --- |");
		for (const m of [...ledger.marks].sort((a, b) => a.time - b.time)) {
			out.push(`| ${formatTime(m.time)} | ${m.name} |`);
		}
		out.push("");
	}

	out.push("## Loops", "");
	if (ledger.loops.length === 0) {
		out.push("*None yet.*", "");
	} else {
		out.push("| name | A | B |", "| --- | --- | --- |");
		for (const l of ledger.loops) {
			out.push(`| ${l.name} | ${formatTime(l.a)} | ${formatTime(l.b)} |`);
		}
		out.push("");
	}

	out.push("## Findings", "");
	out.push(ledger.findings.trim() ? ledger.findings.trim() : "*Nothing written yet.*", "");

	out.push("## Sittings", "");
	if (ledger.sittings.length === 0) out.push("*No sittings yet.*", "");
	else for (const s of ledger.sittings) out.push(`- ${s}`);

	return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/**
 * Replaces only the region below the marker.
 *
 * `vault.process` is a read-modify-write under Obsidian's own lock, which matters because the file
 * may also be open in an editor and syncing to an iPad. If the marker is missing the region is
 * appended after a rule, which is the only case where anything is added above it -- and even then
 * nothing existing is altered.
 */
export function applyLedger(content: string, ledger: Ledger): string {
	const { above } = splitAtMarker(content);
	const head = content.includes(LEDGER_MARKER)
		? above.replace(/\s+$/, "") + "\n\n"
		: content.replace(/\s+$/, "") + "\n\n---\n\n";
	return head + LEDGER_MARKER + renderLedger(ledger);
}

export async function writeLedger(app: App, file: TFile, ledger: Ledger): Promise<void> {
	await app.vault.process(file, (content) => applyLedger(content, ledger));

	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (ledger.tempo !== null) fm.tempo = ledger.tempo;
		if (ledger.semitones !== null) fm.pitch = ledger.semitones;
		if (ledger.mediaStart !== null) fm.media_start = round(ledger.mediaStart);
		if (ledger.mediaEnd !== null) fm.media_end = round(ledger.mediaEnd);
	});
}

/** Binds a note to its media file, so the next lookup is a fact rather than a title guess. */
export async function bindMedia(app: App, file: TFile, mediaName: string): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (!fm.media) fm.media = mediaName;
	});
}

function round(n: number): number {
	return Math.round(n * 1000) / 1000;
}

/** `2026-09-04 · 25 min · 88%, -1 st` — facts, never a count and never a judgement. */
export function sittingLine(minutes: number, tempo: number, semitones: number): string {
	const date = new Date().toISOString().slice(0, 10);
	const bits = [`${Math.max(1, Math.round(minutes))} min`];
	if (Math.round(tempo * 100) !== 100) bits.push(`${Math.round(tempo * 100)}%`);
	if (Math.abs(semitones) > 0.001) bits.push(`${semitones > 0 ? "+" : ""}${round(semitones)} st`);
	return `${date} · ${bits.join(" · ")}`;
}
