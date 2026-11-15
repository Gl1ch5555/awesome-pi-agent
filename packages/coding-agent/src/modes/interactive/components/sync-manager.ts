import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import {
	type CloudSyncState,
	DEFAULT_CLOUD_SYNC_URL,
	readSyncState,
	syncAuthenticate,
	syncLogout,
	syncPull,
	syncPush,
	writeSyncState,
} from "../../../core/cloud-sync.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { rawKeyHint } from "./keybinding-hints.ts";

type Step = "menu" | "auth-user" | "auth-pass" | "server-url" | "busy";

export interface SyncManagerCallbacks {
	onPulled: () => Promise<void> | void;
	onStatus?: (message: string) => void;
	onClose: () => void;
}

export class SyncManagerComponent extends Container implements Focusable {
	private tui: TUI;
	private callbacks: SyncManagerCallbacks;
	private state: CloudSyncState | undefined;
	private step: Step = "menu";
	private authMode: "login" | "register" = "login";
	private selectedIndex = 0;
	private draftServerUrl = DEFAULT_CLOUD_SYNC_URL;
	private draftUser = "";
	private input: Input;
	private statusMessage = "";
	private errorMessage = "";
	private activeAbortController: AbortController | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(tui: TUI, callbacks: SyncManagerCallbacks) {
		super();
		this.tui = tui;
		this.callbacks = callbacks;
		this.input = new Input();
		this.state = readSyncState();
		if (this.state) {
			this.draftServerUrl = this.state.serverUrl;
		}
		this.rebuild();
	}

	private getMenuItems(): string[] {
		if (!this.state) {
			return [
				"Sign in (existing account)",
				"Create account (register)",
				`Server URL (${this.draftServerUrl})`,
				"Close",
			];
		}
		return [
			"Push local -> Cloud (settings, keys, models, skills, plugins)",
			"Pull Cloud -> local",
			`Auto-sync: ${this.state.autoSync ? "on" : "off"}`,
			"Sign out",
			"Close",
		];
	}

	private formatUpdated(ts: number): string {
		if (!ts) return "never";
		return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Cloud Sync")), 1, 0));

		if (this.state) {
			this.addChild(
				new Text(
					theme.fg(
						"muted",
						`Signed in as ${this.state.user} @ ${this.state.serverUrl}  |  last sync: ${this.formatUpdated(this.state.lastSyncUpdated)}`,
					),
					1,
					0,
				),
			);
		} else {
			this.addChild(
				new Text(theme.fg("muted", "Sync settings, API keys, models, skills, and plugins across devices."), 1, 0),
			);
		}
		this.addChild(new Spacer(1));

		if (this.step === "menu") {
			const items = this.getMenuItems();
			for (let i = 0; i < items.length; i++) {
				const active = i === this.selectedIndex;
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				this.addChild(new Text(`${prefix}${theme.fg(active ? "accent" : "text", items[i]!)}`, 1, 0));
			}
			if (this.statusMessage) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("success", this.statusMessage), 1, 0));
			}
			if (this.errorMessage) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("error", this.errorMessage), 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					`${rawKeyHint("Up/Down", "navigate")}  ${rawKeyHint("Enter", "select")}  ${rawKeyHint("Esc", "close")}`,
					1,
					0,
				),
			);
		} else if (this.step === "auth-user") {
			const title = this.authMode === "register" ? "Create Account (1/2) - Login:" : "Sign In (1/2) - Login:";
			this.addChild(new Text(theme.fg("text", title), 1, 0));
			this.addChild(new Text(theme.fg("dim", "2-64 characters (letters, digits, _ . @ + -)"), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.input);
			if (this.errorMessage) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("error", this.errorMessage), 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(new Text(`${rawKeyHint("Enter", "next")}  ${rawKeyHint("Esc", "back")}`, 1, 0));
		} else if (this.step === "auth-pass") {
			const title =
				this.authMode === "register"
					? `Create Account (2/2) - Password for ${this.draftUser}:`
					: `Sign In (2/2) - Password for ${this.draftUser}:`;
			this.addChild(new Text(theme.fg("text", title), 1, 0));
			this.addChild(new Text(theme.fg("dim", "At least 4 characters"), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.input);
			if (this.errorMessage) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("error", this.errorMessage), 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(new Text(`${rawKeyHint("Enter", "submit")}  ${rawKeyHint("Esc", "back")}`, 1, 0));
		} else if (this.step === "server-url") {
			this.addChild(new Text(theme.fg("text", "Cloud Sync Server URL:"), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.input);
			this.addChild(new Spacer(1));
			this.addChild(new Text(`${rawKeyHint("Enter", "save")}  ${rawKeyHint("Esc", "back")}`, 1, 0));
		} else if (this.step === "busy") {
			this.addChild(new Text(theme.fg("accent", this.statusMessage || "Syncing..."), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Esc", "cancel"), 1, 0));
		}

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));
		this.tui.requestRender();
	}

	private async runPush(): Promise<void> {
		const controller = new AbortController();
		this.activeAbortController = controller;
		this.step = "busy";
		this.statusMessage = "Pushing settings, API keys, models, and skills...";
		this.errorMessage = "";
		this.rebuild();
		try {
			const res = await syncPush(undefined, controller.signal);
			this.state = readSyncState();
			this.statusMessage = `Pushed to cloud (${res.skillFiles} skill files synced)`;
		} catch (error) {
			this.statusMessage = "";
			this.errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.activeAbortController === controller) this.activeAbortController = undefined;
		}
		this.step = "menu";
		this.rebuild();
	}

	private async runPull(): Promise<void> {
		const controller = new AbortController();
		this.activeAbortController = controller;
		this.step = "busy";
		this.statusMessage = "Pulling settings, API keys, models, and skills...";
		this.errorMessage = "";
		this.rebuild();
		try {
			const res = await syncPull(undefined, controller.signal);
			this.state = readSyncState();
			if (!res.hasData) {
				this.statusMessage = "Cloud account has no saved backup yet. Use Push first.";
			} else {
				await this.callbacks.onPulled();
				this.statusMessage = `Pulled from cloud (${res.skillFiles} skills, ${res.extensionFiles} plugins, ${res.promptFiles} prompts)`;
			}
		} catch (error) {
			this.statusMessage = "";
			this.errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.activeAbortController === controller) this.activeAbortController = undefined;
		}
		this.step = "menu";
		this.rebuild();
	}

	private async runAuth(password: string): Promise<void> {
		const controller = new AbortController();
		this.activeAbortController = controller;
		this.step = "busy";
		this.statusMessage = this.authMode === "register" ? "Creating account..." : "Signing in...";
		this.errorMessage = "";
		this.rebuild();
		try {
			this.state = await syncAuthenticate(
				this.authMode,
				this.draftServerUrl,
				this.draftUser,
				password,
				undefined,
				controller.signal,
			);
		} catch (error) {
			if (this.activeAbortController === controller) this.activeAbortController = undefined;
			this.statusMessage = "";
			this.errorMessage = error instanceof Error ? error.message : String(error);
			this.input.setValue("");
			this.step = "auth-pass";
			this.rebuild();
			return;
		}

		try {
			if (this.authMode === "login") {
				const pull = await syncPull(undefined, controller.signal);
				if (pull.hasData) {
					await this.callbacks.onPulled();
					this.statusMessage = `Signed in as ${this.state.user} and restored cloud backup`;
				} else {
					const push = await syncPush(undefined, controller.signal);
					this.statusMessage = `Signed in as ${this.state.user} (uploaded local config, ${push.skillFiles} skills)`;
				}
			} else {
				const push = await syncPush(undefined, controller.signal);
				this.statusMessage = `Account created and synced (${push.skillFiles} skill files)`;
			}
		} catch (error) {
			this.statusMessage = "";
			this.errorMessage = `Signed in as ${this.state.user}, but initial sync failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			if (this.activeAbortController === controller) this.activeAbortController = undefined;
		}
		this.state = readSyncState();
		this.selectedIndex = 0;
		this.step = "menu";
		this.rebuild();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.step === "busy") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.activeAbortController?.abort();
			}
			return;
		}

		if (this.step === "menu") {
			const items = this.getMenuItems();
			if (kb.matches(data, "tui.select.up") || data === "k") {
				this.selectedIndex = (this.selectedIndex - 1 + items.length) % items.length;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.down") || data === "j") {
				this.selectedIndex = (this.selectedIndex + 1) % items.length;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.callbacks.onClose();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				this.errorMessage = "";
				this.statusMessage = "";
				if (!this.state) {
					if (this.selectedIndex === 0) {
						this.authMode = "login";
						this.draftUser = "";
						this.input.setValue("");
						this.step = "auth-user";
						this.rebuild();
					} else if (this.selectedIndex === 1) {
						this.authMode = "register";
						this.draftUser = "";
						this.input.setValue("");
						this.step = "auth-user";
						this.rebuild();
					} else if (this.selectedIndex === 2) {
						this.input.setValue(this.draftServerUrl);
						this.step = "server-url";
						this.rebuild();
					} else {
						this.callbacks.onClose();
					}
				} else {
					if (this.selectedIndex === 0) {
						void this.runPush();
					} else if (this.selectedIndex === 1) {
						void this.runPull();
					} else if (this.selectedIndex === 2) {
						this.state.autoSync = !this.state.autoSync;
						writeSyncState(this.state);
						this.rebuild();
					} else if (this.selectedIndex === 3) {
						void syncLogout().then(() => {
							this.state = undefined;
							this.selectedIndex = 0;
							this.statusMessage = "Signed out";
							this.rebuild();
						});
					} else {
						this.callbacks.onClose();
					}
				}
			}
			return;
		}

		if (this.step === "auth-user") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.errorMessage = "";
				this.step = "menu";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const user = this.input.getValue().trim();
				if (!/^[\w.@+-]{2,64}$/.test(user)) {
					this.errorMessage = "Login must be 2-64 chars (letters, digits, _ . @ + -).";
					this.rebuild();
					return;
				}
				this.draftUser = user;
				this.errorMessage = "";
				this.input.setValue("");
				this.step = "auth-pass";
				this.rebuild();
				return;
			}
			this.input.handleInput(data);
			return;
		}

		if (this.step === "auth-pass") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.errorMessage = "";
				this.input.setValue(this.draftUser);
				this.step = "auth-user";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const pass = this.input.getValue();
				if (pass.length < 4) {
					this.errorMessage = "Password must be at least 4 characters.";
					this.rebuild();
					return;
				}
				void this.runAuth(pass);
				return;
			}
			this.input.handleInput(data);
			return;
		}

		if (this.step === "server-url") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.step = "menu";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const val = this.input.getValue().trim().replace(/\/+$/, "");
				if (/^https?:\/\/.+/i.test(val)) {
					this.draftServerUrl = val;
				}
				this.step = "menu";
				this.rebuild();
				return;
			}
			this.input.handleInput(data);
		}
	}
}
