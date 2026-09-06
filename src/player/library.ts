/**
 * The library: choosing a song, adding songs, removing one.
 *
 * ⚠️ This exists as a modal because of what the v0.7.0 design got wrong. The picker, the filter,
 * "Add songs…" and "remove from this device" were all filed as rare setup and put in a desktop-only
 * header — which on iOS meant **there was no way to open a file at all**. The iOS Files picker is
 * not a convenience there, it is the only mechanism by which media exists on the device (§3, and
 * Phase 4 of the build order). The couch, the train and the phone are the entire reason the plugin
 * was written; a design the phone cannot open a song with is not a design.
 *
 * A modal rather than a rail section, because it is genuinely used once per song and then not
 * again: it can afford to cost a tap, and the practice screen cannot afford the width.
 */

import { App, Modal, Platform, setIcon } from "obsidian";
import { MediaEntry } from "../media";

export interface LibraryOptions {
	entries: MediaEntry[];
	/** Song, artist and band for one entry -- the notes already know, so the filter reads them. */
	haystack: (entry: MediaEntry) => string;
	current: MediaEntry | null;
	/** Set on desktop when no media folder is configured yet: the list can never fill. */
	needsFolder: boolean;
	onPick: (entry: MediaEntry) => void;
	onAdd: (files: File[]) => void;
	onForget: (entry: MediaEntry) => void;
	onRescan: () => void;
}

export class LibraryModal extends Modal {
	private filter = "";
	private list!: HTMLElement;

	constructor(app: App, private options: LibraryOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("by-ear-library-modal");
		contentEl.empty();
		this.titleEl.setText("Songs on this device");

		/*
		 * One box, matching title, artist and band at once.
		 *
		 * Deliberately not a library UI -- the vault is the library (§5d). What makes "fat bill" a
		 * useful thing to type is that the *notes* already know: a chart carries `bands:`, so the
		 * filter reads the vault rather than keeping a catalogue of its own.
		 */
		const search = contentEl.createEl("input", {
			type: "search",
			cls: "by-ear-lib-filter",
			attr: { placeholder: "filter — song, artist or band", "aria-label": "Filter songs" },
		});
		search.addEventListener("input", () => {
			this.filter = search.value.trim().toLowerCase();
			this.renderList();
		});

		this.list = contentEl.createDiv({ cls: "by-ear-lib-list" });
		this.renderList();

		const foot = contentEl.createDiv({ cls: "by-ear-lib-foot" });
		if (Platform.isMobile) {
			/*
			 * `multiple` is the whole mitigation for iOS having no directory access: the folder
			 * cannot be read, but the entire folder can be selected in one go, once, and it is
			 * cached from then on. Adding songs one at a time was never a requirement -- only a
			 * consequence of asking for one file.
			 */
			const chooser = foot.createEl("input", {
				type: "file",
				cls: "by-ear-file-input",
				attr: { accept: "audio/*,video/*", multiple: "true", "aria-label": "Add songs from Files" },
			});
			const add = foot.createEl("button", {
				text: "Add songs…",
				cls: "by-ear-b mod-cta",
				attr: { "aria-label": "Add songs from the Files app" },
			});
			add.addEventListener("click", () => chooser.click());
			chooser.addEventListener("change", () => {
				const files = Array.from(chooser.files ?? []);
				chooser.value = "";
				if (files.length > 0) {
					this.close();
					this.options.onAdd(files);
				}
			});
			foot.createSpan({
				cls: "by-ear-lib-hint",
				text: "Select the whole By Ear folder once — they stay until you remove them.",
			});
		} else {
			const rescan = foot.createEl("button", {
				text: "Re-scan folder",
				cls: "by-ear-b",
				attr: { "aria-label": "Re-scan the media folder" },
			});
			rescan.addEventListener("click", () => {
				this.options.onRescan();
				this.close();
			});
			if (this.options.needsFolder) {
				foot.createSpan({ cls: "by-ear-lib-hint", text: "Set a media folder in the plugin settings first." });
			}
		}

		window.setTimeout(() => search.focus(), 0);
	}

	private renderList(): void {
		this.list.empty();
		const shown = this.filter
			? this.options.entries.filter((e) => this.options.haystack(e).includes(this.filter))
			: this.options.entries;

		if (shown.length === 0) {
			this.list.createDiv({
				cls: "by-ear-lib-empty",
				text: this.options.entries.length === 0
					? Platform.isMobile
						? "No songs on this device yet. Add some below."
						: "No playable files in the media folder."
					: `Nothing matches “${this.filter}”.`,
			});
			return;
		}

		for (const entry of shown) {
			const row = this.list.createDiv({ cls: "by-ear-lib-row" });
			if (this.options.current?.path === entry.path) row.addClass("is-current");

			const pick = row.createEl("button", {
				cls: "by-ear-lib-pick",
				attr: { "aria-label": `Open ${stripExtension(entry.name)}` },
			});
			pick.createSpan({ cls: "by-ear-lib-name", text: stripExtension(entry.name) });
			// Which files have hands to watch is the single most useful thing to know here.
			pick.createSpan({ cls: "by-ear-lib-kind", text: entry.video ? "video" : "audio" });
			pick.addEventListener("click", () => {
				this.close();
				this.options.onPick(entry);
			});

			// Only cached files can be forgotten; a file on disk is the user's, not the plugin's.
			if (entry.source === "cache") {
				const forget = row.createEl("button", {
					cls: "by-ear-lib-forget",
					attr: { "aria-label": `Remove ${stripExtension(entry.name)} from this device` },
				});
				setIcon(forget, "trash-2");
				forget.addEventListener("click", () => {
					this.close();
					this.options.onForget(entry);
				});
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function stripExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}
