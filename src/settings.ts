import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type ByEarPlugin from "./main";
import { folderExists, listMedia, suggestedICloudFolder } from "./media";

export interface ByEarSettings {
	/**
	 * Where the songs are. Deliberately empty by default and never derived from the vault: this
	 * plugin is public, and one person's iCloud layout is a configuration, not a design.
	 */
	mediaFolder: string;
	/**
	 * Where a *new* by-ear note goes -- used only when a song has neither a Songbook chart nor a
	 * study note. Vault-relative. Two of seventeen songs need it today.
	 */
	noteFolder: string;
}

export const DEFAULT_SETTINGS: ByEarSettings = {
	mediaFolder: "",
	noteFolder: "By Ear",
};

export class ByEarSettingTab extends PluginSettingTab {
	plugin: ByEarPlugin;

	constructor(app: App, plugin: ByEarPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Media folder")
			.setDesc(
				"Absolute path to the folder holding your songs. Keep it outside the vault: " +
					"Obsidian Sync caps files at 5 MB, and songs are much bigger than that."
			)
			.addText((text) =>
				text
					.setPlaceholder("/Users/you/…/Music/By Ear")
					.setValue(this.plugin.settings.mediaFolder)
					.onChange(async (value) => {
						this.plugin.settings.mediaFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Folder for new song notes")
			.setDesc(
				"Vault-relative. Only used when a song has no note yet — if it is already in your " +
					"songbook or has a study note, the ledger is written into that note instead."
			)
			.addText((text) =>
				text
					.setPlaceholder("By Ear")
					.setValue(this.plugin.settings.noteFolder)
					.onChange(async (value) => {
						this.plugin.settings.noteFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		const suggestion = suggestedICloudFolder();
		if (suggestion && suggestion !== this.plugin.settings.mediaFolder) {
			new Setting(containerEl)
				.setName("Found an iCloud Drive folder")
				.setDesc(suggestion)
				.addButton((button) =>
					button.setButtonText("Use this").onClick(async () => {
						this.plugin.settings.mediaFolder = suggestion;
						await this.plugin.saveSettings();
						this.display();
					})
				);
		}

		const folder = this.plugin.settings.mediaFolder;
		const status = containerEl.createEl("p", { cls: "by-ear-settings-status" });
		if (Platform.isMobile) {
			// The folder setting is desktop-only and saying so is kinder than showing a path that
			// will never be read: on iOS songs come in through Files and live in the app's cache.
			status.setText(
				"On this device the media folder is not used — add songs in the player with “Add…”, " +
					"and they stay on the device until you remove them. Your notes still sync as normal."
			);
			return;
		}
		if (!folder) {
			status.setText("No folder set yet.");
		} else if (!folderExists(folder)) {
			status.setText("That folder does not exist, or this is the mobile app (which cannot read disk).");
		} else {
			const found = listMedia(folder).length;
			status.setText(`${found} playable file${found === 1 ? "" : "s"} found.`);
		}

		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Re-scan folder").onClick(() => {
				this.plugin.refreshLibrary();
				new Notice("By Ear: folder re-scanned.");
				this.display();
			})
		);
	}
}
