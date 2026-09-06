/**
 * Typing a time, rather than aiming at one.
 *
 * ⚠️ Why this exists. Everything up to v0.8.0 set a position by *gesture* -- drag the loop edge,
 * tap the waveform, nudge by 10 ms. That is right for the ninety-nine times out of a hundred when
 * the ear is deciding. It is wrong for the hundredth: a mark that should be at exactly 1:34.000, a
 * loop copied off a note, an edge you already know the number for. Bas asked for it directly on
 * 6 September -- "I want to be able to change the time of the markers and A and B by typing a time
 * as well" -- and a tool that can only be driven by hand is a tool that cannot be corrected.
 */

import { App, Modal } from "obsidian";

/**
 * Parses what a person would actually type for a time.
 *
 * Accepts `m:ss.mmm`, `m:ss`, `h:mm:ss(.mmm)`, and bare seconds. Rejects anything else rather than
 * guessing -- a silently misread time puts a loop edge somewhere nobody asked for, and this is the
 * one input in the player where the user is asserting a number rather than hearing one.
 *
 * Pure, and tested: it is the only place in this file where being wrong is invisible.
 */
export function parseTime(text: string): number | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	// Comma as a decimal separator, because a Dutch keyboard offers it first.
	const normalised = trimmed.replace(",", ".");
	if (!/^\d{1,2}(:\d{1,2}){0,2}(\.\d{1,3})?$/.test(normalised)) return null;

	const parts = normalised.split(":");
	// Seconds may carry the fraction; the fields above it are whole numbers by the pattern above.
	const seconds = Number(parts.pop());
	if (!Number.isFinite(seconds)) return null;
	// A bare "90" means ninety seconds. Only a field *behind* a colon is capped at 59.
	if (parts.length > 0 && seconds >= 60) return null;

	let total = seconds;
	let unit = 60;
	for (const part of parts.reverse()) {
		const value = Number(part);
		if (!Number.isFinite(value)) return null;
		total += value * unit;
		unit *= 60;
	}
	return total;
}

/** m:ss.mmm — the same spelling the clock and the loop row use, so a copied value round-trips. */
export function formatTime(seconds: number): string {
	if (!isFinite(seconds) || seconds < 0) seconds = 0;
	const m = Math.floor(seconds / 60);
	const s = seconds - m * 60;
	return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

export interface TimePromptOptions {
	title: string;
	value: number;
	/** The song's length, so a typed time cannot land outside it. */
	max: number;
	onSet: (seconds: number) => void;
	/** Offered only where deleting makes sense — a mark, not a loop edge. */
	onDelete?: () => void;
	/** An optional name field, so renaming and re-timing a mark are one dialogue, not two. */
	name?: { value: string; onSet: (name: string) => void };
}

export class TimeModal extends Modal {
	constructor(app: App, private options: TimePromptOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, containerEl } = this;
		// Same reason as the library picker: a full-screen player sits at z-index 200.
		containerEl.addClass("by-ear-modal-container");
		contentEl.empty();
		this.titleEl.setText(this.options.title);

		let nameInput: HTMLInputElement | null = null;
		if (this.options.name) {
			contentEl.createDiv({ cls: "by-ear-lbl", text: "Name" });
			nameInput = contentEl.createEl("input", {
				type: "text",
				cls: "by-ear-field",
				attr: { value: this.options.name.value, placeholder: "name this mark", "aria-label": "Mark name" },
			});
		}

		contentEl.createDiv({ cls: "by-ear-lbl", text: "Time" });
		const timeInput = contentEl.createEl("input", {
			type: "text",
			cls: "by-ear-field",
			attr: {
				value: formatTime(this.options.value),
				placeholder: "1:34.100",
				// A numeric keypad on iOS, but still a text field: the time carries a colon, which
				// `type="number"` will not accept.
				inputmode: "decimal",
				"aria-label": "Time, as minutes:seconds.milliseconds",
			},
		});
		const hint = contentEl.createDiv({ cls: "by-ear-field-hint", text: "m:ss.mmm, or seconds" });

		const commit = () => {
			const parsed = parseTime(timeInput.value);
			if (parsed === null) {
				hint.setText("Not a time. Try 1:34.100, 1:34, or 94.1");
				hint.addClass("is-bad");
				return;
			}
			if (parsed > this.options.max + 0.001) {
				hint.setText(`The song is ${formatTime(this.options.max)} long.`);
				hint.addClass("is-bad");
				return;
			}
			if (nameInput && this.options.name) this.options.name.onSet(nameInput.value.trim());
			this.options.onSet(Math.max(0, parsed));
			this.close();
		};

		for (const field of [nameInput, timeInput]) {
			field?.addEventListener("keydown", (event) => {
				if (event.key === "Enter") commit();
			});
			field?.addEventListener("input", () => {
				hint.setText("m:ss.mmm, or seconds");
				hint.removeClass("is-bad");
			});
		}

		const row = contentEl.createDiv({ cls: "by-ear-rename-row" });
		const save = row.createEl("button", { text: "Set", cls: "mod-cta" });
		save.addEventListener("click", commit);
		if (this.options.onDelete) {
			const remove = row.createEl("button", { text: "Delete", cls: "mod-warning" });
			remove.addEventListener("click", () => {
				this.options.onDelete?.();
				this.close();
			});
		}

		window.setTimeout(() => (nameInput ?? timeInput).focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
