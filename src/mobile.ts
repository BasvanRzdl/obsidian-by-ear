/**
 * The iOS half: getting a song into the app, and keeping it there.
 *
 * ⚠️ This is the reason the project exists. Section 1's gap is "the couch, the train and the phone.
 * Not the desk" -- Transcribe! already covers the Mac, so everything built for desktop duplicates
 * software Bas already owns. Everything here is the actual product.
 *
 * There is no `fs` on iOS and no path to resolve, so a song arrives exactly once, through the Files
 * picker (which reaches iCloud Drive -- proved on the spike, 3 September). Re-picking it every
 * session would be intolerable, so the bytes are cached in **IndexedDB inside the WebView**, which
 * is the only storage on iOS big enough to hold a song and durable across launches.
 *
 * ⚠️ The cache is per-device and per-app on purpose. It is not sync, and it must never be mistaken
 * for it: the *state* syncs through the vault note, the *media* does not. That split is section 3
 * and it is load-bearing.
 */

import { mimeFor } from "./media";

const DB_NAME = "by-ear";
const STORE = "media";
const DB_VERSION = 1;

export interface CachedSong {
	name: string;
	bytes: number;
	video: boolean;
	addedAt: number;
}

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "name" });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB refused to open"));
	});
}

function run<T>(store: IDBObjectStore, request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
		void store;
	});
}

/** What is already on this device, newest first. Bytes are not read -- only the index. */
export async function listCached(): Promise<CachedSong[]> {
	const db = await open();
	try {
		const tx = db.transaction(STORE, "readonly");
		const store = tx.objectStore(STORE);
		const all = await run(store, store.getAll() as IDBRequest<(CachedSong & { data: ArrayBuffer })[]>);
		return all
			.map(({ name, bytes, video, addedAt }) => ({ name, bytes, video, addedAt }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} finally {
		db.close();
	}
}

/**
 * The cached file as a Blob.
 *
 * ⚠️ Stored as a Blob rather than an ArrayBuffer since v0.4.0, and the reason is video. A Blob can
 * be handed straight to `URL.createObjectURL` with nothing copied, and the browser may keep it on
 * disk instead of in memory -- which matters on a phone that is already holding a decoded song
 * inside the worklet. Rows written by older versions hold an ArrayBuffer, so both are accepted:
 * a cache that had to be rebuilt would mean re-picking every song by hand.
 */
export async function readCachedBlob(name: string): Promise<Blob> {
	const db = await open();
	try {
		const tx = db.transaction(STORE, "readonly");
		const store = tx.objectStore(STORE);
		const row = await run(store, store.get(name) as IDBRequest<{ data: Blob | ArrayBuffer } | undefined>);
		if (!row) throw new Error(`“${name}” is not on this device any more.`);
		const type = mimeFor(name);
		if (!(row.data instanceof Blob)) return new Blob([row.data], { type });
		// A Blob cached by an earlier build carries no type, and a typeless blob URL shows nothing
		// on WebKit. Re-slicing with the type copies no bytes.
		return row.data.type ? row.data : row.data.slice(0, row.data.size, type);
	} finally {
		db.close();
	}
}

export async function cacheSong(file: File): Promise<CachedSong> {
	// The File *is* a Blob, so this stores it without ever reading it into memory.
	// ⚠️ `file.slice()` with no arguments drops the type. Passing it explicitly is the whole fix --
	// and iOS sometimes hands over a File with an empty type, so the extension is the fallback.
	const data = file.slice(0, file.size, file.type || mimeFor(file.name));
	const video = /\.(mp4|m4v|mov|webm)$/i.test(file.name);
	const entry: CachedSong = { name: file.name, bytes: file.size, video, addedAt: Date.now() };
	const db = await open();
	try {
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		await run(store, store.put({ ...entry, data }) as IDBRequest<IDBValidKey>);
		return entry;
	} finally {
		db.close();
	}
}

export async function forgetCached(name: string): Promise<void> {
	const db = await open();
	try {
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		await run(store, store.delete(name) as IDBRequest<undefined>);
	} finally {
		db.close();
	}
}

/**
 * Keeps the screen awake while a loop is running (M10).
 *
 * An iPad that sleeps mid-loop is a broken tool -- you are holding a guitar, not the tablet, so
 * nothing is touching the screen for minutes at a time. The lock is dropped the moment playback
 * stops, and re-taken when the app comes back to the foreground, because iOS releases it silently
 * whenever the page is hidden and never tells you.
 */
export class KeepAwake {
	private sentinel: WakeLockSentinel | null = null;
	private wanted = false;

	private onVisibility = (): void => {
		if (this.wanted && document.visibilityState === "visible") void this.acquire();
	};

	constructor() {
		document.addEventListener("visibilitychange", this.onVisibility);
	}

	async want(on: boolean): Promise<void> {
		this.wanted = on;
		if (on) await this.acquire();
		else await this.release();
	}

	private async acquire(): Promise<void> {
		if (this.sentinel) return;
		const api = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<WakeLockSentinel> } }).wakeLock;
		if (!api) return; // Older iOS simply does not have it; the player still works.
		try {
			this.sentinel = await api.request("screen");
			this.sentinel.addEventListener("release", () => (this.sentinel = null));
		} catch {
			// Refused (low battery, backgrounded). Not worth a notice -- it is a comfort, not a feature.
			this.sentinel = null;
		}
	}

	private async release(): Promise<void> {
		const held = this.sentinel;
		this.sentinel = null;
		try {
			await held?.release();
		} catch {
			/* already gone */
		}
	}

	destroy(): void {
		document.removeEventListener("visibilitychange", this.onVisibility);
		void this.release();
	}
}

interface WakeLockSentinel extends EventTarget {
	release(): Promise<void>;
}

/**
 * Making sound come out of an iPhone.
 *
 * ⚠️ WebKit mutes the entire Web Audio API when the ringer switch is off (webkit.org bug 237322).
 * Not the volume — the physical switch on the side. The iPad has no such switch, which is exactly
 * why this plugin played fine there and was silent on the phone: same code, different hardware.
 *
 * Two layers, because one of them is new:
 *
 * 1. `navigator.audioSession.type = "playback"` is the real fix and Safari has implemented it. It
 *    tells iOS this is media playback rather than an interface noise, and media playback is not
 *    what the ringer switch is for.
 * 2. Older iOS has no such API, so the long-standing workaround: play a fraction of a second of
 *    silence through an `<audio>` element during a user gesture. An `<audio>` element reads
 *    unambiguously as "the user asked for music", and the audio session follows it.
 *
 * Neither can be verified from here -- if the switch still wins, the honest answer is the switch.
 */
export function claimAudioPlayback(): void {
	const nav = navigator as Navigator & { audioSession?: { type: string } };
	if (nav.audioSession) {
		try {
			nav.audioSession.type = "playback";
		} catch {
			/* Read-only in some builds; the nudge below is the fallback. */
		}
	}
}

let nudged = false;

/** Must be called from inside a real user gesture, and only earns its keep once per session. */
export function nudgeAudioSession(): void {
	if (nudged) return;
	nudged = true;
	try {
		const el = document.createElement("audio");
		el.src = silentWavUrl();
		el.volume = 0.01;
		void el.play().catch(() => undefined);
	} catch {
		/* Nothing here is load-bearing: the player works if this does nothing. */
	}
}

/** 50 ms of 16-bit silence, built rather than shipped -- no binary in the repo for this. */
function silentWavUrl(): string {
	const rate = 44100;
	const frames = Math.floor(rate * 0.05);
	const buffer = new ArrayBuffer(44 + frames * 2);
	const view = new DataView(buffer);
	const tag = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	tag(0, "RIFF");
	view.setUint32(4, 36 + frames * 2, true);
	tag(8, "WAVEfmt ");
	view.setUint32(16, 16, true); // PCM header length
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	tag(36, "data");
	view.setUint32(40, frames * 2, true);
	// The samples themselves stay zero: a fresh ArrayBuffer is already silence.
	return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}
