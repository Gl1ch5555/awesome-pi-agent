import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import {
	formatProxyUrlForDisplay,
	normalizeProxyUrl,
	testProxyConnection,
} from "../../../core/http-dispatcher.ts";
import type { ProxySettings } from "../../../core/settings-schema.ts";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.ts";
import { rawKeyHint } from "./keybinding-hints.ts";

type WizardStep =
	| "list"
	| "wizard-protocol"
	| "wizard-host"
	| "wizard-auth"
	| "wizard-user"
	| "wizard-pass"
	| "wizard-scope";

interface WizardDraft {
	protocol: "http" | "https" | "socks5" | "socks5h";
	hostPort: string;
	username: string;
	password: string;
}

function parseDraftFromUrl(rawUrl: string | undefined): WizardDraft {
	const fallback: WizardDraft = {
		protocol: "http",
		hostPort: "",
		username: "",
		password: "",
	};
	const normalized = normalizeProxyUrl(rawUrl);
	if (!normalized) return fallback;
	try {
		const parsed = new URL(normalized);
		const proto = parsed.protocol.replace(/:$/, "").toLowerCase();
		const protocol: WizardDraft["protocol"] =
			proto === "https" || proto === "socks5" || proto === "socks5h" ? proto : "http";
		return {
			protocol,
			hostPort: parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname,
			username: parsed.username ? decodeURIComponent(parsed.username) : "",
			password: parsed.password ? decodeURIComponent(parsed.password) : "",
		};
	} catch {
		return fallback;
	}
}

function buildUrlFromDraft(draft: WizardDraft): string | undefined {
	const hostPart = draft.hostPort.trim().replace(/\/+$/, "");
	if (!hostPart) return undefined;
	const auth =
		draft.username.trim().length > 0
			? `${encodeURIComponent(draft.username.trim())}:${encodeURIComponent(draft.password)}@`
			: "";
	return normalizeProxyUrl(`${draft.protocol}://${auth}${hostPart}`);
}

export class ProxySettingsSubmenu extends Container implements Focusable {
	private settingsList: SettingsList | undefined;
	private selectList: SelectList | undefined;
	private input: Input | undefined;
	private state: ProxySettings;
	private step: WizardStep = "list";
	private draft: WizardDraft;
	private statusMessage: string | undefined;
	private statusIsError = false;
	private testing = false;
	private onChange: (patch: Partial<ProxySettings>) => void;
	private onDone: () => void;
	private onRequestRender?: () => void;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	constructor(
		initial: ProxySettings,
		onChange: (patch: Partial<ProxySettings>) => void,
		onDone: () => void,
		onRequestRender?: () => void,
	) {
		super();
		this.state = {
			enabled: initial.enabled ?? false,
			url: initial.url,
			forAi: initial.forAi ?? true,
			forVoice: initial.forVoice ?? true,
			forSync: initial.forSync ?? false,
			forWeb: initial.forWeb ?? false,
		};
		this.draft = parseDraftFromUrl(this.state.url);
		this.onChange = onChange;
		this.onDone = onDone;
		this.onRequestRender = onRequestRender;
		this.rebuild();
	}

	private setStatus(message: string | undefined, isError = false): void {
		this.statusMessage = message;
		this.statusIsError = isError;
	}

	private startWizard(): void {
		this.draft = parseDraftFromUrl(this.state.url);
		this.setStatus(undefined);
		this.step = "wizard-protocol";
		this.rebuild();
	}

	private applyPatch(patch: Partial<ProxySettings>): void {
		Object.assign(this.state, patch);
		this.onChange(patch);
	}

	private runConnectionTest(): void {
		const url = this.state.url;
		if (!normalizeProxyUrl(url)) {
			this.setStatus("Set a proxy URL first.", true);
			this.rebuild();
			return;
		}
		if (this.testing) return;
		this.testing = true;
		this.setStatus("Testing proxy connection...");
		this.rebuild();

		void testProxyConnection(url!).then((res) => {
			this.testing = false;
			if (res.ok) {
				this.setStatus(`Connection OK (${res.latencyMs}ms, HTTP ${res.status ?? 200})`);
			} else {
				this.setStatus(`Connection failed: ${res.error ?? "unknown error"}`, true);
			}
			this.rebuild();
			this.onRequestRender?.();
		});
	}

	private rebuild(): void {
		this.clear();
		this.settingsList = undefined;
		this.selectList = undefined;
		this.input = undefined;

		if (this.step === "wizard-protocol") {
			this.renderWizardProtocol();
			return;
		}
		if (this.step === "wizard-host") {
			this.renderWizardHost();
			return;
		}
		if (this.step === "wizard-auth") {
			this.renderWizardAuth();
			return;
		}
		if (this.step === "wizard-user") {
			this.renderWizardUser();
			return;
		}
		if (this.step === "wizard-pass") {
			this.renderWizardPass();
			return;
		}
		if (this.step === "wizard-scope") {
			this.renderWizardScope();
			return;
		}

		this.renderMainList();
	}

	private renderMainList(): void {
		this.addChild(new Text(theme.bold(theme.fg("accent", "Proxy Settings")), 0, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Route AI, Voice input, Cloud Sync, or Web requests through HTTP/HTTPS/SOCKS5 proxy."),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const hasUrl = Boolean(normalizeProxyUrl(this.state.url));
		const items: SettingItem[] = [
			{
				id: "proxy-wizard",
				label: hasUrl ? "Edit proxy (step-by-step)" : "Setup proxy (step-by-step)",
				description: "Guided 4-step setup: protocol, host:port, auth, and traffic toggles",
				currentValue: hasUrl ? "wizard" : "start",
				values: [hasUrl ? "wizard" : "start"],
			},
			{
				id: "proxy-enabled",
				label: "Proxy enabled",
				description: "Master switch for proxy routing",
				currentValue: this.state.enabled ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "proxy-url",
				label: "Proxy URL",
				description: "Configured proxy endpoint (Enter to edit step-by-step)",
				currentValue: formatProxyUrlForDisplay(this.state.url),
				values: ["edit"],
			},
			{
				id: "proxy-for-ai",
				label: "Use for AI requests",
				description: "Route LLM API calls and model discovery through the proxy",
				currentValue: this.state.forAi !== false ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "proxy-for-voice",
				label: "Use for Voice input",
				description: "Route Groq Whisper speech-to-text requests through the proxy",
				currentValue: this.state.forVoice !== false ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "proxy-for-sync",
				label: "Use for Cloud Sync",
				description: "Route /sync requests through the proxy",
				currentValue: this.state.forSync === true ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "proxy-for-web",
				label: "Use for Web & Updates",
				description: "Route web search, web fetch, and /update downloads through the proxy",
				currentValue: this.state.forWeb === true ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "proxy-test",
				label: "Test proxy connection",
				description: "Verify connectivity through the configured proxy",
				currentValue: this.testing ? "testing..." : "run",
				values: ["run"],
			},
			{
				id: "proxy-clear",
				label: "Clear proxy",
				description: "Remove proxy URL and disable proxy routing",
				currentValue: "clear",
				values: ["clear"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, val) => {
				if (id === "proxy-wizard" || id === "proxy-url") {
					this.startWizard();
					return;
				}
				if (id === "proxy-enabled") {
					const enabled = val === "true";
					if (enabled && !normalizeProxyUrl(this.state.url)) {
						this.startWizard();
						return;
					}
					this.setStatus(undefined);
					this.applyPatch({ enabled });
					return;
				}
				if (id === "proxy-for-ai") {
					this.applyPatch({ forAi: val === "true" });
					return;
				}
				if (id === "proxy-for-voice") {
					this.applyPatch({ forVoice: val === "true" });
					return;
				}
				if (id === "proxy-for-sync") {
					this.applyPatch({ forSync: val === "true" });
					return;
				}
				if (id === "proxy-for-web") {
					this.applyPatch({ forWeb: val === "true" });
					return;
				}
				if (id === "proxy-test") {
					this.runConnectionTest();
					return;
				}
				if (id === "proxy-clear") {
					this.applyPatch({ enabled: false, url: undefined });
					this.draft = parseDraftFromUrl(undefined);
					this.setStatus("Proxy cleared.");
					this.rebuild();
				}
			},
			this.onDone,
		);
		this.addChild(this.settingsList);

		if (this.statusMessage) {
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(theme.fg(this.statusIsError ? "error" : "success", this.statusMessage), 0, 0),
			);
		}
	}

	private renderWizardProtocol(): void {
		this.addChild(new Text(theme.bold(theme.fg("accent", "Proxy Setup - Step 1/4: Protocol")), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Choose the proxy protocol (or paste a full URL in the next step)."), 0, 0));
		this.addChild(new Spacer(1));

		const options: SelectItem[] = [
			{ value: "http", label: "http://", description: "Standard HTTP proxy (Clash, v2ray, Squid)" },
			{ value: "https", label: "https://", description: "HTTPS proxy" },
			{ value: "socks5", label: "socks5://", description: "SOCKS5 proxy (local DNS)" },
			{ value: "socks5h", label: "socks5h://", description: "SOCKS5h proxy (remote DNS via proxy)" },
		];
		this.selectList = new SelectList(options, options.length, getSelectListTheme(), {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const idx = options.findIndex((o) => o.value === this.draft.protocol);
		if (idx !== -1) this.selectList.setSelectedIndex(idx);
		this.selectList.onSelect = (item) => {
			this.draft.protocol = item.value as WizardDraft["protocol"];
			this.setStatus(undefined);
			this.step = "wizard-host";
			this.rebuild();
		};
		this.selectList.onCancel = () => {
			this.setStatus(undefined);
			this.step = "list";
			this.rebuild();
		};
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(rawKeyHint("Enter", "next") + "  " + rawKeyHint("Esc", "cancel"), 0, 0));
	}

	private renderWizardHost(): void {
		this.addChild(new Text(theme.bold(theme.fg("accent", "Proxy Setup - Step 2/4: Host & Port")), 0, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Protocol: ${this.draft.protocol}://  -  Enter host:port (e.g. 127.0.0.1:7890) or paste full URL`,
				),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.input = new Input();
		this.input.setValue(this.draft.hostPort);
		this.input.focused = this._focused;
		this.addChild(this.input);

		if (this.statusMessage) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg(this.statusIsError ? "error" : "muted", this.statusMessage), 0, 0));
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(rawKeyHint("Enter", "next") + "  " + rawKeyHint("Esc", "back"), 0, 0));
	}

	private renderWizardAuth(): void {
		this.addChild(new Text(theme.bold(theme.fg("accent", "Proxy Setup - Step 3/4: Authentication")), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", `Endpoint: ${this.draft.protocol}://${this.draft.hostPort}`), 0, 0),
		);
		this.addChild(new Spacer(1));

		const options: SelectItem[] = [
			{ value: "none", label: "No auth (skip)", description: "Most local proxies do not require login" },
			{ value: "credentials", label: "Username & password", description: "Add proxy credentials" },
		];
		this.selectList = new SelectList(options, options.length, getSelectListTheme(), {
			minPrimaryColumnWidth: 20,
			maxPrimaryColumnWidth: 28,
		});
		if (this.draft.username) {
			this.selectList.setSelectedIndex(1);
		}
		this.selectList.onSelect = (item) => {
			this.setStatus(undefined);
			if (item.value === "none") {
				this.draft.username = "";
				this.draft.password = "";
				this.step = "wizard-scope";
			} else {
				this.step = "wizard-user";
			}
			this.rebuild();
		};
		this.selectList.onCancel = () => {
			this.setStatus(undefined);
			this.step = "wizard-host";
			this.rebuild();
		};
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(rawKeyHint("Enter", "next") + "  " + rawKeyHint("Esc", "back"), 0, 0));
	}

	private renderWizardUser(): void {
		this.addChild(new Text(theme.bold(theme.fg("accent", "Proxy Setup - Step 3/4: Username")), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Enter proxy username:"), 0, 0));
		this.addChild(new Spacer(1));

		this.input = new Input();
		this.input.setValue(this.draft.username);
		this.input.focused = this._focused;
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(rawKeyHint("Enter", "next") + "  " + rawKeyHint("Esc", "back"), 0, 0));
	}

	private renderWizardPass(): void {
		this.addChild(new Text(theme.bold(theme.fg("accent", "Proxy Setup - Step 3/4: Password")), 0, 0));
		this.addChild(new Text(theme.fg("muted", `Username: ${this.draft.username}  -  Enter proxy password:`), 0, 0));
		this.addChild(new Spacer(1));

		this.input = new Input();
		this.input.setValue(this.draft.password);
		this.input.focused = this._focused;
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text(rawKeyHint("Enter", "next") + "  " + rawKeyHint("Esc", "back"), 0, 0));
	}

	private renderWizardScope(): void {
		this.addChild(new Text(theme.bold(theme.fg("accent", "Proxy Setup - Step 4/4: Traffic Scope")), 0, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Choose which requests use this proxy (you can fine-tune toggles anytime):"),
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		const options: SelectItem[] = [
			{
				value: "ai-voice",
				label: "AI + Voice input",
				description: "Use proxy for LLM requests and Groq Whisper voice input",
			},
			{
				value: "voice-only",
				label: "Voice input only",
				description: "Use proxy only for Groq Whisper speech-to-text",
			},
			{
				value: "ai-only",
				label: "AI requests only",
				description: "Use proxy only for AI model API requests",
			},
			{
				value: "all",
				label: "All traffic",
				description: "AI requests, Voice input, Cloud Sync, and Web & Updates",
			},
		];
		this.selectList = new SelectList(options, options.length, getSelectListTheme(), {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 24,
		});
		this.selectList.onSelect = (item) => {
			const url = buildUrlFromDraft(this.draft);
			if (!url) {
				this.setStatus("Invalid proxy URL. Check host and port.", true);
				this.step = "wizard-host";
				this.rebuild();
				return;
			}
			const scopePatch: Partial<ProxySettings> =
				item.value === "voice-only"
					? { forAi: false, forVoice: true, forSync: false, forWeb: false }
					: item.value === "ai-only"
						? { forAi: true, forVoice: false, forSync: false, forWeb: false }
						: item.value === "all"
							? { forAi: true, forVoice: true, forSync: true, forWeb: true }
							: { forAi: true, forVoice: true, forSync: false, forWeb: false };

			this.applyPatch({ enabled: true, url, ...scopePatch });
			this.setStatus(`Saved proxy: ${formatProxyUrlForDisplay(url)}`);
			this.step = "list";
			this.rebuild();
		};
		this.selectList.onCancel = () => {
			this.setStatus(undefined);
			this.step = "wizard-auth";
			this.rebuild();
		};
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(rawKeyHint("Enter", "save") + "  " + rawKeyHint("Esc", "back"), 0, 0));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (this.step === "wizard-host" && this.input) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.setStatus(undefined);
				this.step = "wizard-protocol";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				const raw = this.input.getValue().trim();
				if (!raw) {
					this.setStatus("Enter host:port (for example 127.0.0.1:7890).", true);
					this.rebuild();
					return;
				}
				if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
					const parsed = normalizeProxyUrl(raw);
					if (!parsed) {
						this.setStatus("Invalid proxy URL. Use http://, https://, socks5://, or socks5h://.", true);
						this.rebuild();
						return;
					}
					this.draft = parseDraftFromUrl(parsed);
					this.setStatus(undefined);
					this.step = this.draft.username ? "wizard-scope" : "wizard-auth";
					this.rebuild();
					return;
				}
				const testUrl = normalizeProxyUrl(`${this.draft.protocol}://${raw}`);
				if (!testUrl) {
					this.setStatus("Invalid host:port.", true);
					this.rebuild();
					return;
				}
				this.draft.hostPort = raw.replace(/\/+$/, "");
				this.setStatus(undefined);
				this.step = "wizard-auth";
				this.rebuild();
				return;
			}
			this.input.handleInput(data);
			return;
		}

		if (this.step === "wizard-user" && this.input) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.step = "wizard-auth";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				this.draft.username = this.input.getValue().trim();
				if (!this.draft.username) {
					this.step = "wizard-scope";
				} else {
					this.step = "wizard-pass";
				}
				this.rebuild();
				return;
			}
			this.input.handleInput(data);
			return;
		}

		if (this.step === "wizard-pass" && this.input) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.step = "wizard-user";
				this.rebuild();
				return;
			}
			if (kb.matches(data, "tui.select.confirm") || data === "\n") {
				this.draft.password = this.input.getValue();
				this.step = "wizard-scope";
				this.rebuild();
				return;
			}
			this.input.handleInput(data);
			return;
		}

		if (this.selectList) {
			this.selectList.handleInput(data);
			return;
		}

		this.settingsList?.handleInput(data);
	}
}
