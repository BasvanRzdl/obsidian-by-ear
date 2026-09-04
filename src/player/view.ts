import { ItemView, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type ByEarPlugin from "../main";
import { Engine } from "./engine";
import { Waveform } from "./waveform";
import { MediaEntry, listMedia, readMedia } from "../media";

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
		this.buildStatus(root);
		this.buildKeyLegend(root);

		this.registerDomEvent(root, "keydown", this.onKeyDown);
		this.registerDomEvent(window, "resize", () => (this.dirty = true));
		this.engine.onEnded = () => (this.dirty = true);

		this.refreshLibrary();
		this.frame();
	}

	async onClose(): Promise<void> {
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.waveform?.destroy();
		this.waveform = null;
		// Closing the context is the only way to retire the worklet processor -- see engine.ts.
		await this.engine.destroy();
	}

	/** Called by the plugin when the media folder changes. */
	refreshLibrary(): void {
		const folder = this.plugin.settings.mediaFolder;
		this.library = folder ? listMedia(folder) : [];
		const picker = this.el.picker;
		if (!picker) return;

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
		picker.disabled = false;
		picker.createEl("option", { text: `Choose a song… (${this.library.length})`, value: "" });
		for (const entry of this.library) {
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

	// ------------------------------------------------------------------ keyboard

	private onKeyDown = (event: KeyboardEvent): void => {
		const target = event.target as HTMLElement | null;
		// Let a focused slider keep its own arrow keys.
		if (target && target.tagName === "INPUT" && (target as HTMLInputElement).type === "range") {
			if (event.key.startsWith("Arrow")) return;
		}
		if (target && (target.tagName === "SELECT" || target.isContentEditable)) return;

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
