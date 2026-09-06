import { ItemView, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ByEarPlugin from "../main";
import { Engine } from "./engine";
import { Waveform } from "./waveform";
import { VideoScreen } from "./video";
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
	private awake = new KeepAwake();
	private wasPlaying = false;
	private filter = "";
	private immersive = false;
	/** Whether *we* took native full screen, as opposed to only drawing the overlay. */
	private native = false;
	/** Whether the ledger holds anything not yet on disk. Drives the receipt, nothing else. */
	private unsaved = false;
	/** True only while restoring a note, so putting values back does not count as changing them. */
	private restoring = false;

	private raf = 0;
	private dirty = true;

	private el = {
		picker: null as HTMLSelectElement | null,
		canvas: null as HTMLCanvasElement | null,
		playButton: null as HTMLButtonElement | null,
		clock: null as HTMLElement | null,
		loopReadout: null as HTMLElement | null,
		loopToggle: null as HTMLButtonElement | null,
		rate: null as HTMLInputElement | null,
		rateValue: null as HTMLElement | null,
		semitones: null as HTMLInputElement | null,
		cents: null as HTMLInputElement | null,
		pitchValue: null as HTMLElement | null,
		status: null as HTMLElement | null,
		filter: null as HTMLInputElement | null,
		noteLink: null as HTMLElement | null,
		marks: null as HTMLElement | null,
		findings: null as HTMLTextAreaElement | null,
		saveState: null as HTMLElement | null,
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

		// The only thing the phone and the desktop disagree about is where bytes come from. Every
		// control is identical on both, which is the point of MediaEntry.source.
		if (Platform.isMobile) {
			/*
			 * ⚠️ The transport is pinned inside the *view's own box*, not stuck to the viewport.
			 *
			 * v0.3.1 used `position: sticky; bottom: 0`, which sticks to the scrollport -- and on
			 * iPad and iPhone that runs underneath Obsidian's own bottom chrome, so the play button
			 * was there and unreachable. Guessing the height of that chrome would mean depending on
			 * an Obsidian internal that is not documented and changes between releases.
			 *
			 * So: this element is sized by Obsidian, everything scrolls inside it, and the transport
			 * is a flex child at its foot. Nothing inside a box Obsidian sized can be covered by
			 * Obsidian's UI, whatever that UI decides to be next version.
			 */
			root.addClass("is-mobile");
			// Declared before anything can play: an iPhone with its ringer switch off mutes all of
			// Web Audio until it is told this is media playback rather than an interface noise.
			claimAudioPlayback();
			const scroll = root.createDiv({ cls: "by-ear-scroll" });
			this.buildLibraryRow(scroll);
			this.buildWaveform(scroll);
			this.buildMarks(scroll);
			this.buildLoops(scroll);
			this.buildControls(scroll);
			this.buildLedgerPane(scroll);
			this.buildStatus(scroll);
			this.buildTransport(root);
		} else {
			this.buildLibraryRow(root);
			this.buildWaveform(root);
			this.buildTransport(root);
			this.buildLoops(root);
			this.buildControls(root);
			this.buildMarks(root);
			this.buildLedgerPane(root);
			this.buildStatus(root);
			this.buildKeyLegend(root);
		}

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
				this.contentEl.removeClass("is-immersive");
				this.wakeChrome();
				this.dirty = true;
			}
		});
		this.registerDomEvent(window, "resize", () => {
			// Rotating a phone changes which axis the film wastes, so the choice is remade.
			this.layoutImmersive();
			this.dirty = true;
		});
		this.engine.onEnded = () => (this.dirty = true);

		void this.refreshLibrary();
		this.frame();
	}

	async onClose(): Promise<void> {
		if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
		await this.closeLedger();
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
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
		if (this.library.length === 0) this.refreshLibrary();
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
		this.renderPicker();
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
			this.setStatus(`Copying ${i + 1} of ${files.length} — ${file.name}…`);
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

	private async forgetCurrent(): Promise<void> {
		const entry = this.current;
		if (!entry || entry.source !== "cache") return;
		await this.closeLedger();
		await forgetCached(entry.name);
		this.current = null;
		this.engine.pause();
		this.engine.setLoop(null, null);
		this.video?.unload();
		this.waveform?.clear();
		this.duration = 0;
		await this.refreshLibrary();
		// The note is untouched on purpose: the media is per-device, the work on the song is not.
		this.setStatus(`${entry.name} removed from this device. Its note is untouched.`);
		this.dirty = true;
	}

	/** The searchable text for one file: its own name plus whatever its note knows about it. */
	private haystack(entry: MediaEntry): string {
		const match = findNote(this.index, entry.name);
		const bands = match ? match.bands.join(" ") : "";
		return `${entry.name} ${match?.artist ?? ""} ${bands}`.toLowerCase();
	}

	private renderPicker(): void {
		const picker = this.el.picker;
		if (!picker) return;
		const folder = this.plugin.settings.mediaFolder;

		picker.empty();
		if (!Platform.isMobile && !folder) {
			picker.createEl("option", { text: "Set a media folder in settings…", value: "" });
			picker.disabled = true;
			return;
		}
		if (this.library.length === 0) {
			picker.createEl("option", {
				text: Platform.isMobile ? "No songs on this device yet — tap Add…" : "No playable files in that folder",
				value: "",
			});
			picker.disabled = true;
			return;
		}

		const shown = this.filter
			? this.library.filter((e) => this.haystack(e).includes(this.filter))
			: this.library;

		picker.disabled = false;
		const label = this.filter
			? `${shown.length} of ${this.library.length} match “${this.filter}”…`
			: `Choose a song… (${this.library.length})`;
		picker.createEl("option", { text: label, value: "" });
		for (const entry of shown) {
			picker.createEl("option", {
				text: `${stripExtension(entry.name)}${entry.video ? "  ▸ video" : ""}`,
				value: entry.path,
			});
		}
		if (this.current) picker.value = this.current.path;
	}

	// ------------------------------------------------------------------ layout

	private buildLibraryRow(root: HTMLElement): void {
		const row = root.createDiv({ cls: "by-ear-row by-ear-library" });

		/*
		 * One box, matching title, artist and band at once.
		 *
		 * Deliberately not a library UI -- the vault is the library (spec section 5d). What makes
		 * "fat bill" a useful thing to type is that the *notes* already know: a chart carries
		 * `bands:`, so the filter reads the vault rather than keeping a catalogue of its own.
		 */
		const filter = row.createEl("input", {
			type: "search",
			cls: "by-ear-filter",
			attr: { placeholder: "filter — song, artist or band" },
		});
		filter.addEventListener("input", () => {
			this.filter = filter.value.trim().toLowerCase();
			this.renderPicker();
		});
		this.el.filter = filter;

		const picker = row.createEl("select", { cls: "dropdown" });
		picker.addEventListener("change", () => {
			const entry = this.library.find((e) => e.path === picker.value);
			if (entry) void this.openSong(entry);
		});
		this.el.picker = picker;

		if (Platform.isMobile) {
			/*
			 * One song arrives once, through the Files picker, and is kept in IndexedDB afterwards.
			 * There is no path to resolve on iOS and no `fs` to resolve it with -- but re-picking a
			 * song every session would make the plugin unusable, which is what the cache is for.
			 */
			const chooser = row.createEl("input", {
				type: "file",
				cls: "by-ear-file-input",
				// `multiple` is the whole mitigation for iOS having no directory access: the folder
				// cannot be read, but the entire folder can be selected in one go, once, and it is
				// cached from then on. Adding songs one at a time was never a requirement, only a
				// consequence of asking for one file.
				attr: { accept: "audio/*,video/*", multiple: "true", "aria-label": "Add songs from Files" },
			});
			const add = row.createEl("button", { text: "Add songs…", attr: { "aria-label": "Add songs from Files" } });
			add.addEventListener("click", () => chooser.click());
			chooser.addEventListener("change", () => {
				const files = Array.from(chooser.files ?? []);
				chooser.value = "";
				if (files.length > 0) void this.addFromFiles(files);
			});

			const forget = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Remove this song from the device" } });
			setIcon(forget, "trash-2");
			forget.addEventListener("click", () => void this.forgetCurrent());
			return;
		}

		const rescan = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Re-scan folder" } });
		setIcon(rescan, "refresh-cw");
		rescan.addEventListener("click", () => {
			void this.refreshLibrary();
			this.setStatus(`${this.library.length} file(s) in the folder.`);
		});
	}

	private buildWaveform(root: HTMLElement): void {
		// The picture sits in its own box above the waveform rather than behind it: a waveform drawn
		// over hands is unreadable, and hands behind a waveform are worse.
		const screen = root.createDiv({ cls: "by-ear-screen" });
		this.video = new VideoScreen(screen);
		// Tap the picture to hide the apparatus and get back to just the hands. The listener is on
		// the box rather than the video so it still works where the video failed to load.
		screen.addEventListener("click", () => this.toggleChrome());

		const wrap = root.createDiv({ cls: "by-ear-wave-wrap" });
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
		});

		// The waveform owns its own pointer handling; this just keeps the frame loop awake for it.
		for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"] as const) {
			this.registerDomEvent(canvas, type, () => (this.dirty = true));
		}
	}

	private buildTransport(root: HTMLElement): void {
		const row = root.createDiv({ cls: "by-ear-row by-ear-transport" });

		const button = (icon: string, label: string, action: () => void) => {
			const b = row.createEl("button", { cls: "by-ear-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.addEventListener("click", () => {
				action();
				this.dirty = true;
			});
			return b;
		};

		button("skip-back", "Back to start", () => this.engine.seek(0));
		button("rewind", "Back 5 s", () => this.engine.nudge(-5));
		button("chevron-left", "Back 1 s", () => this.engine.nudge(-1));
		this.el.playButton = button("play", "Play / pause (space)", () => this.togglePlay());
		// Named rather than found by position: the stylesheet makes this one the big centred target
		// on mobile, and a CSS rule counting siblings would break the day a button is reordered.
		this.el.playButton.addClass("by-ear-play");
		button("chevron-right", "Forward 1 s", () => this.engine.nudge(1));
		button("fast-forward", "Forward 5 s", () => this.engine.nudge(5));

		this.el.clock = row.createDiv({ cls: "by-ear-clock", text: "0:00.000 / 0:00.000" });
	}

	private buildLoops(root: HTMLElement): void {
		const loops = root.createDiv({ cls: "by-ear-row by-ear-loops" });
		const textButton = (text: string, label: string, action: () => void) => {
			const b = loops.createEl("button", { text, attr: { "aria-label": label } });
			b.addEventListener("click", () => {
				action();
				this.dirty = true;
			});
			return b;
		};

		textButton("Set A", "Set loop start at the playhead (a)", () => this.setLoopEdge("a"));
		textButton("Set B", "Set loop end at the playhead (b)", () => this.setLoopEdge("b"));
		this.el.loopToggle = textButton("Loop", "Loop on / off (l)", () => this.toggleLoop());
		textButton("Clear", "Clear the loop (x)", () => {
			this.engine.setLoop(null, null);
			this.syncLoopUi();
		});
		textButton("Zoom", "Zoom to the loop, or in around the playhead", () => {
			// It used to do nothing at all unless a loop existed -- a button labelled "Zoom" that
			// silently ignores you most of the time. With no loop, zoom around the playhead, which
			// is what the label promises and what the hand reaching for it wants.
			const { loopA, loopB } = this.engine.transport;
			if (loopA !== null && loopB !== null) this.waveform?.zoomTo(loopA, loopB);
			else this.waveform?.zoomAround(this.engine.position());
		});
		textButton("Fit", "Fit the whole song", () => this.waveform?.fit());
		textButton("⛶", "Full screen (f)", () => void this.toggleImmersive());

		this.el.loopReadout = loops.createDiv({ cls: "by-ear-loop-readout", text: "no loop" });
	}

	/**
	 * A slider with a - and a + on either side of it.
	 *
	 * The slider is for finding a value; the buttons are for landing on one. Dragging to exactly
	 * -2 semitones is fiddly, pressing - twice is not. Both drive the same number, so this is one
	 * control with two grips rather than two systems.
	 */
	private stepper(
		parent: HTMLElement,
		attr: Record<string, string>,
		step: number,
		unit: string,
		apply: (delta: number) => void
	): HTMLInputElement {
		const row = parent.createDiv({ cls: "by-ear-stepper" });
		const button = (text: string, delta: number, how: string) => {
			const el = row.createEl("button", {
				text,
				cls: "by-ear-step",
				attr: { "aria-label": `${how} ${step} ${unit}` },
			});
			// A focused button would swallow the spacebar, and the spacebar is play/pause. Always.
			el.tabIndex = -1;
			el.addEventListener("mousedown", (event) => event.preventDefault());
			el.addEventListener("click", () => {
				apply(delta);
				this.dirty = true;
			});
		};
		button("\u2212", -step, "down");
		const slider = row.createEl("input", { type: "range", cls: "slider", attr });
		button("+", step, "up");
		return slider;
	}

	private buildControls(root: HTMLElement): void {
		const grid = root.createDiv({ cls: "by-ear-controls" });

		// --- tempo
		const tempo = grid.createDiv({ cls: "by-ear-knob" });
		tempo.createDiv({ cls: "by-ear-knob-label", text: "Tempo" });
		const rate = this.stepper(
			tempo,
			{ min: String(RATE_MIN), max: String(RATE_MAX), step: "1", value: "100" },
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
		this.el.rateValue = tempo.createDiv({ cls: "by-ear-knob-value", text: "100%" });

		// --- pitch, in two inputs feeding one number
		const pitch = grid.createDiv({ cls: "by-ear-knob" });
		pitch.createDiv({ cls: "by-ear-knob-label", text: "Pitch" });
		const semitones = this.stepper(
			pitch,
			{ min: "-12", max: "12", step: "1", value: "0" },
			SEMITONE_STEP,
			"semitone",
			(delta) => this.adjustPitch(delta)
		);
		// The cents buttons move the same single number -- a fraction of a semitone is cents.
		const cents = this.stepper(
			pitch,
			{ min: "-100", max: "100", step: "1", value: "0" },
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
		this.el.pitchValue = pitch.createDiv({ cls: "by-ear-knob-value", text: "0 st, 0 ¢" });

		const reset = grid.createEl("button", { text: "Reset", attr: { "aria-label": "Reset tempo and pitch (0)" } });
		reset.addEventListener("click", () => {
			this.resetKnobs();
			this.dirty = true;
		});
	}

	private buildMarks(root: HTMLElement): void {
		const row = root.createDiv({ cls: "by-ear-row by-ear-marks-row" });

		const add = row.createEl("button", { text: "Mark", attr: { "aria-label": "Drop a mark here (M)" } });
		add.addEventListener("click", () => this.addMark());

		const section = row.createEl("button", {
			text: "Loop section",
			attr: { "aria-label": "Loop from the previous mark to the next one (S)" },
		});
		section.addEventListener("click", () => this.loopSection());

		this.el.marks = row.createDiv({ cls: "by-ear-marks" });
	}

	/**
	 * The ledger pane: which note this song writes to, and a box to write in.
	 *
	 * The box *is* the note's `## Findings` section -- not an inbox that appends. What he types
	 * here is what the note says, so there is one text and no reconciling to do later.
	 */
	private buildLedgerPane(root: HTMLElement): void {
		const wrap = root.createDiv({ cls: "by-ear-ledger" });
		const head = wrap.createDiv({ cls: "by-ear-ledger-head" });
		this.el.noteLink = head.createSpan({ cls: "by-ear-note-link", text: "" });

		/*
		 * A save button, and a receipt saying when it last happened.
		 *
		 * The writing already worked without either -- but it wrote to the bottom of a long chart,
		 * below a collapsed lyrics callout, and said nothing. Bas typed, looked at the chart, saw
		 * nothing, and reasonably concluded it was broken. A write you cannot see is the same
		 * problem as a meter you cannot see: it looks like a failure, or worse, like a success.
		 */
		const save = head.createEl("button", {
			text: "Save",
			cls: "by-ear-save",
			attr: { "aria-label": "Write the ledger to the note now (Cmd/Ctrl+S)" },
		});
		save.addEventListener("click", () => void this.saveLedger());
		this.el.saveState = head.createSpan({ cls: "by-ear-save-state", text: "" });

		const findings = wrap.createEl("textarea", {
			cls: "by-ear-findings",
			attr: { placeholder: "What you are hearing — written straight into the song's note.", rows: "3" },
		});
		findings.addEventListener("input", () => {
			this.ledger.findings = findings.value;
			this.queueSave();
		});
		this.el.findings = findings;
	}

	private buildStatus(root: HTMLElement): void {
		const row = root.createDiv({ cls: "by-ear-status" });
		this.el.status = row.createSpan({ text: "Nothing loaded." });
		// The dropout meter that used to sit here is gone -- Chromium 142 has no
		// AudioRenderCapacity, so it never reported. See the note in engine.ts.
	}

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

	// ------------------------------------------------------------------ actions

	private async openSong(entry: MediaEntry): Promise<void> {
		// Whatever the last song learned goes in before the next one is read.
		await this.closeLedger();
		this.setStatus(`Reading ${entry.name}…`);
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

			// A file whose audio decoded but whose picture will not show should still play -- but it
			// must SAY so. A blank box where a video should be is exactly the silent failure this
			// project keeps relearning: v0.4.0 showed one on iOS for two days and reported nothing.
			let pictureNote = "";
			if (entry.video) {
				const result = await this.video?.load(blob);
				this.layoutImmersive();
				if (result && !result.ok) {
					// Says what went wrong and what it was handed, because the next move depends on
					// which of those it is -- and a status line that only says "failed" is how the
					// last fix came to be a guess.
					pictureNote =
						` · ⚠️ sound only — ${result.why}` +
						` [${result.blob.type || "no type"}, ${(result.blob.size / 1e6).toFixed(1)} MB]`;
				}
			} else {
				this.video?.unload();
			}
			this.resetKnobs();
			this.syncLoopUi();
			this.dirty = true;
			// After resetKnobs, so a saved tempo and pitch win over the defaults.
			await this.loadLedger(entry);
			// The tab title is the only place the song name stays visible once the view is a tab,
			// and `getDisplayText()` is only re-read when the leaf is asked to redraw its header.
			// That method is real but untyped, so it is reached defensively rather than assumed.
			(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
			this.setStatus(
				`${stripExtension(entry.name)} · ${formatTime(song.duration)} · ` +
					`${song.sampleRate} Hz · decoded in ${Math.round(performance.now() - started)} ms` +
					pictureNote
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`By Ear could not open that file: ${message}`);
			this.setStatus(`Failed to open ${entry.name} — ${message}`);
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

	private toggleLoop(): void {
		this.engine.setLooping(!this.engine.transport.looping);
		this.syncLoopUi();
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
	 *
	 * The controls that stay are the ones this tool is *for* -- transport, loop, marks, tempo and
	 * pitch. A full-screen video with no way to loop a bar would be a worse tool than the small one.
	 */
	private async toggleImmersive(): Promise<void> {
		this.immersive = !this.immersive;
		this.contentEl.toggleClass("is-immersive", this.immersive);
		this.wakeChrome();

		const el = this.contentEl as HTMLElement & { requestFullscreen?: () => Promise<void> };
		try {
			if (this.immersive) {
				if (document.fullscreenEnabled && el.requestFullscreen) {
					await el.requestFullscreen();
					this.native = true;
				}
			} else if (document.fullscreenElement) {
				await document.exitFullscreen();
				this.native = false;
			}
		} catch {
			// Refused or unsupported: the overlay alone is still a full-screen picture. On the phone
			// this is the expected path, not an error.
		}
		// The canvas is sized from its box, and its box just changed.
		this.layoutImmersive();
		this.dirty = true;
	}

	/**
	 * Shows the controls again. There is no timer.
	 *
	 * ⚠️ v0.5.0 faded them after a few seconds, which is what every video player does — and it was
	 * wrong here. That pattern is designed for **watching**, where the chrome is a distraction from
	 * the content. This is **practising**: the loop, the tempo and the marks *are* the content, and
	 * they are reached for constantly while both hands are busy on a guitar. Making him tap to
	 * reveal, then tap the control, doubles the cost of every adjustment at the exact moment his
	 * hands are least free.
	 *
	 * Hiding is still available, because sometimes you only want the hands — but it is a **choice**
	 * (tap the picture) rather than a timeout. Deliberate, reversible the same way, and it never
	 * happens while he is looking at something.
	 */
	private wakeChrome(): void {
		this.contentEl.removeClass("chrome-hidden");
	}

	/**
	 * Chooses where the controls live in full screen, from the shape of the film.
	 *
	 * Bas's idea, and it generalises: a 4:3 bootleg on a wide screen leaves black columns either
	 * side, and putting the controls in them costs no picture at all — where overlaying always
	 * costs some. So if the dead space is wide enough to hold a usable rail, take it and stand the
	 * waveform under the picture; otherwise fall back to overlaying, which is right when the film
	 * genuinely fills the screen.
	 *
	 * Only on iPad and iPhone: that is where the question was asked, and the desktop layout is
	 * already what he wanted. A rail is not obviously better on a wide laptop pane.
	 */
	private layoutImmersive(): void {
		const root = this.contentEl;
		if (!this.immersive || !Platform.isMobile || !this.video?.hasPicture) {
			root.removeClass("has-rail");
			return;
		}
		const waveband = 90;
		const { horizontal } = this.video.gutters(waveband);
		// Half of the gutter would be free on each side; taking it all from one side keeps the
		// picture exactly as large as it already was, just no longer centred.
		const rail = Math.min(320, Math.round(horizontal));
		if (rail >= 200) {
			root.style.setProperty("--by-ear-rail", `${rail}px`);
			root.style.setProperty("--by-ear-waveband", `${waveband}px`);
			root.addClass("has-rail");
		} else {
			root.removeClass("has-rail");
		}
		this.dirty = true;
	}

	/** Tapping the picture toggles the apparatus. Only in full screen, where there is a reason to. */
	private toggleChrome(): void {
		if (!this.immersive) return;
		this.contentEl.toggleClass("chrome-hidden", !this.contentEl.hasClass("chrome-hidden"));
	}

	// ------------------------------------------------------------------ marks

	private addMark(): void {
		if (!this.note) return;
		const time = this.engine.position();
		// A mark within a few frames of an existing one is a double-press, not a second mark.
		if (this.ledger.marks.some((m) => Math.abs(m.time - time) < 0.05)) return;
		this.ledger.marks.push({ time, name: "" });
		this.ledger.marks.sort((a, b) => a.time - b.time);
		this.renderMarks();
		this.queueSave();
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
			new Notice("By Ear: drop a mark or two first (M).");
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

	private renderMarks(): void {
		const host = this.el.marks;
		if (!host) return;
		host.empty();
		this.waveform?.setMarks(this.ledger.marks);

		if (this.ledger.marks.length === 0) {
			host.createSpan({ cls: "by-ear-marks-empty", text: "no marks yet" });
			return;
		}

		this.ledger.marks.forEach((mark, i) => {
			const chip = host.createDiv({ cls: "by-ear-chip" });
			const name = chip.createEl("input", {
				cls: "by-ear-chip-name",
				attr: { value: mark.name, placeholder: formatTime(mark.time), "aria-label": "Mark name" },
			});
			// Click seeks; typing renames. Both on one chip, because a mark you cannot jump to is
			// just a note about a number.
			name.addEventListener("focus", () => {
				this.engine.seek(mark.time);
				this.dirty = true;
			});
			name.addEventListener("input", () => {
				this.ledger.marks[i].name = name.value;
				this.waveform?.setMarks(this.ledger.marks);
				this.dirty = true;
				this.queueSave();
			});
			const remove = chip.createEl("button", { cls: "by-ear-chip-x", text: "×", attr: { "aria-label": "Delete mark" } });
			remove.addEventListener("click", () => {
				this.ledger.marks.splice(i, 1);
				this.renderMarks();
				this.queueSave();
			});
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
		this.renderNoteLink();
		this.syncLoopUi();
		this.dirty = true;
	}

	private renderNoteLink(): void {
		const el = this.el.noteLink;
		if (!el) return;
		el.empty();
		if (!this.note) {
			el.setText("no note");
			return;
		}
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

	/**
	 * Saves a second after the last change rather than on every keystroke.
	 *
	 * The note may be open in an editor and syncing to an iPad at the same time, and `vault.process`
	 * rewrites the whole file. Debouncing keeps that to once per thought instead of once per letter.
	 */
	private renderSaveState(text: string, pending: boolean): void {
		const el = this.el.saveState;
		if (!el) return;
		el.setText(text);
		el.toggleClass("is-pending", pending);
	}

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
			new Notice(`By Ear could not write the note: ${error instanceof Error ? error.message : error}`);
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

		if (this.el.clock) {
			this.el.clock.setText(`${formatTime(position)} / ${formatTime(this.duration)}`);
		}
		if (this.el.playButton) {
			setIcon(this.el.playButton, playing ? "pause" : "play");
		}
	}

	private syncLoopUi(): void {
		this.captureTransport();
		const { loopA, loopB, looping } = this.engine.transport;
		if (this.el.loopReadout) {
			this.el.loopReadout.setText(
				loopA === null || loopB === null
					? "no loop"
					: `A ${formatTime(loopA)} → B ${formatTime(loopB)}  (${(loopB - loopA).toFixed(3)} s)`
			);
		}
		this.el.loopToggle?.toggleClass("is-active", looping);
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
		if (this.el.rateValue) this.el.rateValue.setText(`${Math.round(rate * 100)}%`);
		if (this.el.pitchValue) {
			const whole = semitones < 0 ? Math.ceil(semitones) : Math.floor(semitones);
			const cents = Math.round((semitones - whole) * 100);
			this.el.pitchValue.setText(`${signed(whole)} st, ${signed(cents)} ¢`);
		}
	}

	private setStatus(text: string): void {
		this.el.status?.setText(text);
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
