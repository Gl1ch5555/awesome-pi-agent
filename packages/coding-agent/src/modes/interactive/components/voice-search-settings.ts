import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { SearchProviderId, SearchSettings, VoiceModel, VoiceSettings } from "../../../core/settings-schema.ts";
import { SEARCH_PROVIDERS } from "../../../core/tools/web-search.ts";
import { getSettingsListTheme, theme } from "../theme/theme.ts";
import { rawKeyHint } from "./keybinding-hints.ts";

function maskKey(val: string | undefined): string {
	if (!val || !val.trim()) return "not set";
	const t = val.trim();
	if (t.length <= 8) return "****";
	return `${t.slice(0, 4)}...${t.slice(-4)}`;
}

export class VoiceSettingsSubmenu extends Container implements Focusable {
	private settingsList: SettingsList | undefined;
	private input: Input | undefined;
	private state: VoiceSettings;
	private editingKey = false;
	private onChange: (patch: Partial<VoiceSettings>) => void;
	private onDone: () => void;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	constructor(initial: VoiceSettings, onChange: (patch: Partial<VoiceSettings>) => void, onDone: () => void) {
		super();
		this.state = { ...initial };
		this.onChange = onChange;
		this.onDone = onDone;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Voice Input (Groq Whisper)")), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", "Hold Space to record and stream live transcripts via Groq Whisper."), 0, 0),
		);
		this.addChild(new Spacer(1));

		if (this.editingKey) {
			this.input = new Input();
			this.input.setValue(this.state.groqApiKey ?? "");
			this.input.focused = this._focused;
			this.addChild(new Text(theme.fg("text", "Enter Groq API Key (GROQ_API_KEY):"), 0, 0));
			this.addChild(this.input);
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "save") + "  " + rawKeyHint("Esc", "cancel"), 0, 0));
			return;
		}

		this.input = undefined;
		const items: SettingItem[] = [
			{
				id: "voice-enabled",
				label: "Voice input",
				description: "Enable built-in microphone dictation",
				currentValue: this.state.enabled === false ? "false" : "true",
				values: ["true", "false"],
			},
			{
				id: "voice-hold-space",
				label: "Hold Space to dictate",
				description: "Hold Space key to start/stop recording",
				currentValue: this.state.holdSpaceToTalk === false ? "false" : "true",
				values: ["true", "false"],
			},
			{
				id: "voice-groq-key",
				label: "Groq API key",
				description: "Press Enter to edit Groq API key",
				currentValue: maskKey(this.state.groqApiKey ?? process.env.GROQ_API_KEY),
				values: ["edit"],
			},
			{
				id: "voice-model",
				label: "Whisper model",
				description: "Groq Whisper model used for chunked & final transcription",
				currentValue: this.state.model ?? "whisper-large-v3",
				values: ["whisper-large-v3", "whisper-large-v3-turbo"],
			},
			{
				id: "voice-language",
				label: "Language",
				description: "Recognition language (auto detects automatically)",
				currentValue: this.state.language ?? "auto",
				values: ["auto", "ru", "en", "uk", "de", "fr", "es"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			8,
			getSettingsListTheme(),
			(id, val) => {
				if (id === "voice-enabled") {
					const enabled = val === "true";
					this.state.enabled = enabled;
					this.onChange({ enabled });
				} else if (id === "voice-hold-space") {
					const holdSpaceToTalk = val === "true";
					this.state.holdSpaceToTalk = holdSpaceToTalk;
					this.onChange({ holdSpaceToTalk });
				} else if (id === "voice-groq-key") {
					this.editingKey = true;
					this.rebuild();
				} else if (id === "voice-model") {
					const model = val as VoiceModel;
					this.state.model = model;
					this.onChange({ model });
				} else if (id === "voice-language") {
					this.state.language = val;
					this.onChange({ language: val });
				}
			},
			this.onDone,
		);
		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.editingKey && this.input) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.editingKey = false;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const key = this.input.getValue().trim();
				this.state.groqApiKey = key || undefined;
				this.onChange({ groqApiKey: key });
				this.editingKey = false;
				this.rebuild();
				return;
			}
			this.input.handleInput(data);
			return;
		}
		this.settingsList?.handleInput(data);
	}
}

export class SearchSettingsSubmenu extends Container implements Focusable {
	private settingsList: SettingsList | undefined;
	private input: Input | undefined;
	private state: SearchSettings;
	private editingField: "apiKey" | "searxngUrl" | "googleCseId" | null = null;
	private callbacks: {
		onProviderChange: (provider: SearchProviderId) => void;
		onApiKeyChange: (provider: string, apiKey: string | undefined) => void;
		onExtrasChange: (extras: { enabled?: boolean; searxngUrl?: string; googleCseId?: string }) => void;
		onDone: () => void;
	};

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	constructor(
		initial: SearchSettings,
		callbacks: {
			onProviderChange: (provider: SearchProviderId) => void;
			onApiKeyChange: (provider: string, apiKey: string | undefined) => void;
			onExtrasChange: (extras: { enabled?: boolean; searxngUrl?: string; googleCseId?: string }) => void;
			onDone: () => void;
		},
	) {
		super();
		this.state = {
			...initial,
			apiKeys: { ...(initial.apiKeys ?? {}) },
		};
		this.callbacks = callbacks;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const activeProvider = this.state.provider ?? "tavily";
		const providerMeta = SEARCH_PROVIDERS.find((p) => p.id === activeProvider) ?? SEARCH_PROVIDERS[0]!;

		this.addChild(new Text(theme.bold(theme.fg("accent", "Web Search & Fetch Tools")), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", "Configure default provider (Tavily + 11 fallbacks) and API keys."), 0, 0),
		);
		this.addChild(new Spacer(1));

		if (this.editingField) {
			this.input = new Input();
			if (this.editingField === "apiKey") {
				this.input.setValue(this.state.apiKeys?.[activeProvider] ?? "");
				this.addChild(
					new Text(
						theme.fg("text", `API key for ${providerMeta.label} (${providerMeta.envVar ?? activeProvider}):`),
						0,
						0,
					),
				);
			} else if (this.editingField === "searxngUrl") {
				this.input.setValue(this.state.searxngUrl ?? "");
				this.addChild(new Text(theme.fg("text", "SearXNG base URL (e.g. https://search.example.com):"), 0, 0));
			} else {
				this.input.setValue(this.state.googleCseId ?? "");
				this.addChild(new Text(theme.fg("text", "Google Custom Search Engine ID (cx):"), 0, 0));
			}
			this.input.focused = this._focused;
			this.addChild(this.input);
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "save") + "  " + rawKeyHint("Esc", "cancel"), 0, 0));
			return;
		}

		this.input = undefined;
		const envVal = providerMeta.envVar ? process.env[providerMeta.envVar] : undefined;
		const currentKey = this.state.apiKeys?.[activeProvider] ?? envVal;

		const items: SettingItem[] = [
			{
				id: "search-enabled",
				label: "Web tools enabled",
				description: "Enable built-in web_search and web_fetch tools",
				currentValue: this.state.enabled === false ? "false" : "true",
				values: ["true", "false"],
			},
			{
				id: "search-provider",
				label: "Primary provider",
				description: providerMeta.description,
				currentValue: activeProvider,
				values: SEARCH_PROVIDERS.map((p) => p.id),
			},
			{
				id: "search-api-key",
				label: `${providerMeta.label} API key`,
				description: "Press Enter to edit API key for selected provider",
				currentValue: providerMeta.requiresKey ? maskKey(currentKey) : "optional",
				values: ["edit"],
			},
			{
				id: "search-searxng-url",
				label: "SearXNG URL",
				description: "Self-hosted SearXNG endpoint (optional)",
				currentValue: this.state.searxngUrl || "not set",
				values: ["edit"],
			},
			{
				id: "search-google-cse",
				label: "Google CSE ID (cx)",
				description: "Search engine ID for google_cse provider",
				currentValue: this.state.googleCseId || "not set",
				values: ["edit"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			8,
			getSettingsListTheme(),
			(id, val) => {
				if (id === "search-enabled") {
					const enabled = val === "true";
					this.state.enabled = enabled;
					this.callbacks.onExtrasChange({ enabled });
				} else if (id === "search-provider") {
					const next = val as SearchProviderId;
					this.state.provider = next;
					this.callbacks.onProviderChange(next);
					this.rebuild();
				} else if (id === "search-api-key") {
					this.editingField = "apiKey";
					this.rebuild();
				} else if (id === "search-searxng-url") {
					this.editingField = "searxngUrl";
					this.rebuild();
				} else if (id === "search-google-cse") {
					this.editingField = "googleCseId";
					this.rebuild();
				}
			},
			this.callbacks.onDone,
		);
		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.editingField && this.input) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.editingField = null;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const val = this.input.getValue().trim();
				const activeProvider = this.state.provider ?? "tavily";
				if (this.editingField === "apiKey") {
					this.state.apiKeys ??= {};
					if (val) this.state.apiKeys[activeProvider] = val;
					else delete this.state.apiKeys[activeProvider];
					this.callbacks.onApiKeyChange(activeProvider, val || undefined);
				} else if (this.editingField === "searxngUrl") {
					this.state.searxngUrl = val || undefined;
					this.callbacks.onExtrasChange({ searxngUrl: val });
				} else if (this.editingField === "googleCseId") {
					this.state.googleCseId = val || undefined;
					this.callbacks.onExtrasChange({ googleCseId: val });
				}
				this.editingField = null;
				this.rebuild();
				return;
			}
			this.input.handleInput(data);
			return;
		}
		this.settingsList?.handleInput(data);
	}
}
