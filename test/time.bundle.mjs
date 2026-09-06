// test/obsidian-stub.mjs
var Modal = class {
  constructor(app) {
    this.app = app;
  }
};

// src/player/time.ts
function parseTime(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const normalised = trimmed.replace(",", ".");
  if (!/^\d{1,2}(:\d{1,2}){0,2}(\.\d{1,3})?$/.test(normalised)) return null;
  const parts = normalised.split(":");
  const seconds = Number(parts.pop());
  if (!Number.isFinite(seconds)) return null;
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
function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}
var TimeModal = class extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }
  onOpen() {
    const { contentEl, containerEl } = this;
    containerEl.addClass("by-ear-modal-container");
    contentEl.empty();
    this.titleEl.setText(this.options.title);
    let nameInput = null;
    if (this.options.name) {
      contentEl.createDiv({ cls: "by-ear-lbl", text: "Name" });
      nameInput = contentEl.createEl("input", {
        type: "text",
        cls: "by-ear-field",
        attr: { value: this.options.name.value, placeholder: "name this mark", "aria-label": "Mark name" }
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
        "aria-label": "Time, as minutes:seconds.milliseconds"
      }
    });
    const hint = contentEl.createDiv({ cls: "by-ear-field-hint", text: "m:ss.mmm, or seconds" });
    const commit = () => {
      const parsed = parseTime(timeInput.value);
      if (parsed === null) {
        hint.setText("Not a time. Try 1:34.100, 1:34, or 94.1");
        hint.addClass("is-bad");
        return;
      }
      if (parsed > this.options.max + 1e-3) {
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
  onClose() {
    this.contentEl.empty();
  }
};
export {
  TimeModal,
  formatTime,
  parseTime
};
