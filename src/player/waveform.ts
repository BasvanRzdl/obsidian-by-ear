/**
 * The waveform: peaks, zoom, click-to-seek, and drag-to-loop.
 *
 * Two costs are kept apart on purpose. Reducing raw samples to one min/max pair per pixel column
 * is O(visible samples) -- around 16 million for a whole song -- so it happens only when the view
 * window or the canvas size changes. Drawing is O(columns) and happens every frame.
 */

const HANDLE_GRAB_PX = 7;
const DRAG_THRESHOLD_PX = 4;
/** Never zoom in past this: below it the peaks are individual samples and the picture is noise. */
const MIN_WINDOW_SECONDS = 0.02;

export interface WaveformCallbacks {
	onSeek(time: number): void;
	onLoopChange(a: number | null, b: number | null): void;
	/** Called while a handle or a new region is being dragged, for a live readout. */
	onDragPreview(a: number | null, b: number | null): void;
}

type DragMode = "none" | "pending" | "region" | "handle-a" | "handle-b";

export class Waveform {
	private canvas: HTMLCanvasElement;
	private ctx2d: CanvasRenderingContext2D;
	private callbacks: WaveformCallbacks;

	private samples: Float32Array | null = null;
	private sampleRate = 1;
	private duration = 0;

	private viewStart = 0;
	private viewEnd = 0;

	/** min/max per pixel column, recomputed only when the window or the size changes. */
	private peaks: Float32Array | null = null;
	private peaksKey = "";

	private playhead = 0;
	/** Named points the user dropped. Drawn, never edited here -- the view owns them. */
	private marks: { time: number; name: string }[] = [];
	private loopA: number | null = null;
	private loopB: number | null = null;
	private looping = false;

	private drag: DragMode = "none";
	private dragOriginX = 0;
	private dragOriginTime = 0;
	private dragA: number | null = null;
	private dragB: number | null = null;

	private colors = {
		wave: "#888",
		waveDim: "#555",
		playhead: "#e05a2b",
		loop: "rgba(120, 170, 255, 0.16)",
		loopEdge: "#7aa8ff",
		mark: "#c9a227",
		axis: "#666",
		text: "#999",
	};

	constructor(canvas: HTMLCanvasElement, callbacks: WaveformCallbacks) {
		this.canvas = canvas;
		this.callbacks = callbacks;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("By Ear: this platform has no 2D canvas context.");
		this.ctx2d = ctx;

		canvas.addEventListener("pointerdown", this.onPointerDown);
		canvas.addEventListener("pointermove", this.onPointerMove);
		canvas.addEventListener("pointerup", this.onPointerUp);
		canvas.addEventListener("pointercancel", this.onPointerUp);
		canvas.addEventListener("wheel", this.onWheel, { passive: false });
	}

	destroy(): void {
		this.canvas.removeEventListener("pointerdown", this.onPointerDown);
		this.canvas.removeEventListener("pointermove", this.onPointerMove);
		this.canvas.removeEventListener("pointerup", this.onPointerUp);
		this.canvas.removeEventListener("pointercancel", this.onPointerUp);
		this.canvas.removeEventListener("wheel", this.onWheel);
		this.samples = null;
		this.peaks = null;
	}

	setSong(samples: Float32Array, sampleRate: number, duration: number): void {
		this.samples = samples;
		this.sampleRate = sampleRate;
		this.duration = duration;
		this.viewStart = 0;
		this.viewEnd = duration;
		this.loopA = null;
		this.loopB = null;
		this.playhead = 0;
		this.peaksKey = "";
	}

	clear(): void {
		this.samples = null;
		this.peaks = null;
		this.peaksKey = "";
		this.duration = 0;
	}

	setTransport(playhead: number, loopA: number | null, loopB: number | null, looping: boolean): void {
		this.playhead = playhead;
		this.loopA = loopA;
		this.loopB = loopB;
		this.looping = looping;
	}

	get window(): { start: number; end: number } {
		return { start: this.viewStart, end: this.viewEnd };
	}

	fit(): void {
		this.viewStart = 0;
		this.viewEnd = this.duration;
	}

	/** Keeps the playhead on screen without jerking the view around while the user is reading it. */
	follow(): void {
		if (this.duration <= 0) return;
		const span = this.viewEnd - this.viewStart;
		if (span >= this.duration) return;
		const margin = span * 0.08;
		// Only when it actually leaves, and then it lands just inside the left edge. Scrolling
		// continuously would keep the picture moving under a note you are trying to read, which is
		// the opposite of what zooming in was for.
		if (this.playhead < this.viewStart + margin || this.playhead > this.viewEnd - margin) {
			this.setWindow(this.playhead - margin, this.playhead - margin + span);
		}
	}

	zoomTo(a: number, b: number): void {
		if (b - a < MIN_WINDOW_SECONDS) return;
		const pad = (b - a) * 0.1;
		this.setWindow(a - pad, b + pad);
	}

	draw(): void {
		const { width, height } = this.resize();
		if (width === 0 || height === 0) return;
		const ctx = this.ctx2d;

		ctx.clearRect(0, 0, width, height);
		if (!this.samples || this.duration <= 0) {
			this.drawEmpty(width, height);
			return;
		}

		this.buildPeaks(width);
		this.drawPeaks(width, height);
		this.drawLoop(width, height);
		this.drawRuler(width, height);
		this.drawMarks(width, height);
		this.drawPlayhead(width, height);
	}

	// ------------------------------------------------------------------ drawing

	private drawEmpty(width: number, height: number): void {
		const ctx = this.ctx2d;
		ctx.strokeStyle = this.colors.waveDim;
		ctx.beginPath();
		ctx.moveTo(0, height / 2);
		ctx.lineTo(width, height / 2);
		ctx.stroke();
	}

	private buildPeaks(width: number): void {
		const key = `${width}|${this.viewStart.toFixed(4)}|${this.viewEnd.toFixed(4)}`;
		if (key === this.peaksKey && this.peaks) return;

		const samples = this.samples!;
		const peaks = new Float32Array(width * 2);
		const startSample = Math.max(0, Math.floor(this.viewStart * this.sampleRate));
		const endSample = Math.min(samples.length, Math.ceil(this.viewEnd * this.sampleRate));
		const perColumn = (endSample - startSample) / width;

		for (let x = 0; x < width; x++) {
			const from = Math.floor(startSample + x * perColumn);
			const to = Math.max(from + 1, Math.floor(startSample + (x + 1) * perColumn));
			let min = 0;
			let max = 0;
			for (let i = from; i < to && i < samples.length; i++) {
				const v = samples[i];
				if (v < min) min = v;
				else if (v > max) max = v;
			}
			peaks[x * 2] = min;
			peaks[x * 2 + 1] = max;
		}

		this.peaks = peaks;
		this.peaksKey = key;
	}

	private drawPeaks(width: number, height: number): void {
		const ctx = this.ctx2d;
		const peaks = this.peaks!;
		const mid = height / 2;
		const scale = height / 2 - 10;

		ctx.strokeStyle = this.colors.wave;
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let x = 0; x < width; x++) {
			const min = peaks[x * 2];
			const max = peaks[x * 2 + 1];
			// +0.5 so a 1px line lands on the pixel instead of straddling two.
			const px = x + 0.5;
			ctx.moveTo(px, mid - max * scale);
			ctx.lineTo(px, mid - min * scale);
		}
		ctx.stroke();
	}

	private drawLoop(width: number, height: number): void {
		const a = this.dragA ?? this.loopA;
		const b = this.dragB ?? this.loopB;
		if (a === null || b === null) return;
		const ctx = this.ctx2d;
		const xa = this.timeToX(a, width);
		const xb = this.timeToX(b, width);

		ctx.fillStyle = this.colors.loop;
		ctx.fillRect(xa, 0, xb - xa, height);

		ctx.strokeStyle = this.colors.loopEdge;
		ctx.lineWidth = this.looping ? 2 : 1;
		if (!this.looping) ctx.setLineDash([3, 3]);
		ctx.beginPath();
		ctx.moveTo(xa + 0.5, 0);
		ctx.lineTo(xa + 0.5, height);
		ctx.moveTo(xb - 0.5, 0);
		ctx.lineTo(xb - 0.5, height);
		ctx.stroke();
		ctx.setLineDash([]);

		ctx.fillStyle = this.colors.loopEdge;
		ctx.font = "10px var(--font-interface)";
		ctx.fillText("A", xa + 3, 11);
		ctx.textAlign = "right";
		ctx.fillText("B", xb - 3, 11);
		ctx.textAlign = "left";
	}

	private drawRuler(width: number, height: number): void {
		const ctx = this.ctx2d;
		const span = this.viewEnd - this.viewStart;
		const step = niceStep(span, width);
		ctx.strokeStyle = this.colors.axis;
		ctx.fillStyle = this.colors.text;
		ctx.font = "10px var(--font-interface)";
		ctx.lineWidth = 1;
		ctx.globalAlpha = 0.5;

		const first = Math.ceil(this.viewStart / step) * step;
		for (let t = first; t <= this.viewEnd; t += step) {
			const x = Math.round(this.timeToX(t, width)) + 0.5;
			ctx.beginPath();
			ctx.moveTo(x, height - 12);
			ctx.lineTo(x, height);
			ctx.stroke();
			ctx.fillText(formatClock(t, step), x + 3, height - 3);
		}
		ctx.globalAlpha = 1;
	}

	setMarks(marks: { time: number; name: string }[]): void {
		this.marks = marks;
	}

	/**
	 * Marks are drawn as thin full-height ticks with the name beside them, deliberately in a
	 * different colour from the loop edges: a mark and a loop edge are different kinds of thing and
	 * must never be confused at a glance while playing.
	 */
	private drawMarks(width: number, height: number): void {
		if (this.marks.length === 0) return;
		const ctx = this.ctx2d;
		ctx.save();
		ctx.font = "10px var(--font-interface, sans-serif)";
		ctx.textBaseline = "top";
		for (const mark of this.marks) {
			if (mark.time < this.viewStart || mark.time > this.viewEnd) continue;
			const x = Math.round(this.timeToX(mark.time, width)) + 0.5;
			ctx.strokeStyle = this.colors.mark;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, height);
			ctx.stroke();

			ctx.fillStyle = this.colors.mark;
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x + 7, 0);
			ctx.lineTo(x, 7);
			ctx.closePath();
			ctx.fill();

			if (mark.name) {
				// Flip the label to the left near the right edge so it never runs off the canvas.
				const w = ctx.measureText(mark.name).width;
				const left = x + 10 + w > width;
				ctx.textAlign = left ? "right" : "left";
				ctx.fillText(mark.name, left ? x - 4 : x + 4, 9);
			}
		}
		ctx.restore();
	}

	private drawPlayhead(width: number, height: number): void {
		const ctx = this.ctx2d;
		const x = Math.round(this.timeToX(this.playhead, width)) + 0.5;
		if (x < -1 || x > width + 1) return;
		ctx.strokeStyle = this.colors.playhead;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(x, 0);
		ctx.lineTo(x, height);
		ctx.stroke();
	}

	// ------------------------------------------------------------------ interaction

	private onPointerDown = (event: PointerEvent): void => {
		if (!this.samples) return;
		this.canvas.setPointerCapture(event.pointerId);
		const width = this.canvas.width / dpr();
		const x = this.eventX(event);
		const time = this.xToTime(x, width);

		this.dragOriginX = x;
		this.dragOriginTime = time;

		// Grabbing an existing edge is more useful than starting a new region on top of it.
		if (this.loopA !== null && Math.abs(x - this.timeToX(this.loopA, width)) <= HANDLE_GRAB_PX) {
			this.drag = "handle-a";
			this.dragA = this.loopA;
			this.dragB = this.loopB;
		} else if (this.loopB !== null && Math.abs(x - this.timeToX(this.loopB, width)) <= HANDLE_GRAB_PX) {
			this.drag = "handle-b";
			this.dragA = this.loopA;
			this.dragB = this.loopB;
		} else {
			this.drag = "pending";
		}
	};

	private onPointerMove = (event: PointerEvent): void => {
		if (this.drag === "none" || !this.samples) return;
		const width = this.canvas.width / dpr();
		const x = this.eventX(event);
		const time = this.xToTime(x, width);

		if (this.drag === "pending") {
			if (Math.abs(x - this.dragOriginX) < DRAG_THRESHOLD_PX) return;
			this.drag = "region";
		}

		if (this.drag === "region") {
			this.dragA = Math.min(this.dragOriginTime, time);
			this.dragB = Math.max(this.dragOriginTime, time);
		} else if (this.drag === "handle-a") {
			this.dragA = Math.min(time, (this.dragB ?? time) - MIN_WINDOW_SECONDS);
		} else if (this.drag === "handle-b") {
			this.dragB = Math.max(time, (this.dragA ?? time) + MIN_WINDOW_SECONDS);
		}
		this.callbacks.onDragPreview(this.dragA, this.dragB);
	};

	private onPointerUp = (event: PointerEvent): void => {
		if (this.drag === "none") return;
		const mode = this.drag;
		this.drag = "none";
		try {
			this.canvas.releasePointerCapture(event.pointerId);
		} catch {
			/* the pointer is already gone */
		}

		if (mode === "pending") {
			// A press that never moved is a seek, which is what a click on a waveform should mean.
			this.callbacks.onSeek(this.dragOriginTime);
			return;
		}
		if (this.dragA !== null && this.dragB !== null) {
			this.callbacks.onLoopChange(this.dragA, this.dragB);
		}
		this.dragA = null;
		this.dragB = null;
	};

	/**
	 * Wheel zooms around the pointer, shift+wheel pans.
	 *
	 * Zooming around the pointer rather than the centre is what makes it possible to walk into a
	 * bar without losing it -- put the cursor on the note, scroll, and it stays put.
	 */
	private onWheel = (event: WheelEvent): void => {
		if (!this.samples) return;
		event.preventDefault();
		const width = this.canvas.width / dpr();
		const span = this.viewEnd - this.viewStart;

		if (event.shiftKey) {
			const shift = (event.deltaY !== 0 ? event.deltaY : event.deltaX) * span * 0.002;
			this.setWindow(this.viewStart + shift, this.viewEnd + shift);
			return;
		}

		const focus = this.xToTime(this.eventX(event), width);
		const factor = Math.exp(event.deltaY * 0.002);
		const next = Math.min(this.duration, Math.max(MIN_WINDOW_SECONDS, span * factor));
		const ratio = (focus - this.viewStart) / span;
		this.setWindow(focus - next * ratio, focus + next * (1 - ratio));
	};

	private setWindow(start: number, end: number): void {
		let span = Math.min(this.duration, Math.max(MIN_WINDOW_SECONDS, end - start));
		let from = start;
		if (from < 0) from = 0;
		if (from + span > this.duration) from = this.duration - span;
		if (from < 0) {
			from = 0;
			span = this.duration;
		}
		this.viewStart = from;
		this.viewEnd = from + span;
	}

	// ------------------------------------------------------------------ geometry

	private eventX(event: PointerEvent | WheelEvent): number {
		return event.clientX - this.canvas.getBoundingClientRect().left;
	}

	private timeToX(time: number, width: number): number {
		return ((time - this.viewStart) / (this.viewEnd - this.viewStart)) * width;
	}

	private xToTime(x: number, width: number): number {
		const t = this.viewStart + (x / width) * (this.viewEnd - this.viewStart);
		return Math.min(this.duration, Math.max(0, t));
	}

	/** Sizes the backing store to the CSS box at device resolution. Returns CSS pixels. */
	private resize(): { width: number; height: number } {
		const ratio = dpr();
		const rect = this.canvas.getBoundingClientRect();
		const width = Math.floor(rect.width);
		const height = Math.floor(rect.height);
		if (this.canvas.width !== width * ratio || this.canvas.height !== height * ratio) {
			this.canvas.width = width * ratio;
			this.canvas.height = height * ratio;
			this.peaksKey = "";
			this.readColors();
		}
		this.ctx2d.setTransform(ratio, 0, 0, ratio, 0, 0);
		return { width, height };
	}

	/** Colours come from the theme, so the waveform follows whatever Obsidian is wearing. */
	private readColors(): void {
		const style = getComputedStyle(this.canvas);
		const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
		this.colors = {
			wave: pick("--by-ear-wave", this.colors.wave),
			waveDim: pick("--by-ear-wave-dim", this.colors.waveDim),
			playhead: pick("--by-ear-playhead", this.colors.playhead),
			loop: pick("--by-ear-loop", this.colors.loop),
			loopEdge: pick("--by-ear-loop-edge", this.colors.loopEdge),
			mark: pick("--by-ear-mark", this.colors.mark),
			axis: pick("--by-ear-axis", this.colors.axis),
			text: pick("--by-ear-axis", this.colors.text),
		};
	}
}

function dpr(): number {
	return window.devicePixelRatio || 1;
}

/** A tick spacing from the 1/2/5 family that gives roughly one label per 90 px. */
function niceStep(span: number, width: number): number {
	const target = (span / Math.max(1, width)) * 90;
	const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
	for (const multiple of [1, 2, 5, 10]) {
		if (magnitude * multiple >= target) return magnitude * multiple;
	}
	return magnitude * 10;
}

function formatClock(seconds: number, step: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds - m * 60;
	// Show decimals only once the ruler is fine enough to need them.
	const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
	return `${m}:${s.toFixed(decimals).padStart(decimals > 0 ? 3 + decimals : 2, "0")}`;
}
