import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { SearchProviderId } from "../../../core/settings-schema.ts";
import { SEARCH_PROVIDERS } from "../../../core/tools/web-search.ts";
import { SYSTEM_THEME_NAME } from "../theme/system-theme.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { rawKeyHint } from "./keybinding-hints.ts";
import { ProviderManagerComponent } from "./provider-manager.ts";
import { SyncManagerComponent } from "./sync-manager.ts";

export interface OnboardingWizardResult {
	theme: string;
	searchProvider: SearchProviderId;
	searchApiKey?: string;
	searxngUrl?: string;
	groqApiKey?: string;
}

export interface OnboardingWizardOptions {
	tui: TUI;
	onThemePreview: (themeName: string) => void;
	onComplete: (result: OnboardingWizardResult) => void;
	onSkip: () => void;
}

type WizardStep =
	| "mode"
	| "sync"
	| "theme"
	| "search-provider"
	| "search-key"
	| "voice-key"
	| "provider-prompt"
	| "provider-manager";

const THEME_OPTIONS = [
	{ value: "graphite", label: "Graphite (minimalist dark, default)" },
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
	{ value: SYSTEM_THEME_NAME, label: "System (terminal colors)" },
] as const;

export class OnboardingWizardComponent extends Container implements Focusable {
	private tui: TUI;
	private options: OnboardingWizardOptions;
	private step: WizardStep = "mode";

	private modeIndex = 0;
	private themeIndex = 0;
	private searchProviderIndex = 0;
	private providerPromptIndex = 0;

	private searchApiKey: string | undefined;
	private searxngUrl: string | undefined;
	private groqApiKey: string | undefined;

	private input: Input;
	private providerManager: ProviderManagerComponent | undefined;
	private syncManager: SyncManagerComponent | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
		if (this.providerManager) this.providerManager.focused = value;
		if (this.syncManager) this.syncManager.focused = value;
	}

	constructor(options: OnboardingWizardOptions) {
		super();
		this.tui = options.tui;
		this.options = options;
		this.input = new Input();
		this.rebuild();
	}

	private getSelectedSearchProvider() {
		return SEARCH_PROVIDERS[this.searchProviderIndex] ?? SEARCH_PROVIDERS[0]!;
	}

	private finishWizard(): void {
		this.options.onComplete({
			theme: THEME_OPTIONS[this.themeIndex]?.value ?? "graphite",
			searchProvider: this.getSelectedSearchProvider().id,
			searchApiKey: this.searchApiKey,
			searxngUrl: this.searxngUrl,
			groqApiKey: this.groqApiKey,
		});
	}

	private rebuild(): void {
		this.clear();

		if (this.step === "provider-manager" && this.providerManager) {
			this.addChild(this.providerManager);
			this.tui.requestRender();
			return;
		}
		if (this.step === "sync" && this.syncManager) {
			this.addChild(this.syncManager);
			this.tui.requestRender();
			return;
		}

		this.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "pi-awesome setup")), 1, 0));
		this.addChild(
			new Text(theme.fg("dim", "Quick initial configuration (also editable anytime in /settings)"), 1, 0),
		);
		this.addChild(new Spacer(1));

		if (this.step === "mode") {
			this.addChild(new Text(theme.fg("text", "Start fresh or restore from Cloud Sync?"), 1, 0));
			this.addChild(new Spacer(1));
			const modes = [
				"New setup (theme, search, Groq Whisper voice, custom providers)",
				"Restore from Cloud Sync (login & password -> settings, keys, models, skills)",
			];
			for (let i = 0; i < modes.length; i++) {
				const active = i === this.modeIndex;
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				this.addChild(new Text(`${prefix}${theme.fg(active ? "accent" : "text", modes[i]!)}`, 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					`${rawKeyHint("Up/Down", "select")}  ${rawKeyHint("Enter", "continue")}  ${rawKeyHint("Esc", "skip all")}`,
					1,
					0,
				),
			);
		} else if (this.step === "theme") {
			this.addChild(new Text(theme.fg("text", "1/4  Select interface theme:"), 1, 0));
			this.addChild(new Spacer(1));
			for (let i = 0; i < THEME_OPTIONS.length; i++) {
				const opt = THEME_OPTIONS[i]!;
				const active = i === this.themeIndex;
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				this.addChild(new Text(`${prefix}${theme.fg(active ? "accent" : "text", opt.label)}`, 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					rawKeyHint("Up/Down", "select") +
						"  " +
						rawKeyHint("Enter", "next") +
						"  " +
						rawKeyHint("Esc", "skip all"),
					1,
					0,
				),
			);
		} else if (this.step === "search-provider") {
			this.addChild(
				new Text(theme.fg("text", "2/4  Select web search provider (built-in web_search & web_fetch):"), 1, 0),
			);
			this.addChild(new Spacer(1));
			for (let i = 0; i < SEARCH_PROVIDERS.length; i++) {
				const p = SEARCH_PROVIDERS[i]!;
				const active = i === this.searchProviderIndex;
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				const keyTag = p.requiresKey ? "key" : "free";
				const line = `${prefix}${theme.fg(active ? "accent" : "text", p.label)} ${theme.fg("dim", `[${keyTag}] - ${p.description}`)}`;
				this.addChild(new Text(line, 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					rawKeyHint("Up/Down", "select") +
						"  " +
						rawKeyHint("Enter", "continue") +
						"  " +
						rawKeyHint("Esc", "back"),
					1,
					0,
				),
			);
		} else if (this.step === "search-key") {
			const p = this.getSelectedSearchProvider();
			const promptText =
				p.id === "searxng"
					? "Enter SearXNG base URL (or leave empty to skip):"
					: `Enter API key for ${p.label} (${p.envVar ?? p.id}, leave empty to skip):`;
			this.addChild(new Text(theme.fg("text", `2/4  ${promptText}`), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.input);
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "next") + "  " + rawKeyHint("Esc", "back"), 1, 0));
		} else if (this.step === "voice-key") {
			this.addChild(
				new Text(theme.fg("text", "3/4  Voice input (hold Space -> Groq Whisper whisper-large-v3):"), 1, 0),
			);
			this.addChild(
				new Text(
					theme.fg("muted", "Enter Groq API key (GROQ_API_KEY), or press Enter with empty input to skip:"),
					1,
					0,
				),
			);
			this.addChild(new Spacer(1));
			this.addChild(this.input);
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "next") + "  " + rawKeyHint("Esc", "back"), 1, 0));
		} else if (this.step === "provider-prompt") {
			this.addChild(
				new Text(theme.fg("text", "4/4  Add a custom LLM provider (Name, API URL, Key -> /v1/models)?"), 1, 0),
			);
			this.addChild(new Spacer(1));
			const choices = ["Finish setup now", "Add custom provider (/v1/models)"];
			for (let i = 0; i < choices.length; i++) {
				const active = i === this.providerPromptIndex;
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				this.addChild(new Text(`${prefix}${theme.fg(active ? "accent" : "text", choices[i]!)}`, 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "confirm") + "  " + rawKeyHint("Esc", "back"), 1, 0));
		}

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (this.step === "provider-manager" && this.providerManager) {
			this.providerManager.handleInput(data);
			return;
		}
		if (this.step === "sync" && this.syncManager) {
			this.syncManager.handleInput(data);
			return;
		}

		if (this.step === "mode") {
			if (kb.matches(data, "tui.select.up") || data === "k" || kb.matches(data, "tui.select.down") || data === "j") {
				this.modeIndex = this.modeIndex === 0 ? 1 : 0;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.options.onSkip();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				if (this.modeIndex === 0) {
					this.step = "theme";
					this.rebuild();
				} else {
					let restored = false;
					this.syncManager = new SyncManagerComponent(this.tui, {
						onPulled: () => {
							restored = true;
						},
						onClose: () => {
							this.syncManager = undefined;
							if (restored) {
								this.options.onSkip();
							} else {
								this.step = "mode";
								this.rebuild();
							}
						},
					});
					this.syncManager.focused = this._focused;
					this.step = "sync";
					this.rebuild();
				}
			}
			return;
		}

		if (this.step === "theme") {
			if (kb.matches(data, "tui.select.up") || data === "k") {
				this.themeIndex = (this.themeIndex - 1 + THEME_OPTIONS.length) % THEME_OPTIONS.length;
				this.options.onThemePreview(THEME_OPTIONS[this.themeIndex]!.value);
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.down") || data === "j") {
				this.themeIndex = (this.themeIndex + 1) % THEME_OPTIONS.length;
				this.options.onThemePreview(THEME_OPTIONS[this.themeIndex]!.value);
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				this.step = "search-provider";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.options.onSkip();
			}
			return;
		}

		if (this.step === "search-provider") {
			if (kb.matches(data, "tui.select.up") || data === "k") {
				this.searchProviderIndex =
					(this.searchProviderIndex - 1 + SEARCH_PROVIDERS.length) % SEARCH_PROVIDERS.length;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.down") || data === "j") {
				this.searchProviderIndex = (this.searchProviderIndex + 1) % SEARCH_PROVIDERS.length;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.step = "theme";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const selected = this.getSelectedSearchProvider();
				if (selected.requiresKey || selected.id === "searxng" || selected.id === "jina") {
					this.input.setValue(this.searchApiKey ?? "");
					this.step = "search-key";
				} else {
					this.input.setValue(this.groqApiKey ?? "");
					this.step = "voice-key";
				}
				this.rebuild();
			}
			return;
		}

		if (this.step === "search-key") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.step = "search-provider";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const val = this.input.getValue().trim();
				const selected = this.getSelectedSearchProvider();
				if (selected.id === "searxng") {
					this.searxngUrl = val || undefined;
				} else {
					this.searchApiKey = val || undefined;
				}
				this.input.setValue(this.groqApiKey ?? "");
				this.step = "voice-key";
				this.rebuild();
				return;
			}
			this.input.handleInput(data);
			return;
		}

		if (this.step === "voice-key") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.step = "search-provider";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const val = this.input.getValue().trim();
				this.groqApiKey = val || undefined;
				this.providerPromptIndex = 0;
				this.step = "provider-prompt";
				this.rebuild();
				return;
			}
			this.input.handleInput(data);
			return;
		}

		if (this.step === "provider-prompt") {
			if (kb.matches(data, "tui.select.up") || data === "k" || kb.matches(data, "tui.select.down") || data === "j") {
				this.providerPromptIndex = this.providerPromptIndex === 0 ? 1 : 0;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.input.setValue(this.groqApiKey ?? "");
				this.step = "voice-key";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				if (this.providerPromptIndex === 0) {
					this.finishWizard();
				} else {
					this.providerManager = new ProviderManagerComponent(
						this.tui,
						{
							onSaved: () => {
								this.providerManager?.dispose();
								this.providerManager = undefined;
								this.finishWizard();
							},
							onClose: () => {
								this.providerManager?.dispose();
								this.providerManager = undefined;
								this.step = "provider-prompt";
								this.rebuild();
							},
						},
						{ startAtAdd: true },
					);
					this.providerManager.focused = this._focused;
					this.step = "provider-manager";
					this.rebuild();
				}
			}
		}
	}
}
