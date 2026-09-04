import { Plugin, WorkspaceLeaf } from "obsidian";
import { PLAYER_VIEW, PlayerView } from "./player/view";
import { ByEarSettingTab, ByEarSettings, DEFAULT_SETTINGS } from "./settings";

export default class ByEarPlugin extends Plugin {
	settings: ByEarSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(PLAYER_VIEW, (leaf: WorkspaceLeaf) => new PlayerView(leaf, this));

		this.addRibbonIcon("headphones", "By Ear", () => void this.openPlayer());

		this.addCommand({
			id: "open-player",
			name: "Open the player",
			callback: () => void this.openPlayer(),
		});

		/*
		 * obsidian://by-ear?song=<media file name>&t=<seconds>
		 *
		 * The one door into this plugin from outside it. A timestamp in a note becomes a link that
		 * opens the player at that moment -- and it is what a music dashboard would click to start
		 * a song, which is why it ships here rather than later.
		 */
		this.registerObsidianProtocolHandler("by-ear", async (params) => {
			await this.openPlayer();
			const song = params.song ?? params.file;
			if (!song) return;
			const at = Number(params.t);
			for (const leaf of this.app.workspace.getLeavesOfType(PLAYER_VIEW)) {
				const view = leaf.view;
				if (view instanceof PlayerView) {
					await view.openByName(song, Number.isFinite(at) ? at : null);
				}
			}
		});

		this.addSettingTab(new ByEarSettingTab(this.app, this));
	}

	onunload(): void {
		// Obsidian detaches the leaves, which calls each view's onClose -- and that is where the
		// AudioContext is shut. Nothing to do here, but the comment is worth more than the code:
		// closing the context is the *only* way to retire the worklet processor. See engine.ts.
	}

	async openPlayer(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(PLAYER_VIEW);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: PLAYER_VIEW, active: true });
		await workspace.revealLeaf(leaf);
	}

	/** Re-reads the media folder in every open player. */
	refreshLibrary(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(PLAYER_VIEW)) {
			const view = leaf.view;
			if (view instanceof PlayerView) void view.refreshLibrary();
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshLibrary();
	}
}
