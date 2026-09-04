import { ItemView, Notice, Platform, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ByEarPlugin from "../main";
import { Engine } from "./engine";
import { Waveform } from "./waveform";
import { MediaEntry, listMedia, readMedia } from "../media";
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

	private library: MediaEntry[] = [];
	private current: MediaEntry | null = null;
	private duration = 0;

	/** The ledger half: which note this song writes to, and what it last said. */
	private index: NoteIndex = [];
	private note: NoteMatch | null = null;
	private ledger: Ledger = emptyLedger();
	private openedAt = 0;
	private saveTimer = 0;
	private filter = "";
	/** Whether the ledger holds anything not yet on disk. Drives the receipt, nothing else. */
	private unsaved = false;

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

		if (Platform.isMobile) {
			this.buildMobileNotice(root);
			return;
		}

		this.buildLibraryRow(root);
		this.buildWaveform(root);
		this.buildTransport(root);
		this.buildControls(root);
		this.buildMarks(root);
		this.buildLedgerPane(root);
		this.buildStatus(root);
		this.buildKeyLegend(root);

		this.registerDomEvent(root, "keydown", this.onKeyDown);
		this.registerDomEvent(window, "resize", () => (this.dirty = true));
		this.engine.onEnded = () => (this.dirty = true);

		this.refreshLibrary();
		this.frame();
	}

	async onClose(): Promise<void> {
		await this.closeLedger();
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
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
	refreshLibrary(): void {
		const folder = this.plugin.settings.mediaFolder;
		this.library = folder ? listMedia(folder) : [];
		this.index = buildIndex(this.app);
		this.renderPicker();
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
		if (!folder) {
			picker.createEl("option", { text: "Set a media folder in settings…", value: "" });
			picker.disabled = true;
			return;
		}
		if (this.library.length === 0) {
			picker.createEl("option", { text: "No playable files in that folder", value: "" });
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

	private buildMobileNotice(root: HTMLElement): void {
		const box = root.createDiv({ cls: "by-ear-empty" });
		box.createEl("h3", { text: "By Ear runs on the desktop for now" });
		box.createEl("p", {
			text:
				"The engine, the waveform and the loop all work — but reading songs on iPad and " +
				"iPhone goes through the Files picker rather than off disk, and that is the next " +
				"phase of the build. Nothing is broken; it just is not wired up yet.",
		});
	}

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

		const rescan = row.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Re-scan folder" } });
		setIcon(rescan, "refresh-cw");
		rescan.addEventListener("click", () => {
			this.refreshLibrary();
			this.setStatus(`${this.library.length} file(s) in the folder.`);
		});
	}

	private buildWaveform(root: HTMLElement): void {
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
		this.el.playButton = button("play", "Play / pause (space)", () => this.engine.toggle());
		button("chevron-right", "Forward 1 s", () => this.engine.nudge(1));
		button("fast-forward", "Forward 5 s", () => this.engine.nudge(5));

		this.el.clock = row.createDiv({ cls: "by-ear-clock", text: "0:00.000 / 0:00.000" });

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
		textButton("Zoom", "Zoom the waveform to the loop", () => {
			const { loopA, loopB } = this.engine.transport;
			if (loopA !== null && loopB !== null) this.waveform?.zoomTo(loopA, loopB);
		});
		textButton("Fit", "Fit the whole song", () => this.waveform?.fit());

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
			const bytes = readMedia(entry.path);
			const started = performance.now();
			const song = await this.engine.load(bytes, entry.name);
			this.current = entry;
			this.duration = song.duration;
			this.waveform?.setSong(song.peaksSource, song.sampleRate, song.duration);
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
					`${song.sampleRate} Hz · decoded in ${Math.round(performance.now() - started)} ms`
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

		if (this.ledger.tempo !== null) this.setRate(this.ledger.tempo);
		if (this.ledger.semitones !== null) this.setPitch(this.ledger.semitones);
		if (this.ledger.loops.length > 0) {
			const first = this.ledger.loops[0];
			this.engine.setLoop(first.a, first.b);
		}
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
		this.ledger.tempo = this.engine.transport.rate;
		this.ledger.semitones = this.engine.transport.semitones;
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
				this.engine.toggle();
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

		if (this.el.clock) {
			this.el.clock.setText(`${formatTime(position)} / ${formatTime(this.duration)}`);
		}
		if (this.el.playButton) {
			setIcon(this.el.playButton, playing ? "pause" : "play");
		}
	}

	private syncLoopUi(): void {
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

	private syncKnobUi(): void {
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
