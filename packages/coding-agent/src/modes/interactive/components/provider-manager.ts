import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Loader,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	type CustomProviderSummary,
	type DiscoveredProviderModel,
	deleteCustomProvider,
	fetchProviderModelsCatalog,
	inferModelMetadata,
	listCustomProviders,
	normalizeBaseUrl,
	upsertCustomProvider,
} from "../../../core/custom-providers.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { rawKeyHint } from "./keybinding-hints.ts";

type Step =
	| "list"
	| "provider-actions"
	| "add-name"
	| "add-url"
	| "add-key"
	| "add-api"
	| "loading"
	| "checklist"
	| "manual-models";

const API_FORMATS = [
	{ id: "openai-completions", label: "OpenAI Completions (/v1/chat/completions)" },
	{ id: "openai-responses", label: "OpenAI Responses (/v1/responses)" },
	{ id: "anthropic-messages", label: "Anthropic Messages (/v1/messages)" },
	{ id: "google-generative-ai", label: "Google Generative AI" },
] as const;

export interface ProviderManagerCallbacks {
	onSaved: (providerId: string, modelIds: string[]) => Promise<void> | void;
	onDeleted?: (providerId: string) => Promise<void> | void;
	onClose: () => void;
}

export class ProviderManagerComponent extends Container implements Focusable {
	private tui: TUI;
	private callbacks: ProviderManagerCallbacks;
	private modelsPath?: string;

	private step: Step = "list";
	private providers: CustomProviderSummary[] = [];
	private selectedIndex = 0;

	private draftId = "";
	private draftUrl = "";
	private draftKey = "";
	private draftApi = "openai-completions";
	private isEditingExisting = false;

	private textInput: Input;
	private filterInput: Input;
	private loader: Loader | undefined;
	private abortController: AbortController | undefined;

	private discoveredModels: DiscoveredProviderModel[] = [];
	private filteredModels: DiscoveredProviderModel[] = [];
	private checkedIds = new Set<string>();
	// Checklist cursor: 0 = Save button, 1 = Toggle All, >=2 = filteredModels[idx - 2]
	private checklistCursor = 2;
	private checklistScroll = 0;
	private errorText = "";

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.textInput.focused = value;
		this.filterInput.focused = value;
	}

	constructor(tui: TUI, callbacks: ProviderManagerCallbacks, options?: { startAtAdd?: boolean; modelsPath?: string }) {
		super();
		this.tui = tui;
		this.callbacks = callbacks;
		this.modelsPath = options?.modelsPath;
		this.textInput = new Input();
		this.filterInput = new Input();

		this.reloadProviders();
		if (options?.startAtAdd) {
			this.beginAddProvider();
		} else {
			this.rebuild();
		}
	}

	private reloadProviders(): void {
		this.providers = listCustomProviders(this.modelsPath);
	}

	private beginAddProvider(): void {
		this.isEditingExisting = false;
		this.draftId = "";
		this.draftUrl = "";
		this.draftKey = "";
		this.draftApi = "openai-completions";
		this.errorText = "";
		this.textInput.setValue("");
		this.step = "add-name";
		this.rebuild();
	}

	private beginEditProvider(provider: CustomProviderSummary): void {
		this.isEditingExisting = true;
		this.draftId = provider.id;
		this.draftUrl = provider.baseUrl;
		this.draftKey = provider.apiKey;
		this.draftApi = provider.api || "openai-completions";
		this.errorText = "";
		this.selectedIndex = 0;
		this.step = "provider-actions";
		this.rebuild();
	}

	private async loadModelsFromEndpoint(preselectExisting: boolean): Promise<void> {
		this.step = "loading";
		this.errorText = "";
		this.abortController?.abort();
		this.abortController = new AbortController();
		this.rebuild();

		try {
			const models = await fetchProviderModelsCatalog(
				this.draftUrl,
				this.draftKey,
				this.draftApi,
				this.abortController.signal,
			);
			this.loader?.stop();
			this.loader = undefined;

			const existingProvider = this.providers.find((p) => p.id === this.draftId);
			const existingModels = existingProvider?.models ?? [];
			const byId = new Map<string, DiscoveredProviderModel>();
			for (const m of models) byId.set(m.id, m);
			for (const em of existingModels) {
				if (!byId.has(em.id)) {
					byId.set(em.id, {
						id: em.id,
						name: em.name || em.id,
						reasoning: Boolean(em.reasoning),
						input: Array.isArray(em.input) && em.input.includes("image") ? ["text", "image"] : ["text"],
						contextWindow: em.contextWindow ?? 128000,
						maxTokens: em.maxTokens ?? 16384,
					});
				}
			}

			this.discoveredModels = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
			this.checkedIds.clear();
			if (preselectExisting && existingModels.length > 0) {
				for (const em of existingModels) {
					this.checkedIds.add(em.id);
				}
			} else if (!this.isEditingExisting && this.discoveredModels.length <= 15) {
				for (const m of this.discoveredModels) {
					this.checkedIds.add(m.id);
				}
			}

			this.filterInput.setValue("");
			this.applyModelFilter();
			this.checklistCursor = this.filteredModels.length > 0 ? 2 : 0;
			this.checklistScroll = 0;
			this.step = "checklist";
			this.rebuild();
		} catch (error) {
			this.loader?.stop();
			this.loader = undefined;
			if (this.abortController?.signal.aborted) return;
			this.errorText = error instanceof Error ? error.message : String(error);
			this.textInput.setValue("");
			this.step = "manual-models";
			this.rebuild();
		}
	}

	private applyModelFilter(): void {
		const query = this.filterInput.getValue().trim();
		this.filteredModels = query
			? fuzzyFilter(this.discoveredModels, query, (m) => `${m.id} ${m.name}`)
			: [...this.discoveredModels];
		const maxCursor = Math.max(1, this.filteredModels.length + 1);
		if (this.checklistCursor > maxCursor) {
			this.checklistCursor = maxCursor;
		}
	}

	private async saveSelectedModels(): Promise<void> {
		const selected = this.discoveredModels.filter((m) => this.checkedIds.has(m.id));
		if (selected.length === 0) {
			this.errorText = "Select at least one model before saving.";
			this.rebuild();
			return;
		}
		upsertCustomProvider(
			{
				id: this.draftId,
				baseUrl: this.draftUrl,
				apiKey: this.draftKey,
				api: this.draftApi,
				models: selected,
			},
			this.modelsPath,
		);
		this.reloadProviders();
		await this.callbacks.onSaved(
			this.draftId,
			selected.map((m) => m.id),
		);
		this.step = "list";
		this.selectedIndex = 0;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));
		this.addChild(new Spacer(1));

		if (this.step === "list") {
			this.addChild(new Text(theme.bold(theme.fg("accent", "Custom Providers")), 1, 0));
			this.addChild(
				new Text(
					theme.fg("muted", "Add OpenAI/Anthropic-compatible endpoints, load /v1/models, and refresh anytime."),
					1,
					0,
				),
			);
			this.addChild(new Spacer(1));

			const rows = [
				{ label: "+ Add new provider", desc: "Enter name, API URL, API key, then pick models" },
				...this.providers.map((p) => ({
					label: p.id,
					desc: `${p.baseUrl} (${p.models.length} models)`,
				})),
			];
			for (let i = 0; i < rows.length; i++) {
				const row = rows[i]!;
				const active = i === this.selectedIndex;
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				const title = active ? theme.fg("accent", theme.bold(row.label)) : theme.fg("text", row.label);
				const desc = theme.fg("dim", `  ${row.desc}`);
				this.addChild(new Text(`${prefix}${title}${desc}`, 1, 0));
			}

			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					rawKeyHint("Up/Down", "navigate") +
						"  " +
						rawKeyHint("Enter", "open") +
						"  " +
						rawKeyHint("Esc", "close"),
					1,
					0,
				),
			);
		} else if (this.step === "provider-actions") {
			this.addChild(new Text(theme.bold(theme.fg("accent", `Provider: ${this.draftId}`)), 1, 0));
			this.addChild(new Text(theme.fg("muted", `${this.draftUrl}  [${this.draftApi}]`), 1, 0));
			this.addChild(new Spacer(1));

			const actions = [
				"Refresh & select models (/v1/models)",
				"Edit URL / API key / format",
				"Delete provider",
				"Back",
			];
			for (let i = 0; i < actions.length; i++) {
				const active = i === this.selectedIndex;
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				const colorKey = i === 2 && active ? "error" : active ? "accent" : "text";
				this.addChild(new Text(`${prefix}${theme.fg(colorKey, actions[i]!)}`, 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "select") + "  " + rawKeyHint("Esc", "back"), 1, 0));
		} else if (this.step === "add-name") {
			this.addChild(new Text(theme.bold(theme.fg("accent", "Provider Setup (1/4) - Name")), 1, 0));
			this.addChild(new Text(theme.fg("muted", "Short identifier (e.g. omni, openrouter-proxy, local):"), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.textInput);
			if (this.errorText) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("error", this.errorText), 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "next") + "  " + rawKeyHint("Esc", "cancel"), 1, 0));
		} else if (this.step === "add-url") {
			this.addChild(
				new Text(theme.bold(theme.fg("accent", `Provider Setup (2/4) - API URL [${this.draftId}]`)), 1, 0),
			);
			this.addChild(
				new Text(
					theme.fg("muted", "Base URL (e.g. https://api.example.com/v1 or http://localhost:20128/v1):"),
					1,
					0,
				),
			);
			this.addChild(new Spacer(1));
			this.addChild(this.textInput);
			if (this.errorText) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("error", this.errorText), 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "next") + "  " + rawKeyHint("Esc", "back"), 1, 0));
		} else if (this.step === "add-key") {
			this.addChild(
				new Text(theme.bold(theme.fg("accent", `Provider Setup (3/4) - API Key [${this.draftId}]`)), 1, 0),
			);
			this.addChild(new Text(theme.fg("muted", "API key, $ENV_VAR, or leave empty for local endpoint:"), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(this.textInput);
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "next") + "  " + rawKeyHint("Esc", "back"), 1, 0));
		} else if (this.step === "add-api") {
			this.addChild(
				new Text(theme.bold(theme.fg("accent", `Provider Setup (4/4) - Protocol [${this.draftId}]`)), 1, 0),
			);
			this.addChild(new Spacer(1));
			for (let i = 0; i < API_FORMATS.length; i++) {
				const fmt = API_FORMATS[i]!;
				const active = i === this.selectedIndex;
				const prefix = active ? theme.fg("accent", "> ") : "  ";
				this.addChild(new Text(`${prefix}${theme.fg(active ? "accent" : "text", fmt.label)}`, 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "fetch /v1/models") + "  " + rawKeyHint("Esc", "back"), 1, 0));
		} else if (this.step === "loading") {
			this.addChild(new Text(theme.bold(theme.fg("accent", `Fetching models for ${this.draftId}`)), 1, 0));
			this.addChild(new Text(theme.fg("muted", this.draftUrl), 1, 0));
			this.loader?.stop();
			this.loader = new Loader(
				this.tui,
				(s) => theme.fg("accent", s),
				(s) => theme.fg("muted", s),
				"Loading /v1/models...",
				{ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 75 },
			);
			this.addChild(this.loader);
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Esc", "cancel"), 1, 0));
		} else if (this.step === "checklist") {
			const selectedCount = this.checkedIds.size;
			const totalCount = this.discoveredModels.length;
			this.addChild(
				new Text(
					theme.bold(theme.fg("accent", `Select Models for ${this.draftId}`)) +
						theme.fg("muted", `  (${selectedCount}/${totalCount} selected)`),
					1,
					0,
				),
			);
			this.addChild(this.filterInput);
			this.addChild(new Spacer(1));

			// Row 0: Save, Row 1: Toggle all visible
			const saveActive = this.checklistCursor === 0;
			const saveLabel = `[ Save (${selectedCount} selected) ]`;
			this.addChild(
				new Text(
					`${saveActive ? theme.fg("accent", "> ") : "  "}${theme.fg(saveActive ? "success" : "text", theme.bold(saveLabel))}`,
					1,
					0,
				),
			);

			const allVisibleChecked =
				this.filteredModels.length > 0 && this.filteredModels.every((m) => this.checkedIds.has(m.id));
			const toggleActive = this.checklistCursor === 1;
			const toggleLabel = allVisibleChecked
				? `[ Uncheck all visible (${this.filteredModels.length}) ]`
				: `[ Check all visible (${this.filteredModels.length}) ]`;
			this.addChild(
				new Text(
					`${toggleActive ? theme.fg("accent", "> ") : "  "}${theme.fg(toggleActive ? "accent" : "muted", toggleLabel)}`,
					1,
					0,
				),
			);

			const maxRows = 10;
			const modelFocusIdx = this.checklistCursor >= 2 ? this.checklistCursor - 2 : -1;
			if (modelFocusIdx >= 0) {
				if (modelFocusIdx < this.checklistScroll) this.checklistScroll = modelFocusIdx;
				if (modelFocusIdx >= this.checklistScroll + maxRows) {
					this.checklistScroll = modelFocusIdx - maxRows + 1;
				}
			}

			const visible = this.filteredModels.slice(this.checklistScroll, this.checklistScroll + maxRows);
			if (visible.length === 0) {
				this.addChild(new Text(theme.fg("dim", "  No matching models"), 1, 0));
			} else {
				for (let i = 0; i < visible.length; i++) {
					const m = visible[i]!;
					const absIdx = this.checklistScroll + i;
					const active = this.checklistCursor === absIdx + 2;
					const checked = this.checkedIds.has(m.id);
					const box = checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
					const prefix = active ? theme.fg("accent", "> ") : "  ";
					const idText = active ? theme.fg("accent", m.id) : theme.fg("text", m.id);
					const ctxLabel = m.contextWindow >= 1_000_000 ? `${(m.contextWindow / 1_000_000).toFixed(1)}M` : `${Math.round(m.contextWindow / 1000)}k`;
					const thinkLabel = m.reasoning ? "think" : "no-think";
					const meta = theme.fg("dim", `  [${ctxLabel} · ${thinkLabel}]`);
					const extra = m.name && m.name !== m.id ? theme.fg("dim", `  ${m.name}`) : "";
					this.addChild(new Text(truncateToWidth(`${prefix}${box} ${idText}${meta}${extra}`, 100, "..."), 1, 0));
				}
			}

			if (this.errorText) {
				this.addChild(new Spacer(1));
				this.addChild(new Text(theme.fg("error", this.errorText), 1, 0));
			}

			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					rawKeyHint("Space", "toggle") +
						"  " +
						rawKeyHint("Ctrl+T", "thinking") +
						"  " +
						rawKeyHint("Ctrl+S", "save") +
						"  " +
						rawKeyHint("Ctrl+A", "toggle all") +
						"  " +
						rawKeyHint("Esc", "back"),
					1,
					0,
				),
			);
		} else if (this.step === "manual-models") {
			this.addChild(
				new Text(theme.bold(theme.fg("warning", `Could not fetch /v1/models for ${this.draftId}`)), 1, 0),
			);
			if (this.errorText) {
				this.addChild(new Text(theme.fg("error", this.errorText), 1, 0));
			}
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					theme.fg("muted", "Enter comma-separated model IDs to save manually (e.g. gpt-4o, claude-sonnet-4-5):"),
					1,
					0,
				),
			);
			this.addChild(new Spacer(1));
			this.addChild(this.textInput);
			this.addChild(new Spacer(1));
			this.addChild(new Text(rawKeyHint("Enter", "save") + "  " + rawKeyHint("Esc", "back"), 1, 0));
		}

		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));
		this.tui.requestRender();
	}

	dispose(): void {
		this.abortController?.abort();
		this.loader?.stop();
		this.loader = undefined;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (this.step === "list") {
			const total = 1 + this.providers.length;
			if (kb.matches(data, "tui.select.up") || data === "k") {
				this.selectedIndex = (this.selectedIndex - 1 + total) % total;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.down") || data === "j") {
				this.selectedIndex = (this.selectedIndex + 1) % total;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				if (this.selectedIndex === 0) {
					this.beginAddProvider();
				} else {
					const provider = this.providers[this.selectedIndex - 1];
					if (provider) this.beginEditProvider(provider);
				}
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.dispose();
				this.callbacks.onClose();
			}
			return;
		}

		if (this.step === "provider-actions") {
			const count = 4;
			if (kb.matches(data, "tui.select.up") || data === "k") {
				this.selectedIndex = (this.selectedIndex - 1 + count) % count;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.down") || data === "j") {
				this.selectedIndex = (this.selectedIndex + 1) % count;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				if (this.selectedIndex === 0) {
					void this.loadModelsFromEndpoint(true);
				} else if (this.selectedIndex === 1) {
					this.textInput.setValue(this.draftUrl);
					this.step = "add-url";
					this.rebuild();
				} else if (this.selectedIndex === 2) {
					deleteCustomProvider(this.draftId, this.modelsPath);
					void this.callbacks.onDeleted?.(this.draftId);
					this.reloadProviders();
					this.selectedIndex = 0;
					this.step = "list";
					this.rebuild();
				} else {
					this.selectedIndex = 0;
					this.step = "list";
					this.rebuild();
				}
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.selectedIndex = 0;
				this.step = "list";
				this.rebuild();
			}
			return;
		}

		if (this.step === "add-name") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.selectedIndex = 0;
				this.step = "list";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const name = this.textInput.getValue().trim().replace(/\s+/g, "-");
				if (!name) {
					this.errorText = "Provider name is required.";
					this.rebuild();
					return;
				}
				this.draftId = name;
				this.errorText = "";
				this.textInput.setValue(this.draftUrl);
				this.step = "add-url";
				this.rebuild();
				return;
			}
			this.textInput.handleInput(data);
			return;
		}

		if (this.step === "add-url") {
			if (kb.matches(data, "tui.select.cancel")) {
				if (this.isEditingExisting) {
					this.selectedIndex = 0;
					this.step = "provider-actions";
				} else {
					this.textInput.setValue(this.draftId);
					this.step = "add-name";
				}
				this.errorText = "";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const url = normalizeBaseUrl(this.textInput.getValue());
				if (!/^https?:\/\/.+/i.test(url)) {
					this.errorText = "Enter a valid http:// or https:// base URL.";
					this.rebuild();
					return;
				}
				this.draftUrl = url;
				this.errorText = "";
				this.textInput.setValue(this.draftKey);
				this.step = "add-key";
				this.rebuild();
				return;
			}
			this.textInput.handleInput(data);
			return;
		}

		if (this.step === "add-key") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.textInput.setValue(this.draftUrl);
				this.step = "add-url";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				this.draftKey = this.textInput.getValue().trim();
				this.selectedIndex = Math.max(
					0,
					API_FORMATS.findIndex((f) => f.id === this.draftApi),
				);
				this.step = "add-api";
				this.rebuild();
				return;
			}
			this.textInput.handleInput(data);
			return;
		}

		if (this.step === "add-api") {
			if (kb.matches(data, "tui.select.up") || data === "k") {
				this.selectedIndex = (this.selectedIndex - 1 + API_FORMATS.length) % API_FORMATS.length;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.down") || data === "j") {
				this.selectedIndex = (this.selectedIndex + 1) % API_FORMATS.length;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.cancel")) {
				this.textInput.setValue(this.draftKey);
				this.step = "add-key";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				this.draftApi = API_FORMATS[this.selectedIndex]?.id ?? "openai-completions";
				void this.loadModelsFromEndpoint(this.isEditingExisting);
			}
			return;
		}

		if (this.step === "loading") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.abortController?.abort();
				this.loader?.stop();
				this.loader = undefined;
				this.step = "add-api";
				this.rebuild();
			}
			return;
		}

		if (this.step === "checklist") {
			const totalRows = 2 + this.filteredModels.length;
			if (kb.matches(data, "tui.select.cancel")) {
				this.step = this.isEditingExisting ? "provider-actions" : "add-api";
				this.selectedIndex = 0;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "app.models.save") || data === "\x13") {
				void this.saveSelectedModels();
				return;
			}
			if (data === "\x14") {
				// Ctrl+T: toggle reasoning/thinking support for focused model
				const model = this.filteredModels[this.checklistCursor - 2];
				if (model) {
					model.reasoning = !model.reasoning;
					if (model.reasoning && !model.thinkingLevelMap) {
						model.thinkingLevelMap = inferModelMetadata({ id: model.id, reasoning: true }).thinkingLevelMap ?? {
							minimal: "minimal",
							low: "low",
							medium: "medium",
							high: "high",
						};
					}
					this.rebuild();
				}
				return;
			}
			if (data === "\x01") {
				// Ctrl+A: toggle all visible
				const allChecked =
					this.filteredModels.length > 0 && this.filteredModels.every((m) => this.checkedIds.has(m.id));
				for (const m of this.filteredModels) {
					if (allChecked) this.checkedIds.delete(m.id);
					else this.checkedIds.add(m.id);
				}
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.up")) {
				this.checklistCursor = (this.checklistCursor - 1 + totalRows) % totalRows;
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.down")) {
				this.checklistCursor = (this.checklistCursor + 1) % totalRows;
				this.rebuild();
				return;
			}
			if (data === " " || kb.matches(data, "tui.select.confirm") || data === "\n") {
				if (this.checklistCursor === 0) {
					if (data !== " ") void this.saveSelectedModels();
					return;
				}
				if (this.checklistCursor === 1) {
					const allChecked =
						this.filteredModels.length > 0 && this.filteredModels.every((m) => this.checkedIds.has(m.id));
					for (const m of this.filteredModels) {
						if (allChecked) this.checkedIds.delete(m.id);
						else this.checkedIds.add(m.id);
					}
					this.rebuild();
					return;
				}
				const model = this.filteredModels[this.checklistCursor - 2];
				if (model) {
					if (this.checkedIds.has(model.id)) this.checkedIds.delete(model.id);
					else this.checkedIds.add(model.id);
					this.rebuild();
				}
				return;
			}

			// Type into filter input
			const prev = this.filterInput.getValue();
			this.filterInput.handleInput(data);
			if (this.filterInput.getValue() !== prev) {
				this.applyModelFilter();
				this.rebuild();
			}
			return;
		}

		if (this.step === "manual-models") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.errorText = "";
				this.step = this.isEditingExisting ? "provider-actions" : "add-api";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const ids = this.textInput
					.getValue()
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				if (ids.length === 0) {
					this.errorText = "Enter at least one model ID.";
					this.rebuild();
					return;
				}
				this.discoveredModels = ids.map((id) => inferModelMetadata({ id }));
				this.checkedIds = new Set(ids);
				void this.saveSelectedModels();
				return;
			}
			this.textInput.handleInput(data);
		}
	}
}
