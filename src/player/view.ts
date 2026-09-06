import { ItemView, Modal, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type ByEarPlugin from "../main";
import { Engine } from "./engine";
import { Waveform } from "./waveform";
import { VideoScreen } from "./video";
import { LibraryModal } from "./library";
import { MediaEntry, listMedia, mimeFor, readMedia } from "../media";
import {
	KeepAwake,
	cacheSong,
	claimAudioPlayback,
	forgetCached,
	listCached,
	nudgeAudioSession,
	readCachedBlob,
} from "../mobile";
import {
	LEDGER_MARKER,
	Ledger,
	NoteIndex,
	NoteMatch,
	bindMedia,
	buildIndex,
	createNote,
	emptyLedger,
	findNote,
	readLedger,
	sittingLine,
	writeLedger,
} from "../ledger";

export const PLAYER_VIEW = "by-ear-player";

/** Tempo bounds. Above 150% and below 25% the stretcher is honestly rough; the author says so too. */
const RATE_MIN = 25;
const RATE_MAX = 150;

/**
 * Step sizes for the buttons -- and for the keyboard, which reads the same constants so the two can
 * never drift apart. 5 cents is deliberate: it is about the smallest pitch move the ear reliably
 * hears, which makes it the right size for chasing a record that sits slightly off concert pitch,
 * while the semitone buttons handle anything larger.
 */
const RATE_STEP = 5;
const SEMITONE_STEP = 1;
const CENT_STEP = 5;

/** One video frame at 30 fps. Close enough at 24 or 25 to be the right size of nudge. */
const FRAME = 1 / 30;

/** A tap this long after the previous one starts a new count rather than a very slow tempo. */
const TAP_RESET_MS = 2500;

type TabId = "marks" | "notes" | "tune";

export class PlayerView extends ItemView {
	private plugin: ByEarPlugin;
	private engine = new Engine();
	private waveform: Waveform | null = null;
	private video: VideoScreen | null = null;

	private library: MediaEntry[] = [];
	private current: MediaEntry | null = null;
	private duration = 0;

	/** The ledger half: which note this song writes to, and what it last said. */
	private index: NoteIndex = [];
	private note: NoteMatch | null = null;
	private ledger: Ledger = emptyLedger();
	private openedAt = 0;
	private saveTimer = 0;
	private statusTimer = 0;
	private awake = new KeepAwake();
	private wasPlaying = false;
	private immersive = false;
	/** Whether *we* took native full screen, as opposed to only drawing the overlay. */
	private native = false;
	private home: { parent: HTMLElement | null; next: ChildNode | null } | null = null;
	/** Whether the ledger holds anything not yet on disk. Drives the receipt, nothing else. */
	private unsaved = false;
	/** True only while restoring a note, so putting values back does not count as changing them. */
	private restoring = false;
	private tab: TabId = "marks";
	/** Tap timestamps, for tap tempo. Cleared by a long gap, not by a button. */
	private taps: number[] = [];
	/** The last tempo he actually worked at, so the swap button has somewhere to go back to. */
	private workingRate = 0.7;

	private raf = 0;
	private dirty = true;

	private el = {
		canvas: null as HTMLCanvasElement | null,
		rail: null as HTMLElement | null,
		stage: null as HTMLElement | null,
		songName: null as HTMLElement | null,
		noteLink: null as HTMLElement | null,
		report: null as HTMLElement | null,
		playButton: null as HTMLButtonElement | null,
		clock: null as HTMLElement | null,
		edgeA: null as HTMLElement | null,
		edgeB: null as HTMLElement | null,
		loopLen: null as HTMLElement | null,
		loopToggle: null as HTMLButtonElement | null,
		rate: null as HTMLInputElement | null,
		rateValue: null as HTMLElement | null,
		semitones: null as HTMLInputElement | null,
		cents: null as HTMLInputElement | null,
		pitchValue: null as HTMLElement | null,
		bpmValue: null as HTMLButtonElement | null,
		frameRow: null as HTMLElement | null,
		fullscreen: null as HTMLButtonElement | null,
		findings: null as HTMLTextAreaElement | null,
		saveState: null as HTMLElement | null,
		tabsWrap: null as HTMLElement | null,
		tabs: [] as HTMLButtonElement[],
		panes: {} as Record<TabId, HTMLElement>,
		markList: null as HTMLElement | null,
	};

	constructor(leaf: WorkspaceLeaf, plugin: ByEarPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return PLAYER_VIEW;
	}

	getDisplayText(): string {
		return this.current ? `By Ear — ${stripExtension(this.current.name)}` : "By Ear";
	}

	getIcon(): string {
		return "headphones";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("by-ear-player");
		// Needed for the keyboard shortcuts to reach us at all.
		root.tabIndex = 0;

		/*
		 * Four zones, one tree, on every platform. Designed 6 September 2026 (spec §11), after six
		 * versions of adjusting the stylesheet from screenshots ended with "it looks ugly now".
		 *
		 *   top    — what is playing, how to change it, the way out of full screen.  (Tier 3)
		 *   rail   — everything the hand reaches for while playing. Never scrolls.   (Tier 1)
		 *   tabs   — marks, notes, tune. One at a time, and the panel scrolls.       (Tier 2)
		 *   stage  — the picture, the waveform, and the loop row under it.           (Tier 1)
		 *
		 * ⚠️ Nothing is ever drawn on top of the waveform. v0.7.0 floated four tools over the exact
		 * surface they act on; the zoom controls now live *below* it, in the loop row.
		 */
		if (Platform.isMobile) {
			root.addClass("is-mobile");
			if (Platform.isPhone) root.addClass("is-phone");
			// Declared before anything can play: an iPhone with its ringer switch off mutes all of
			// Web Audio until it is told this is media playback rather than an interface noise.
			claimAudioPlayback();
		}

		this.buildTopBar(root);

		const body = root.createDiv({ cls: "by-ear-body" });
		const rail = body.createDiv({ cls: "by-ear-rail" });
		this.el.rail = rail;
		const stage = body.createDiv({ cls: "by-ear-stage" });
		this.el.stage = stage;

		this.buildTransport(rail);
		this.buildMarkRow(rail);
		this.buildLoopToggleRow(rail);
		this.buildNudgeRow(rail);
		this.buildTempo(rail);
		this.buildTabs(rail);

		this.buildStage(stage);

		this.registerDomEvent(root, "keydown", this.onKeyDown);
		// A key or a click anywhere brings the controls back, whatever state they were left in --
		// nobody should ever have to wonder how to get the transport back.
		for (const type of ["pointerdown", "keydown"] as const) {
			this.registerDomEvent(root, type, () => this.wakeChrome());
		}
		// Leaving full screen by Esc or a system gesture must not leave the class behind, or the
		// player would sit in a full-screen layout inside a normal-sized pane.
		// Guarded on whether *we* took native full screen, not on the platform: an iPad reports as
		// mobile and does have the API, so a platform test would strand it in a full-screen layout
		// inside a normal pane after a swipe out.
		this.registerDomEvent(document, "fullscreenchange", () => {
			if (!document.fullscreenElement && this.immersive && this.native) {
				this.immersive = false;
				this.native = false;
				this.restoreFromBody();
				this.wakeChrome();
				this.relayout();
			}
		});
		// Rotating a phone or dragging a pane divider changes which shape fits.
		this.registerDomEvent(window, "resize", () => this.relayout());
		if (typeof ResizeObserver !== "undefined") {
			const observer = new ResizeObserver(() => this.relayout());
			observer.observe(root);
			this.register(() => observer.disconnect());
		}
		this.engine.onEnded = () => (this.dirty = true);

		void this.refreshLibrary();
		this.relayout();
		this.frame();
	}

	async onClose(): Promise<void> {
		if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
		// Obsidian empties this element when the view goes, so it must be back where it belongs.
		if (this.immersive) this.restoreFromBody();
		await this.closeLedger();
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		window.clearTimeout(this.statusTimer);
		this.awake.destroy();
		this.video?.destroy();
		this.video = null;
		this.waveform?.destroy();
		this.waveform = null;
		// Closing the context is the only way to retire the worklet processor -- see engine.ts.
		await this.engine.destroy();
	}

	/** Opens a song by its file name, optionally at a timestamp. The obsidian:// door. */
	async openByName(name: string, at: number | null): Promise<void> {
		if (this.library.length === 0) await this.refreshLibrary();
		const wanted = name.toLowerCase();
		const entry =
			this.library.find((e) => e.name.toLowerCase() === wanted) ??
			this.library.find((e) => e.name.toLowerCase().includes(wanted));
		if (!entry) {
			new Notice(`By Ear: no file matching “${name}” in the media folder.`);
			return;
		}
		if (this.current?.path !== entry.path) await this.openSong(entry);
		if (at !== null) {
			this.engine.seek(at);
			this.dirty = true;
		}
	}

	/** Called by the plugin when the media folder changes. */
	async refreshLibrary(): Promise<void> {
		if (Platform.isMobile) {
			try {
				const cached = await listCached();
				this.library = cached.map((c) => ({
					name: c.name,
					path: c.name,
					bytes: c.bytes,
					video: c.video,
					source: "cache" as const,
				}));
			} catch (error) {
				this.library = [];
				new Notice(`By Ear could not open its song cache: ${message(error)}`);
			}
		} else {
			const folder = this.plugin.settings.mediaFolder;
			this.library = folder ? listMedia(folder) : [];
		}
		this.index = buildIndex(this.app);
		this.renderSongName();
	}

	/**
	 * Copies chosen songs onto the device.
	 *
	 * Takes a list, not a file, because iOS gives no way to read a folder -- so the nearest thing to
	 * "point at my By Ear folder" is selecting everything in it once. Each file is reported as it
	 * lands, since a bulk import of several hundred megabytes is not instant and a silent wait looks
	 * like a hang.
	 */
	private async addFromFiles(files: File[]): Promise<void> {
		const added: string[] = [];
		const failed: string[] = [];
		for (const [i, file] of files.entries()) {
			this.setStatus(`Copying ${i + 1} of ${files.length} — ${file.name}…`, true);
			try {
				const entry = await cacheSong(file);
				added.push(entry.name);
			} catch (error) {
				// Quota is the realistic failure: a phone with little space and a 113 MB video.
				failed.push(`${file.name} (${message(error)})`);
			}
		}

		await this.refreshLibrary();
		if (failed.length > 0) {
			new Notice(`By Ear could not keep ${failed.length} of ${files.length}:\n${failed.join("\n")}`);
		}
		this.setStatus(
			`${added.length} song${added.length === 1 ? "" : "s"} on this device` +
				(failed.length > 0 ? `, ${failed.length} refused` : "") +
				". They stay until you remove them."
		);
		// Open one only if it was a single pick; a bulk import should not hijack the player.
		if (files.length === 1 && added.length === 1) {
			const entry = this.library.find((e) => e.name === added[0]);
			if (entry) await this.openSong(entry);
		}
	}

	private async forget(entry: MediaEntry): Promise<void> {
		if (entry.source !== "cache") return;
		if (this.current?.path === entry.path) {
			await this.closeLedger();
			this.current = null;
			this.engine.pause();
			this.engine.setLoop(null, null);
			this.video?.unload();
			this.waveform?.clear();
			this.duration = 0;
			this.renderMarks();
		}
		await forgetCached(entry.name);
		await this.refreshLibrary();
		// The note is untouched on purpose: the media is per-device, the work on the song is not.
		this.setStatus(`${stripExtension(entry.name)} removed from this device. Its note is untouched.`);
		this.relayout();
		this.dirty = true;
	}

	/** The searchable text for one file: its own name plus whatever its note knows about it. */
	private haystack(entry: MediaEntry): string {
		const match = findNote(this.index, entry.name);
		const bands = match ? match.bands.join(" ") : "";
		return `${entry.name} ${match?.artist ?? ""} ${bands}`.toLowerCase();
	}

	// ------------------------------------------------------------------ the control vocabulary

	/**
	 * Every pressable thing in the player is built here, and that is the point.
	 *
	 * ⚠️ Real `<button>`s with real accessible names. v0.7.0's icon controls were bare glyphs, and a
	 * rail reading `⏮ ⚑ ⊖ ⊕ ⛶` is unusable with a screen reader and unreadable to anyone who has
	 * not been told what it means.
	 *
	 * ⚠️ Note what is *not* here any more: the `tabIndex = -1` hack. A focused button swallowing the
	 * space key was a real problem -- space is play/pause, and the Bluetooth-pedal path (S9) depends
	 * on it -- but the old fix cost keyboard access, and would have had to be repeated on the
	 * fourteen controls this version adds. `onKeyDown` now cancels space before the browser turns it
	 * into a click, so buttons stay focusable and space still plays.
	 */
	private button(host: HTMLElement, label: string, aria: string, action: () => void, cls = ""): HTMLButtonElement {
		const b = host.createEl("button", { cls: `by-ear-b ${cls}`.trim(), attr: { "aria-label": aria } });
		if (label) b.setText(label);
		b.addEventListener("click", () => {
			action();
			this.dirty = true;
		});
		return b;
	}

	private iconButton(host: HTMLElement, icon: string, aria: string, action: () => void, cls = ""): HTMLButtonElement {
		const b = this.button(host, "", aria, action, `by-ear-icon ${cls}`.trim());
		setIcon(b, icon);
		return b;
	}

	/**
	 * A slider between two buttons.
	 *
	 * The buttons are why this exists. Bas asked for them on 4 September -- *"I want to be able to
	 * adjust tempo and pitch using buttons as well as the slider"* -- and on a phone an 18 pt slider
	 * thumb is not something you aim at with a guitar on your knee.
	 */
	private stepper(
		parent: HTMLElement,
		attr: Record<string, string>,
		step: number,
		unit: string,
		apply: (delta: number) => void
	): HTMLInputElement {
		const row = parent.createDiv({ cls: "by-ear-stepper" });
		this.button(row, "−", `down ${step} ${unit}`, () => apply(-step), "by-ear-step");
		const slider = row.createEl("input", { type: "range", cls: "slider", attr });
		this.button(row, "+", `up ${step} ${unit}`, () => apply(step), "by-ear-step");
		return slider;
	}

	// ------------------------------------------------------------------ zone D: the top bar

	/**
	 * What is playing, how to change it, and the way out of full screen.
	 *
	 * ⚠️ This bar exists on **every** surface, and that is the correction the 6 September audit
	 * forced. The design had filed the song picker under "rare setup" and put it on the Mac only --
	 * but on iOS the Files picker is the only mechanism by which media exists on the device at all,
	 * so the plugin could not open a song on the two devices it was written for. It is also the only
	 * way in and out of full screen on touch, where there is no Esc key.
	 */
	private buildTopBar(root: HTMLElement): void {
		const bar = root.createDiv({ cls: "by-ear-top" });

		const song = this.button(bar, "", "Choose a song", () => this.openLibrary(), "by-ear-song");
		this.el.songName = song.createSpan({ cls: "by-ear-song-name", text: "Choose a song" });
		song.createSpan({ cls: "by-ear-song-caret", text: "▾" });

		// Which note the ledger writes to. Shown here where there is width; on touch the same fact
		// sits beside the notes box instead, which is where the doubt actually happens.
		this.el.noteLink = bar.createSpan({ cls: "by-ear-note-link" });

		this.button(bar, "Save", "Write the ledger to the note now (Cmd/Ctrl+S)", () => void this.saveLedger(), "by-ear-top-save");
		this.el.fullscreen = this.button(bar, "⛶", "Full screen (f)", () => void this.toggleImmersive(), "by-ear-icon");
	}

	private openLibrary(): void {
		new LibraryModal(this.app, {
			entries: this.library,
			haystack: (e) => this.haystack(e),
			current: this.current,
			needsFolder: !Platform.isMobile && !this.plugin.settings.mediaFolder,
			onPick: (entry) => void this.openSong(entry),
			onAdd: (files) => void this.addFromFiles(files),
			onForget: (entry) => void this.forget(entry),
			onRescan: () => {
				void this.refreshLibrary();
				this.setStatus(`${this.library.length} file(s) in the folder.`);
			},
		}).open();
	}

	private renderSongName(): void {
		this.el.songName?.setText(this.current ? stripExtension(this.current.name) : "Choose a song");
	}

	// ------------------------------------------------------------------ zone B: the rail

	private buildTransport(root: HTMLElement): void {
		const row = root.createDiv({ cls: "by-ear-row by-ear-transport" });
		this.iconButton(row, "skip-back", "Back to start", () => this.engine.seek(0));
		// Dropped only where the row cannot hold four 44 px targets, which is the phone in landscape.
		this.iconButton(row, "rewind", "Back 5 s", () => this.engine.nudge(-5), "by-ear-tight-drop");
		// Named rather than found by position: the stylesheet makes this one the big target, and a
		// CSS rule counting siblings would break the day a button is reordered.
		this.el.playButton = this.iconButton(row, "play", "Play / pause (space)", () => this.togglePlay(), "by-ear-play");
		this.iconButton(row, "fast-forward", "Forward 5 s", () => this.engine.nudge(5));

		this.el.clock = root.createDiv({ cls: "by-ear-clock", text: "0:00.000 / 0:00.000" });
	}

	private buildMarkRow(root: HTMLElement): void {
		const row = root.createDiv({ cls: "by-ear-row by-ear-markrow" });
		this.button(row, "◂ ⚑", "Previous mark", () => this.jumpMark(-1));
		this.button(row, "⚑ Mark", "Drop a mark at the playhead (m)", () => this.addMark(), "by-ear-grow");
		this.button(row, "⚑ ▸", "Next mark", () => this.jumpMark(1));
	}

	private buildLoopToggleRow(root: HTMLElement): void {
		const row = root.createDiv({ cls: "by-ear-row by-ear-looptoggle" });
		this.el.loopToggle = this.button(row, "Loop", "Loop on / off (l)", () => this.toggleLoop());
		this.button(row, "Section", "Loop from the previous mark to the next (s)", () => this.loopSection(), "by-ear-grow");
	}

	/** Fine adjustment of the loop edges. Wide surfaces only -- see the stylesheet. */
	private buildNudgeRow(root: HTMLElement): void {
		const row = root.createDiv({ cls: "by-ear-row by-ear-nudgerow by-ear-wide-only" });
		this.button(row, "A ◂", "Nudge loop start back 10 ms", () => this.nudgeLoopEdge("a", -0.01));
		this.button(row, "A ▸", "Nudge loop start on 10 ms", () => this.nudgeLoopEdge("a", 0.01));
		this.button(row, "B ◂", "Nudge loop end back 10 ms", () => this.nudgeLoopEdge("b", -0.01));
		this.button(row, "B ▸", "Nudge loop end on 10 ms", () => this.nudgeLoopEdge("b", 0.01));
	}

	/**
	 * Tempo, as a percentage.
	 *
	 * ⚠️ Not a BPM, deliberately. Bas, 6 September: *"I do not want to work with bpm to change the
	 * tempo, percentages make more sense to me."* A tapped BPM is kept as a fact about the song and
	 * shown in the Tune tab; it never drives this control.
	 */
	private buildTempo(root: HTMLElement): void {
		const box = root.createDiv({ cls: "by-ear-tempo" });
		const head = box.createDiv({ cls: "by-ear-tempo-head" });
		this.el.rateValue = head.createSpan({ cls: "by-ear-tempo-value", text: "100" });
		head.createSpan({ cls: "by-ear-tempo-unit", text: "%" });
		// One tap between full speed and whatever he was working at. Hearing it up to speed and then
		// dropping straight back is a move made constantly, and hunting a slider for it every time
		// is friction at the exact moment both hands are least free.
		this.button(head, "⇄ 100%", "Swap between full speed and your working tempo", () => this.swapTempo(), "by-ear-tempo-swap");

		const rate = this.stepper(
			box,
			{ min: String(RATE_MIN), max: String(RATE_MAX), step: "1", value: "100", "aria-label": "Tempo, percent" },
			RATE_STEP,
			"percent",
			(delta) => this.adjustRate(delta)
		);
		rate.addEventListener("input", () => {
			this.engine.setRate(Number(rate.value) / 100);
			this.syncKnobUi();
			this.dirty = true;
		});
		this.el.rate = rate;
	}

	// ------------------------------------------------------------------ zone C: the tabs

	private buildTabs(root: HTMLElement): void {
		const wrap = root.createDiv({ cls: "by-ear-tabs-wrap" });
		this.el.tabsWrap = wrap;

		const strip = wrap.createDiv({ cls: "by-ear-tabs", attr: { role: "tablist" } });
		const panel = wrap.createDiv({ cls: "by-ear-panel" });
		this.el.tabs = [];

		const tabs: [TabId, string, string][] = [
			["marks", "Marks", "⚑"],
			["notes", "Notes", "✎"],
			["tune", "Tune", "♯"],
		];
		for (const [id, label, glyph] of tabs) {
			const tab = this.button(strip, "", label, () => this.showTab(id), "by-ear-tab");
			tab.setAttr("role", "tab");
			tab.setAttr("data-tab", id);
			// Both spellings ship, and the stylesheet shows the glyph only where there is no width
			// for the word. Two DOM builds for one strip is how the phone layouts drifted apart in
			// the design drafts; one build cannot.
			tab.createSpan({ cls: "by-ear-tab-word", text: label });
			tab.createSpan({ cls: "by-ear-tab-glyph", text: glyph });
			this.el.tabs.push(tab);

			this.el.panes[id] = panel.createDiv({ cls: "by-ear-pane", attr: { "data-pane": id, role: "tabpanel" } });
		}

		this.el.markList = this.el.panes.marks.createDiv({ cls: "by-ear-marklist" });
		this.buildNotesPane(this.el.panes.notes);
		this.buildTunePane(this.el.panes.tune);
		this.showTab("marks");
		this.renderMarkList();
	}

	private showTab(id: TabId): void {
		this.tab = id;
		for (const tab of this.el.tabs) tab.setAttr("aria-selected", String(tab.getAttr("data-tab") === id));
		for (const key of Object.keys(this.el.panes) as TabId[]) this.el.panes[key].hidden = key !== id;
	}

	/**
	 * The notes pane: the box, and the receipt.
	 *
	 * The box *is* the note's `## Findings` section -- not an inbox that appends. What he types here
	 * is what the note says, so there is one text and no reconciling to do later.
	 *
	 * ⚠️ The receipt sits directly under the box, and that placement is the whole point. The write
	 * already worked without it -- but it landed at the bottom of a long chart, below a collapsed
	 * lyrics callout, and said nothing; Bas typed, opened the chart, saw nothing and reasonably
	 * concluded it was broken. The doubt happens *while typing*, so the evidence belongs there and
	 * not in a header on the far side of the screen. The v0.7.0 design had removed it entirely.
	 */
	private buildNotesPane(root: HTMLElement): void {
		const findings = root.createEl("textarea", {
			cls: "by-ear-findings",
			attr: {
				placeholder: "What you are hearing — written straight into the song's note.",
				"aria-label": "Findings, written into the song's note",
			},
		});
		findings.addEventListener("input", () => {
			this.ledger.findings = findings.value;
			this.queueSave();
		});
		this.el.findings = findings;

		const foot = root.createDiv({ cls: "by-ear-notes-foot" });
		this.el.saveState = foot.createSpan({ cls: "by-ear-save-state", text: "" });
		this.button(foot, "Save", "Write the ledger to the note now (Cmd/Ctrl+S)", () => void this.saveLedger(), "by-ear-save");
	}

	private buildTunePane(root: HTMLElement): void {
		root.createDiv({ cls: "by-ear-lbl", text: "Pitch" });
		const semitones = this.stepper(
			root,
			{ min: "-12", max: "12", step: "1", value: "0", "aria-label": "Pitch, semitones" },
			SEMITONE_STEP,
			"semitone",
			(delta) => this.adjustPitch(delta)
		);
		// The cents buttons move the same single number -- a fraction of a semitone is cents.
		const cents = this.stepper(
			root,
			{ min: "-100", max: "100", step: "1", value: "0", "aria-label": "Pitch, cents" },
			CENT_STEP,
			"cents",
			(delta) => this.adjustPitch(delta / 100)
		);
		const applyPitch = () => {
			// Fractional semitones *are* cents in this engine, so there is one number, not two
			// systems -- which is why the cents slider costs nothing.
			this.engine.setSemitones(Number(semitones.value) + Number(cents.value) / 100);
			this.syncKnobUi();
			this.dirty = true;
		};
		semitones.addEventListener("input", applyPitch);
		cents.addEventListener("input", applyPitch);
		this.el.semitones = semitones;
		this.el.cents = cents;
		this.el.pitchValue = root.createDiv({ cls: "by-ear-readout", text: "0 st, 0 ¢" });

		root.createDiv({ cls: "by-ear-lbl", text: "Song tempo" });
		const tapRow = root.createDiv({ cls: "by-ear-row" });
		this.button(tapRow, "Tap ×4", "Tap in time to record this song's tempo", () => this.tapTempo());
		this.el.bpmValue = this.button(tapRow, "— bpm", "The song's tapped tempo — press to clear it", () => this.clearTaps());

		// Only where there are frames to step through. Absent on an mp3 rather than greyed out:
		// nothing in this player is ever disabled.
		const frame = root.createDiv({ cls: "by-ear-frame" });
		frame.createDiv({ cls: "by-ear-lbl", text: "Frame" });
		const frames = frame.createDiv({ cls: "by-ear-row" });
		this.button(frames, "◂", "Back one frame", () => this.stepFrame(-1));
		this.button(frames, "▸", "On one frame", () => this.stepFrame(1));
		this.el.frameRow = frame;

		const reset = root.createDiv({ cls: "by-ear-row by-ear-reset" });
		this.button(reset, "Reset tempo & pitch", "Reset tempo and pitch (0)", () => this.resetKnobs());

		if (!Platform.isMobile) this.buildKeyLegend(root);
	}

	/**
	 * The remaining shortcuts, folded into the Tune tab.
	 *
	 * Four of the fourteen are printed on the controls that fire them; these are the other ten. They
	 * used to have a panel of their own in the view, which is a lot of permanent screen for
	 * documentation -- but deleting them outright would have taken the only record of `[ ]`, `x`,
	 * `0` and the wheel, and the pedal path depends on knowing they exist.
	 */
	private buildKeyLegend(root: HTMLElement): void {
		const details = root.createEl("details", { cls: "by-ear-keys" });
		details.createEl("summary", { text: "Keyboard" });
		const list = details.createEl("dl");
		const keys: [string, string][] = [
			["space", "play / pause"],
			["← →", "nudge 1 s  (shift: 5 s)"],
			["⌘/ctrl S", "save the ledger to the note"],
			["F / esc", "full screen, and back"],
			["M", "drop a mark here"],
			["S", "loop this section (mark to mark)"],
			["A / B", "set loop start / end at the playhead"],
			["L", "loop on / off"],
			["X", "clear the loop"],
			["[ ]", "nudge A by 10 ms  (shift: nudge B)"],
			["↑ ↓", `tempo ± ${RATE_STEP}%`],
			["- =", `pitch ± ${SEMITONE_STEP} semitone  (shift: ± ${CENT_STEP} cents)`],
			["0", "reset tempo and pitch"],
			["wheel", "zoom around the pointer  (shift: pan)"],
		];
		for (const [key, what] of keys) {
			list.createEl("dt", { text: key });
			list.createEl("dd", { text: what });
		}
	}

	// ------------------------------------------------------------------ zone A: the stage

	private buildStage(root: HTMLElement): void {
		// The picture sits in its own box above the waveform rather than behind it: a waveform drawn
		// over hands is unreadable, and hands behind a waveform are worse.
		const screen = root.createDiv({ cls: "by-ear-screen" });
		this.video = new VideoScreen(screen);
		// Tap the picture to hide the apparatus and get back to just the hands. The listener is on
		// the box rather than the video so it still works where the video failed to load.
		screen.addEventListener("click", () => this.toggleChrome());

		const box = root.createDiv({ cls: "by-ear-wavebox" });
		const wrap = box.createDiv({ cls: "by-ear-wave-wrap" });
		const canvas = wrap.createEl("canvas", { cls: "by-ear-wave" });
		this.el.canvas = canvas;

		this.waveform = new Waveform(canvas, {
			onSeek: (time) => {
				this.engine.seek(time);
				this.dirty = true;
			},
			onLoopChange: (a, b) => {
				this.engine.setLoop(a, b);
				// A region you just dragged is a region you want to hear, so arm it.
				if (this.engine.hasLoop()) this.engine.setLooping(true);
				this.syncLoopUi();
				this.dirty = true;
			},
			onDragPreview: () => (this.dirty = true),
			onMarkTap: (i) => {
				const mark = this.ledger.marks[i];
				if (!mark) return;
				this.engine.seek(mark.time);
				this.dirty = true;
			},
			onMarkHold: (i) => this.renameMark(i),
		});

		// The waveform owns its own pointer handling; this just keeps the frame loop awake for it.
		for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"] as const) {
			this.registerDomEvent(canvas, type, () => (this.dirty = true));
		}

		this.buildEdgeRow(box);
		this.buildReport(box);
	}

	/**
	 * Set A, Set B, Clear and the zoom, in one row under the waveform.
	 *
	 * ⚠️ A and B are **buttons**, not a readout, and that is the fix for the phone. There is no room
	 * for a nudge pair on a 369 pt screen, and the waveform there is about 70 pt tall -- so without
	 * these the only way to make a loop on an iPhone was dragging a sliver of canvas. Tapping the A
	 * half sets A at the playhead, which is exactly what the `a` key does.
	 *
	 * The zoom lives here rather than floating on the waveform, which is what v0.7.0 did: four
	 * controls painted over the exact surface they act on.
	 */
	private buildEdgeRow(host: HTMLElement): void {
		const row = host.createDiv({ cls: "by-ear-row by-ear-edgerow" });

		const edge = (which: "a" | "b"): HTMLElement => {
			const b = this.button(
				row,
				"",
				which === "a" ? "Set the loop start at the playhead (a)" : "Set the loop end at the playhead (b)",
				() => this.setLoopEdge(which),
				"by-ear-edge"
			);
			b.createSpan({ cls: "by-ear-edge-lbl", text: which.toUpperCase() });
			return b.createSpan({ cls: "by-ear-edge-time", text: "—" });
		};
		this.el.edgeA = edge("a");
		this.el.edgeB = edge("b");
		this.el.loopLen = row.createDiv({ cls: "by-ear-loop-len", text: "no loop" });

		this.button(row, "✕", "Clear the loop (x)", () => {
			this.engine.setLoop(null, null);
			this.syncLoopUi();
		}, "by-ear-icon");
		this.button(row, "⊖", "Zoom out", () => this.waveform?.zoomBy(2, this.engine.position()), "by-ear-icon");
		this.button(row, "⊕", "Zoom in", () => this.waveform?.zoomBy(0.5, this.engine.position()), "by-ear-icon");
		// A word rather than a glyph: `⤢` was already the full-screen button, and two controls
		// sharing one glyph is worse at arm's length than it looks on a design sheet.
		this.button(row, "Fit", "Fit the whole song", () => this.waveform?.fit(), "by-ear-fit");
	}

	/**
	 * One line that exists only when there is something to say.
	 *
	 * ⚠️ Restored after the 6 September audit found the design had deleted the status line
	 * altogether. It is the only surface that reports `Reading…`, a bulk import's progress and --
	 * the one that matters -- `Sound only`, with the MediaError reason and the blob it was handed.
	 * v0.4.0 showed a blank video box on iOS for two days and said nothing; this is what stopped
	 * that happening again. Zero height when idle, so it costs nothing on a good day.
	 */
	private buildReport(host: HTMLElement): void {
		const line = host.createDiv({ cls: "by-ear-report", attr: { role: "status" } });
		line.hidden = true;
		this.el.report = line;
	}

	/**
	 * Rename or delete one mark.
	 *
	 * A modal rather than an inline field: a flag is a few pixels of canvas, and editing text on a
	 * canvas means faking a caret. Held for half a second, this is the deliberate gesture -- tapping
	 * has already been spent on the thing you do ninety-nine times out of a hundred, which is jump
	 * to the mark.
	 */
	private renameMark(index: number): void {
		const mark = this.ledger.marks[index];
		if (!mark) return;
		const modal = new Modal(this.app);
		modal.titleEl.setText(`Mark at ${formatTime(mark.time)}`);
		const input = modal.contentEl.createEl("input", {
			type: "text",
			cls: "by-ear-rename",
			attr: { value: mark.name, placeholder: "name this mark", "aria-label": "Mark name" },
		});
		const commit = () => {
			this.ledger.marks[index].name = input.value.trim();
			this.renderMarks();
			this.queueSave();
			modal.close();
		};
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") commit();
		});

		const row = modal.contentEl.createDiv({ cls: "by-ear-rename-row" });
		const save = row.createEl("button", { text: "Save", cls: "mod-cta" });
		save.addEventListener("click", commit);
		const remove = row.createEl("button", { text: "Delete", cls: "mod-warning" });
		remove.addEventListener("click", () => {
			this.ledger.marks.splice(index, 1);
			this.renderMarks();
			this.queueSave();
			modal.close();
		});

		modal.open();
		window.setTimeout(() => input.focus(), 0);
	}

	// ------------------------------------------------------------------ actions

	private async openSong(entry: MediaEntry): Promise<void> {
		// Whatever the last song learned goes in before the next one is read.
		await this.closeLedger();
		this.setStatus(`Reading ${entry.name}…`, true);
		try {
			/*
			 * One read, then one decode. The order matters on a phone.
			 *
			 * `decodeAudioData` detaches the ArrayBuffer it is given, so the video cannot share it.
			 * On iOS the cache hands back a Blob, so the picture costs nothing extra and the bytes
			 * for decoding are pulled out of it once. On desktop the file is read as bytes and the
			 * Blob is made from them before decoding frees them -- a transient second copy, which is
			 * affordable on a Mac and is not on a phone. That asymmetry is the whole reason the
			 * cache stores Blobs.
			 */
			const blob =
				entry.source === "cache"
					? await readCachedBlob(entry.name)
					: new Blob([readMedia(entry.path)], { type: mimeFor(entry.name) });
			const bytes = await blob.arrayBuffer();

			const started = performance.now();
			const song = await this.engine.load(bytes, entry.name);
			this.current = entry;
			this.duration = song.duration;
			this.waveform?.setSong(song.peaksSource, song.sampleRate, song.duration);
			this.renderSongName();

			// A file whose audio decoded but whose picture will not show should still play -- but it
			// must SAY so. A blank box where a video should be is exactly the silent failure this
			// project keeps relearning: v0.4.0 showed one on iOS for two days and reported nothing.
			let pictureNote = "";
			if (entry.video) {
				const result = await this.video?.load(blob);
				if (result && !result.ok) {
					// Says what went wrong and what it was handed, because the next move depends on
					// which of those it is -- and a status line that only says "failed" is how the
					// last fix came to be a guess.
					pictureNote =
						`Sound only — ${result.why}` +
						` [${result.blob.type || "no type"}, ${(result.blob.size / 1e6).toFixed(1)} MB]. The audio is fine.`;
				}
			} else {
				this.video?.unload();
			}
			// After the picture is known, because the layout depends on whether there is one.
			this.relayout();
			this.resetKnobs();
			this.taps = [];
			this.syncLoopUi();
			this.dirty = true;
			// After resetKnobs, so a saved tempo and pitch win over the defaults.
			await this.loadLedger(entry);
			// The tab title is the only place the song name stays visible once the view is a tab,
			// and `getDisplayText()` is only re-read when the leaf is asked to redraw its header.
			// That method is real but untyped, so it is reached defensively rather than assumed.
			(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();

			// A warning stays until the next song. A fact about a file that opened perfectly well
			// does not need to sit under the waveform for the rest of the sitting.
			if (pictureNote) this.setStatus(pictureNote, true);
			else
				this.setStatus(
					`${stripExtension(entry.name)} · ${formatTime(song.duration)} · ` +
						`${song.sampleRate} Hz · decoded in ${Math.round(performance.now() - started)} ms`
				);
		} catch (error) {
			const why = message(error);
			new Notice(`By Ear could not open that file: ${why}`);
			this.setStatus(`Failed to open ${entry.name} — ${why}`, true);
		}
	}

	private setLoopEdge(which: "a" | "b"): void {
		const at = this.engine.position();
		const { loopA, loopB } = this.engine.transport;
		if (which === "a") this.engine.setLoop(at, loopB ?? Math.min(this.duration, at + 2));
		else this.engine.setLoop(loopA ?? Math.max(0, at - 2), at);
		if (this.engine.hasLoop()) this.engine.setLooping(true);
		this.syncLoopUi();
	}

	private nudgeLoopEdge(which: "a" | "b", seconds: number): void {
		const { loopA, loopB } = this.engine.transport;
		if (loopA === null || loopB === null) return;
		if (which === "a") this.engine.setLoop(loopA + seconds, loopB);
		else this.engine.setLoop(loopA, loopB + seconds);
		this.syncLoopUi();
	}

	/**
	 * The single play/pause route.
	 *
	 * One method rather than two call sites, because the iOS nudge has to happen inside a real user
	 * gesture -- and a second entry point that forgot it would be silent only on a phone, only with
	 * the ringer switch off, which is about the worst bug to go looking for.
	 */
	private togglePlay(): void {
		if (Platform.isMobile) nudgeAudioSession();
		this.engine.toggle();
	}

	/**
	 * ⚠️ Never a silent no-op.
	 *
	 * Pressing Loop with no A and B used to flip a flag that had nothing to loop: nothing happened
	 * and nothing was said -- the same shape as the meter that never reported, the write that landed
	 * invisibly and the Zoom button that ignored you. So with no loop set, Loop *makes* one: the
	 * section the playhead is standing in if there are marks, and a two-second region from here if
	 * there are not. Either way the button does what its label promises.
	 *
	 * This is also why Loop is never hidden. "Absent rather than disabled" is right for a control
	 * that cannot apply -- frame step on an mp3 -- and wrong for one that can always be made to.
	 */
	private toggleLoop(): void {
		if (!this.engine.hasLoop()) {
			if (this.ledger.marks.length > 0) this.loopSection();
			else this.setLoopEdge("a");
			return;
		}
		this.engine.setLooping(!this.engine.transport.looping);
		this.syncLoopUi();
	}

	/** One tap between full speed and the tempo he was actually working at. */
	private swapTempo(): void {
		const rate = this.engine.transport.rate;
		if (Math.abs(rate - 1) < 0.005) {
			this.setRate(this.workingRate);
		} else {
			this.workingRate = rate;
			this.setRate(1);
		}
	}

	/**
	 * Tap tempo -- a fact about the song, never a grid.
	 *
	 * ⚠️ What this deliberately does NOT do is snap anything. Beat snapping was proposed and Bas
	 * rejected it on 6 September: *"it just seems a lot of risk for errors, and I do not think about
	 * bpm while playing anyway."* He was right twice over -- a live recording is not at a constant
	 * tempo, so the error compounds with distance from any anchor, and a grid drawn on the waveform
	 * is a machine's opinion about where the beat is. His ear places the loop edge.
	 *
	 * Averaged across the whole run of taps rather than the last interval, because one clumsy tap in
	 * eight should move the answer by an eighth, not replace it.
	 */
	private tapTempo(): void {
		const now = performance.now();
		const last = this.taps[this.taps.length - 1];
		if (last !== undefined && now - last > TAP_RESET_MS) this.taps = [];
		this.taps.push(now);
		if (this.taps.length > 8) this.taps.shift();

		if (this.taps.length >= 2) {
			const span = this.taps[this.taps.length - 1] - this.taps[0];
			const bpm = (60000 * (this.taps.length - 1)) / span;
			// Outside this range it is a mis-tap, not a tempo.
			if (bpm >= 30 && bpm <= 300) {
				this.ledger.bpm = bpm;
				this.queueSave();
			}
		}
		this.renderBpm();
	}

	private clearTaps(): void {
		this.taps = [];
		this.ledger.bpm = null;
		this.queueSave();
		this.renderBpm();
	}

	private renderBpm(): void {
		const bpm = this.ledger.bpm;
		this.el.bpmValue?.setText(bpm === null ? "— bpm" : `${Math.round(bpm)} bpm`);
	}

	/**
	 * One frame, on the engine's clock rather than the video's.
	 *
	 * Seeking the video element directly would put the picture somewhere the music is not, which is
	 * the one failure the whole A/V design exists to prevent -- so the transport moves and the
	 * picture follows it, exactly as it does at every other moment.
	 */
	private stepFrame(direction: number): void {
		this.engine.seek(Math.max(0, Math.min(this.duration, this.engine.position() + direction * FRAME)));
	}

	private resetKnobs(): void {
		this.engine.setRate(1);
		this.engine.setSemitones(0);
		if (this.el.rate) this.el.rate.value = "100";
		if (this.el.semitones) this.el.semitones.value = "0";
		if (this.el.cents) this.el.cents.value = "0";
		this.syncKnobUi();
	}

	/** Absolute setters, so restoring a saved value and nudging one share the same path. */
	private setRate(rate: number): void {
		const clamped = Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(rate * 100)));
		this.engine.setRate(clamped / 100);
		if (this.el.rate) this.el.rate.value = String(clamped);
		this.syncKnobUi();
	}

	private setPitch(semitones: number): void {
		const next = Math.min(12, Math.max(-12, semitones));
		this.engine.setSemitones(next);
		const whole = next < 0 ? Math.ceil(next) : Math.floor(next);
		if (this.el.semitones) this.el.semitones.value = String(whole);
		if (this.el.cents) this.el.cents.value = String(Math.round((next - whole) * 100));
		this.syncKnobUi();
	}

	private adjustRate(deltaPercent: number): void {
		const next = Math.round(this.engine.transport.rate * 100) + deltaPercent;
		const clamped = Math.min(RATE_MAX, Math.max(RATE_MIN, next));
		this.engine.setRate(clamped / 100);
		if (this.el.rate) this.el.rate.value = String(clamped);
		this.syncKnobUi();
	}

	private adjustPitch(deltaSemitones: number): void {
		const next = Math.min(12, Math.max(-12, this.engine.transport.semitones + deltaSemitones));
		this.engine.setSemitones(next);
		// Split the single number back across the two sliders so the UI keeps telling the truth.
		const whole = next < 0 ? Math.ceil(next) : Math.floor(next);
		if (this.el.semitones) this.el.semitones.value = String(whole);
		if (this.el.cents) this.el.cents.value = String(Math.round((next - whole) * 100));
		this.syncKnobUi();
	}

	// ------------------------------------------------------------------ full screen

	/**
	 * Immersive mode: the picture takes the room, the apparatus gets out of the way.
	 *
	 * ⚠️ Two mechanisms, because the platforms genuinely differ and only one of them is available
	 * everywhere. **The CSS overlay is the real one** -- `position: fixed` over everything, which
	 * works on all three devices because Obsidian's own interface is just HTML in the same document.
	 * The **native Fullscreen API is an enhancement** layered on top where it exists: macOS and
	 * iPadOS have it, and on the iPhone `Element.requestFullscreen` is unavailable (Safari 17.2 put
	 * it behind a flag, which a WKWebView does not get). Building on the API alone would have meant
	 * no full screen on the phone at all.
	 *
	 * ⚠️ And the obvious iPhone route is a trap. `video.webkitEnterFullscreen()` does work there,
	 * but it hands the picture to the **native iOS player** -- which brings its own scrubber and its
	 * own play button. Scrub that and the video moves while the engine does not: the picture would
	 * be somewhere the music is not, silently, which is the one failure this whole design is built
	 * to prevent. So it is never called, on any platform.
	 */
	private async toggleImmersive(): Promise<void> {
		this.immersive = !this.immersive;

		if (this.immersive) {
			/*
			 * ⚠️ The element is moved to `document.body`, and that is not optional.
			 *
			 * `position: fixed` resolves against the nearest ancestor with a transform, not against
			 * the viewport — and Obsidian's mobile shell transforms its panes to slide them. So the
			 * "full screen" overlay was being trapped inside the leaf: on an iPhone in landscape the
			 * whole player sat in a corner while Obsidian owned the rest of the screen. Nothing about
			 * that is fixable in CSS; the element has to leave the transformed subtree.
			 *
			 * Reparenting is remembered exactly, and undone on exit and on close, because Obsidian
			 * still owns this element and will empty it when the view goes.
			 */
			this.home = { parent: this.contentEl.parentElement, next: this.contentEl.nextSibling };
			document.body.appendChild(this.contentEl);
			this.contentEl.addClass("is-immersive");
		} else {
			this.restoreFromBody();
		}

		const el = this.contentEl as HTMLElement & { requestFullscreen?: () => Promise<void> };
		try {
			if (this.immersive) {
				// An enhancement, never the mechanism: macOS and iPadOS have it, the iPhone does not.
				if (document.fullscreenEnabled && el.requestFullscreen) {
					await el.requestFullscreen();
					this.native = true;
				}
			} else if (document.fullscreenElement) {
				await document.exitFullscreen();
				this.native = false;
			}
		} catch {
			// Refused or unsupported. The overlay alone is still a full-screen picture.
		}
		this.relayout();
	}

	/** Puts the element back exactly where Obsidian left it. */
	private restoreFromBody(): void {
		this.contentEl.removeClass("is-immersive");
		const home = this.home;
		this.home = null;
		if (!home?.parent) return;
		home.parent.insertBefore(this.contentEl, home.next);
	}

	/**
	 * Shows the controls again. There is no timer.
	 *
	 * ⚠️ v0.5.0 faded them after a few seconds, which is what every video player does — and it was
	 * wrong here. That pattern is designed for **watching**, where the chrome is a distraction from
	 * the content. This is **practising**: the loop, the tempo and the marks *are* the content, and
	 * they are reached for constantly while both hands are busy on a guitar.
	 */
	private wakeChrome(): void {
		this.contentEl.removeClass("chrome-hidden");
	}

	/**
	 * Side by side or stacked — and where the tabs live.
	 *
	 * ⚠️ Measured on the *player's own box*, not the window: it may be a pane beside other panes, and
	 * a window-wide test would give a rail to a column too narrow to hold one.
	 *
	 * The second decision is new in v0.8.0. With no picture, the room the picture is not using is
	 * **wide**, and a 256 px rail is the wrong place to spend it — so the tabs and their panel move
	 * down into the stage, where Notes gets a page instead of a slot. They travel together, because
	 * a tab strip has to sit directly above the thing it switches: the rule is the relationship, not
	 * the location.
	 */
	private relayout(): void {
		const box = this.contentEl.getBoundingClientRect();
		const wide = box.width >= 720 && box.width > box.height;
		this.contentEl.toggleClass("is-wide", wide);

		const hasPicture = this.video?.hasPicture === true;
		this.contentEl.toggleClass("has-video", hasPicture);
		if (this.el.frameRow) this.el.frameRow.hidden = !hasPicture;

		const wrap = this.el.tabsWrap;
		const host = wide && !hasPicture ? this.el.stage : this.el.rail;
		if (wrap && host && wrap.parentElement !== host) host.appendChild(wrap);

		this.dirty = true;
	}

	/** Tapping the picture toggles the apparatus. Only in full screen, where there is a reason to. */
	private toggleChrome(): void {
		if (!this.immersive) return;
		this.contentEl.toggleClass("chrome-hidden", !this.contentEl.hasClass("chrome-hidden"));
	}

	// ------------------------------------------------------------------ marks

	private addMark(): void {
		if (!this.note) {
			this.setStatus("Open a song first — a mark has to be written into its note.", true);
			return;
		}
		const time = this.engine.position();
		// A mark within a few frames of an existing one is a double-press, not a second mark.
		if (this.ledger.marks.some((m) => Math.abs(m.time - time) < 0.05)) return;
		this.ledger.marks.push({ time, name: "" });
		this.ledger.marks.sort((a, b) => a.time - b.time);
		this.renderMarks();
		this.queueSave();
	}

	/** Previous or next mark from where the playhead stands. */
	private jumpMark(direction: number): void {
		const marks = this.ledger.marks;
		if (marks.length === 0) return;
		const at = this.engine.position();
		// The back-step tolerance is wider than the forward one on purpose: pressing "previous"
		// just after a mark passed means "that one again", not "the one before it".
		const target =
			direction < 0
				? [...marks].reverse().find((m) => m.time < at - 0.25)
				: marks.find((m) => m.time > at + 0.05);
		if (!target) return;
		this.engine.seek(target.time);
		this.dirty = true;
	}

	/**
	 * Loops the section the playhead is standing in: from the mark behind it to the mark ahead.
	 *
	 * This is the whole point of marks as a separate thing from loops. Marks divide the song once;
	 * the loop then moves between them without ever being dragged again.
	 */
	private loopSection(): void {
		const marks = this.ledger.marks;
		if (marks.length === 0) {
			// Not a Notice that leaves nothing behind: make the loop it could not find.
			this.setLoopEdge("a");
			this.setStatus("No marks yet, so this is a two-second loop from here. ⚑ Mark drops one.");
			return;
		}
		const at = this.engine.position();
		const before = [...marks].reverse().find((m) => m.time <= at + 0.001);
		const after = marks.find((m) => m.time > at + 0.001);
		const a = before ? before.time : 0;
		const b = after ? after.time : this.duration;
		if (b - a < 0.05) return;
		this.engine.setLoop(a, b);
		this.engine.setLooping(true);
		this.engine.seek(a);
		this.syncLoopUi();
		this.dirty = true;
	}

	/** Marks live in two places: flags on the waveform, and rows in the Marks tab. */
	private renderMarks(): void {
		this.waveform?.setMarks(this.ledger.marks);
		this.renderMarkList();
		this.dirty = true;
	}

	private renderMarkList(): void {
		const list = this.el.markList;
		if (!list) return;
		list.empty();
		if (this.ledger.marks.length === 0) {
			list.createDiv({
				cls: "by-ear-empty",
				text: this.current
					? "No marks yet. ⚑ Mark drops one where the playhead is."
					: "Choose a song to start marking it up.",
			});
			return;
		}
		this.ledger.marks.forEach((mark, i) => {
			const row = list.createDiv({ cls: "by-ear-mk" });
			const jump = this.button(
				row,
				"",
				`Jump to ${mark.name || "the mark"} at ${formatTime(mark.time)}`,
				() => {
					this.engine.seek(mark.time);
					this.dirty = true;
				},
				"by-ear-mk-jump"
			);
			jump.createSpan({ cls: "by-ear-mk-flag" });
			jump.createSpan({ cls: "by-ear-mk-name", text: mark.name || "unnamed" });
			jump.createSpan({ cls: "by-ear-mk-time", text: formatTime(mark.time).slice(0, -4) });
			// A visible rename control as well as the 550 ms hold on the flag: a gesture nobody has
			// been told about is not an affordance, and a hold cannot be reached from a keyboard.
			this.iconButton(
				row,
				"pencil",
				`Rename or delete the mark at ${formatTime(mark.time)}`,
				() => this.renameMark(i),
				"by-ear-mk-edit"
			);
		});
	}

	// ------------------------------------------------------------------ the ledger

	/**
	 * Binds this media file to its note and restores everything the note remembers.
	 *
	 * The note is found, never invented, in the order settled on 4 September: an explicit `media:`
	 * key, then the Songbook chart, then a study note, and only then a new file. Fourteen of the
	 * seventeen songs in the folder are Songbook repertoire, so the ordinary outcome is a chart.
	 */
	private async loadLedger(entry: MediaEntry): Promise<void> {
		this.index = buildIndex(this.app);
		let match = findNote(this.index, entry.name);
		if (!match) {
			const file = await createNote(this.app, this.plugin.settings.noteFolder, entry.name);
			this.index = buildIndex(this.app);
			match = findNote(this.index, entry.name) ?? { file, how: "byear", artist: "", bands: [] };
		} else if (match.how !== "media") {
			// Record the binding so the next lookup is a fact rather than a title guess.
			await bindMedia(this.app, match.file, entry.name);
		}

		this.note = match;
		const content = await this.app.vault.read(match.file);
		this.ledger = readLedger(this.app, match.file, content);
		this.openedAt = Date.now();

		this.restoring = true;
		if (this.ledger.tempo !== null) this.setRate(this.ledger.tempo);
		if (this.ledger.semitones !== null) this.setPitch(this.ledger.semitones);
		if (this.ledger.loopA !== null && this.ledger.loopB !== null) {
			this.engine.setLoop(this.ledger.loopA, this.ledger.loopB);
			// Restored armed if it was armed: "where I left it" includes whether it was running.
			this.engine.setLooping(this.ledger.loopOn);
		}
		this.restoring = false;
		// The song's region inside the file: a 19-minute medley holds more than one song.
		if (this.ledger.mediaStart !== null) this.engine.seek(this.ledger.mediaStart);

		if (this.el.findings) this.el.findings.value = this.ledger.findings;
		this.renderMarks();
		this.renderBpm();
		this.renderNoteLink();
		this.renderSaveState("", false);
		this.syncLoopUi();
		this.dirty = true;
	}

	private renderNoteLink(): void {
		const el = this.el.noteLink;
		if (!el) return;
		el.empty();
		if (!this.note) return;
		const how = { media: "bound", chart: "chart", study: "study", byear: "by-ear note" }[this.note.how];
		el.createSpan({ text: "writing to " });
		const link = el.createEl("a", { text: this.note.file.basename, href: "#" });
		// Opens *at the ledger*, not at the top. On a chart the ledger is below the lyrics callout,
		// which is a long way down -- landing at line 1 is what made it look like nothing happened.
		link.addEventListener("click", (event) => {
			event.preventDefault();
			void this.revealLedger();
		});
		el.createSpan({ cls: "by-ear-note-how", text: `  (${how})` });
	}

	private async revealLedger(): Promise<void> {
		if (!this.note) return;
		const file = this.note.file;
		const content = await this.app.vault.read(file);
		const at = content.indexOf(LEDGER_MARKER);
		const line = at < 0 ? 0 : content.slice(0, at).split("\n").length;
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file, { eState: { line } });
	}

	/** The receipt. With nothing to report it names the note, so the destination is never a mystery. */
	private renderSaveState(text: string, pending: boolean): void {
		const el = this.el.saveState;
		if (!el) return;
		el.setText(text || (this.note ? `→ ${this.note.file.basename}` : ""));
		el.toggleClass("is-pending", pending);
	}

	/**
	 * Saves a second after the last change rather than on every keystroke.
	 *
	 * The note may be open in an editor and syncing to an iPad at the same time, and `vault.process`
	 * rewrites the whole file. Debouncing keeps that to once per thought instead of once per letter.
	 */
	private queueSave(): void {
		this.unsaved = true;
		this.renderSaveState("unsaved…", true);
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.saveLedger(), 1000);
	}

	private async saveLedger(): Promise<void> {
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = 0;
		if (!this.note) return;
		this.captureTransport(false);
		try {
			await writeLedger(this.app, this.note.file, this.ledger);
			this.unsaved = false;
			const now = new Date();
			const time = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`;
			this.renderSaveState(`saved ${time} → ${this.note.file.basename}`, false);
		} catch (error) {
			this.renderSaveState("could not save", true);
			new Notice(`By Ear could not write the note: ${message(error)}`);
		}
	}

	/**
	 * Ends a sitting: flush the ledger, and append one dated line of facts.
	 *
	 * Facts only -- date, minutes, the tempo and pitch it was worked at. No count, no streak, no
	 * judgement about whether the session was good. Under a minute is not a sitting and is dropped,
	 * because opening a file to check something is not practice.
	 */
	private async closeLedger(): Promise<void> {
		if (!this.note) return;
		const minutes = (Date.now() - this.openedAt) / 60000;
		if (minutes >= 1) {
			this.ledger.sittings.push(
				sittingLine(minutes, this.engine.transport.rate, this.engine.transport.semitones)
			);
		}
		await this.saveLedger();
		this.note = null;
		this.ledger = emptyLedger();
	}

	// ------------------------------------------------------------------ keyboard

	private onKeyDown = (event: KeyboardEvent): void => {
		const target = event.target as HTMLElement | null;

		// Before every focus guard below: the moment he most wants to save is while typing in the
		// findings box, and that is exactly the case the guards bail out of.
		if ((event.metaKey || event.ctrlKey) && (event.key === "s" || event.key === "S")) {
			event.preventDefault();
			void this.saveLedger();
			return;
		}
		/*
		 * ⚠️ Space belongs to play/pause, whatever has focus.
		 *
		 * A focused button turns the space key into a click on itself, so tapping any control once
		 * would quietly steal the spacebar -- and the spacebar is also the Bluetooth-pedal path
		 * (S9). v0.7.0 solved that by making two stepper buttons unfocusable, which cost keyboard
		 * access and would have had to be repeated on the fourteen controls added here. Cancelling
		 * the key stops the browser synthesising the click, and every button stays reachable.
		 */
		if (event.key === " " && target?.tagName === "BUTTON") {
			event.preventDefault();
			this.togglePlay();
			this.dirty = true;
			return;
		}
		// Let a focused slider keep its own arrow keys.
		if (target && target.tagName === "INPUT" && (target as HTMLInputElement).type === "range") {
			if (event.key.startsWith("Arrow")) return;
		}
		// A focused text field keeps every key -- typing "some" in the findings box must not drop
		// two marks and start a loop.
		if (target && (target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
		if (target && target.tagName === "INPUT" && (target as HTMLInputElement).type !== "range") return;

		const shift = event.shiftKey;
		let handled = true;

		switch (event.key) {
			case " ":
				this.togglePlay();
				break;
			case "ArrowLeft":
				this.engine.nudge(shift ? -5 : -1);
				break;
			case "ArrowRight":
				this.engine.nudge(shift ? 5 : 1);
				break;
			case "ArrowUp":
				this.adjustRate(RATE_STEP);
				break;
			case "ArrowDown":
				this.adjustRate(-RATE_STEP);
				break;
			case "f":
			case "F":
				void this.toggleImmersive();
				break;
			case "Escape":
				if (this.immersive) void this.toggleImmersive();
				else handled = false;
				break;
			case "m":
			case "M":
				this.addMark();
				break;
			case "s":
			case "S":
				this.loopSection();
				break;
			case "a":
			case "A":
				this.setLoopEdge("a");
				break;
			case "b":
			case "B":
				this.setLoopEdge("b");
				break;
			case "l":
			case "L":
				this.toggleLoop();
				break;
			case "x":
			case "X":
				this.engine.setLoop(null, null);
				this.syncLoopUi();
				break;
			case "[":
			case "{":
				this.nudgeLoopEdge(shift ? "b" : "a", -0.01);
				break;
			case "]":
			case "}":
				this.nudgeLoopEdge(shift ? "b" : "a", 0.01);
				break;
			case "-":
			case "_":
				this.adjustPitch(shift ? -CENT_STEP / 100 : -SEMITONE_STEP);
				break;
			case "=":
			case "+":
				this.adjustPitch(shift ? CENT_STEP / 100 : SEMITONE_STEP);
				break;
			case "0":
				this.resetKnobs();
				break;
			default:
				handled = false;
		}

		if (handled) {
			event.preventDefault();
			this.dirty = true;
		}
	};

	// ------------------------------------------------------------------ frame loop

	private frame = (): void => {
		this.raf = requestAnimationFrame(this.frame);
		const playing = this.engine.transport.playing;
		if (playing !== this.wasPlaying) {
			this.wasPlaying = playing;
			// An iPad that sleeps mid-loop is a broken tool: nothing touches the screen while both
			// hands are on the guitar.
			void this.awake.want(playing);
		}
		if (playing) this.engine.tick();
		if (!playing && !this.dirty) return;
		this.dirty = false;
		this.render();
	};

	private render(): void {
		const position = this.engine.position();
		const { loopA, loopB, looping, playing } = this.engine.transport;

		if (this.waveform) {
			this.waveform.setTransport(position, loopA, loopB, looping);
			if (playing) this.waveform.follow();
			this.waveform.draw();
		}

		// The picture follows the engine, never the other way round.
		this.video?.follow(position, playing, this.engine.transport.rate);

		this.el.clock?.setText(`${formatTime(position)} / ${formatTime(this.duration)}`);
		if (this.el.playButton) {
			setIcon(this.el.playButton, playing ? "pause" : "play");
			// ⚠️ Lit only while playing. Filled means *engaged* and nothing else -- a permanently
			// filled Play would make it mean "primary" here and "engaged" everywhere else, and that
			// two-weight vocabulary is the whole reason the screen reads at a glance.
			this.el.playButton.toggleClass("is-on", playing);
		}
	}

	private syncLoopUi(): void {
		this.captureTransport();
		const { loopA, loopB, looping } = this.engine.transport;
		const has = loopA !== null && loopB !== null;
		this.el.edgeA?.setText(has ? formatTime(loopA as number) : "—");
		this.el.edgeB?.setText(has ? formatTime(loopB as number) : "—");
		this.el.loopLen?.setText(has ? `${((loopB as number) - (loopA as number)).toFixed(2)} s` : "no loop");
		this.el.loopToggle?.toggleClass("is-on", looping);
	}

	/**
	 * Copies live transport state into the ledger and queues a write.
	 *
	 * Called from `syncKnobUi` and `syncLoopUi` -- the two funnels every tempo, pitch and loop
	 * change already passes through, whether it came from a slider, a button, the keyboard or a
	 * drag on the waveform. Hooking the funnels rather than the dozen call sites is why this cannot
	 * quietly miss one, which is exactly how tempo, pitch and the loop went unsaved in v0.2.
	 */
	private captureTransport(queue = true): void {
		if (this.restoring || !this.note) return;
		const { rate, semitones, loopA, loopB, looping } = this.engine.transport;
		this.ledger.tempo = rate;
		this.ledger.semitones = semitones;
		this.ledger.loopA = loopA;
		this.ledger.loopB = loopB;
		this.ledger.loopOn = looping;
		// `queue` is false when the save is already happening: queueing from inside saveLedger
		// re-arms the timer it just cleared, and the plugin rewrites the note once a second for
		// ever. Caught by reading the two call paths against each other, not by running it.
		if (queue) this.queueSave();
	}

	private syncKnobUi(): void {
		this.captureTransport();
		const { rate, semitones } = this.engine.transport;
		this.el.rateValue?.setText(String(Math.round(rate * 100)));
		if (this.el.pitchValue) {
			const whole = semitones < 0 ? Math.ceil(semitones) : Math.floor(semitones);
			const cents = Math.round((semitones - whole) * 100);
			this.el.pitchValue.setText(`${signed(whole)} st, ${signed(cents)} ¢`);
		}
	}

	/**
	 * The report line. Empty means gone, not blank.
	 *
	 * `sticky` is the difference between a fact and a warning: a decode time is worth saying once
	 * and then getting out of the way, while `Sound only` has to stay until the next song, because
	 * it answers a question the user has not thought to ask yet.
	 */
	private setStatus(text: string, sticky = false): void {
		const el = this.el.report;
		if (!el) return;
		window.clearTimeout(this.statusTimer);
		el.setText(text);
		el.toggleClass("is-warn", sticky && text.length > 0);
		el.hidden = text.length === 0;
		if (text.length > 0 && !sticky) {
			this.statusTimer = window.setTimeout(() => {
				el.setText("");
				el.hidden = true;
			}, 6000);
		}
	}
}

function stripExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

function signed(value: number): string {
	return value > 0 ? `+${value}` : String(value);
}

/** m:ss.mmm — milliseconds shown because loop edges are set to the millisecond. */
function formatTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) seconds = 0;
	const m = Math.floor(seconds / 60);
	const s = seconds - m * 60;
	return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
