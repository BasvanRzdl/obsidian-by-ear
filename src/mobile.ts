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

export async function readCached(name: string): Promise<ArrayBuffer> {
	const db = await open();
	try {
		const tx = db.transaction(STORE, "readonly");
		const store = tx.objectStore(STORE);
		const row = await run(store, store.get(name) as IDBRequest<{ data: ArrayBuffer } | undefined>);
		if (!row) throw new Error(`“${name}” is not on this device any more.`);
		return row.data;
	} finally {
		db.close();
	}
}

export async function cacheSong(file: File): Promise<CachedSong> {
	const data = await file.arrayBuffer();
	const video = /\.(mp4|m4v|mov|webm)$/i.test(file.name);
	const entry: CachedSong = { name: file.name, bytes: data.byteLength, video, addedAt: Date.now() };
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
