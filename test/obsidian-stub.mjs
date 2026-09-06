// Just enough of Obsidian for the pure half of ledger.ts to load outside the app.
export const normalizePath = (p) => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
export class TFile {}
export class App {}
// A Modal is only ever constructed inside the app; the tests reach the pure functions that sit
// beside one, so the class needs to exist and nothing more.
export class Modal {
	constructor(app) {
		this.app = app;
	}
}
