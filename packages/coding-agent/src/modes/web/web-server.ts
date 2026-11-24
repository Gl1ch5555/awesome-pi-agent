import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import {
	DEFAULT_CLOUD_SYNC_URL,
	readSyncState,
	syncAuthenticate,
	syncBidirectional,
	syncLogout,
	syncPull,
	syncPush,
	writeSyncState,
} from "../../core/cloud-sync.ts";
import {
	deleteCustomProvider,
	fetchProviderModelsCatalog,
	inferModelMetadata,
	listCustomProviders,
	upsertCustomProvider,
} from "../../core/custom-providers.ts";
import { clearMemoryTarget, MEMORY_CHAR_LIMITS, readMemorySnapshot } from "../../core/memory-store.ts";
import { configureHttpDispatcher, scopedFetch, testProxyConnection } from "../../core/http-dispatcher.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { getAvailableThemes } from "../interactive/theme/theme.ts";
import { PI_WEB_ICON_SVG, PI_WEB_MANIFEST, PI_WEB_SW_JS, renderWebUiHtml } from "./web-ui-html.ts";

export interface PiWebServerOptions {
	host?: string;
	port?: number;
	password?: string;
	onStateChange?: () => void;
	onNewSession?: () => Promise<void>;
	onSwitchSession?: (path: string) => Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 30141;
const MAX_PORT_ATTEMPTS = 20;

function extractCleanTitle(raw: string): string {
	const noUrls = raw.replace(/https?:\/\/\S+/gi, "").replace(/`[^`]*`/g, "").replace(/\s+/g, " ").trim();
	const base = noUrls || raw.replace(/^https?:\/\/(www\.)?/i, "").split(/[/?#]/)[0] || "Новая сессия";
	const words = base.split(" ").filter(Boolean).slice(0, 6).join(" ");
	return words.length > 42 ? `${words.slice(0, 41)}…` : words;
}

export class PiWebServer {
	private readonly sessionSource: AgentSession | (() => AgentSession);
	private readonly host: string;
	private readonly preferredPort: number;
	private readonly password?: string;
	private readonly onStateChange?: () => void;
	private readonly onNewSession?: () => Promise<void>;
	private readonly onSwitchSession?: (path: string) => Promise<void>;
	private server: Server | undefined;
	private actualPort: number | undefined;
	private sseClients = new Set<ServerResponse>();
	private unsubscribeSession: (() => void) | undefined;

	constructor(sessionSource: AgentSession | (() => AgentSession), options: PiWebServerOptions = {}) {
		this.sessionSource = sessionSource;
		this.host = options.host || process.env.PI_WEB_HOSTNAME || DEFAULT_HOST;
		this.preferredPort = options.port || Number(process.env.PI_WEB_PORT) || DEFAULT_PORT;
		this.password = options.password || process.env.PI_WEB_PASSWORD || undefined;
		this.onStateChange = options.onStateChange;
		this.onNewSession = options.onNewSession;
		this.onSwitchSession = options.onSwitchSession;
	}

	private get session(): AgentSession {
		return typeof this.sessionSource === "function" ? this.sessionSource() : this.sessionSource;
	}

	private get archiveFilePath(): string {
		return join(this.session.settingsManager.getAgentDir(), "web-archived-sessions.json");
	}

	private loadArchivedSet(): Set<string> {
		try {
			if (!existsSync(this.archiveFilePath)) return new Set();
			const parsed = JSON.parse(readFileSync(this.archiveFilePath, "utf-8"));
			return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
		} catch {
			return new Set();
		}
	}

	private saveArchivedSet(set: Set<string>): void {
		try {
			mkdirSync(dirname(this.archiveFilePath), { recursive: true });
			writeFileSync(this.archiveFilePath, JSON.stringify(Array.from(set), null, 2));
		} catch {
			// ignore write errors
		}
	}

	private maybeAutoNameSession(): void {
		try {
			if (this.session.sessionManager.getSessionName()) return;
			const firstUser = this.session.messages.find((m) => m.role === "user");
			if (!firstUser) return;
			const raw =
				typeof firstUser.content === "string"
					? firstUser.content
					: Array.isArray(firstUser.content)
						? firstUser.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
								.map((c) => c.text)
								.join(" ")
						: "";
			if (!raw.trim()) return;
			const title = extractCleanTitle(raw);
			if (title) {
				this.session.setSessionName(title);
			}
		} catch {
			// ignore auto-title failures
		}
	}

	getUrl(): string | undefined {
		if (!this.server || this.actualPort === undefined) return undefined;
		const displayHost = this.host === "0.0.0.0" ? "127.0.0.1" : this.host;
		return `http://${displayHost}:${this.actualPort}`;
	}

	isRunning(): boolean {
		return this.server !== undefined;
	}

	private subscribeToCurrentSession(): void {
		if (this.unsubscribeSession) {
			this.unsubscribeSession();
			this.unsubscribeSession = undefined;
		}
		this.unsubscribeSession = this.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "agent_end") {
				this.maybeAutoNameSession();
				this.triggerBackgroundSync();
			}
			if (
				event.type === "agent_start" ||
				event.type === "agent_end" ||
				event.type === "agent_settled" ||
				event.type === "message_start" ||
				event.type === "message_update" ||
				event.type === "message_end" ||
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end"
			) {
				this.broadcastEvent(event);
			}
		});
	}

	rebindSession(): void {
		if (!this.server) return;
		this.subscribeToCurrentSession();
		this.broadcastRaw({ type: "session_changed" });
	}

	private syncInFlight = false;

	private triggerBackgroundSync(): void {
		if (this.syncInFlight) return;
		const agentDir = this.session.settingsManager.getAgentDir();
		const state = readSyncState(agentDir);
		if (!state?.autoSync) return;
		this.syncInFlight = true;
		void this.session.settingsManager
			.flush()
			.then(() => syncBidirectional(agentDir))
			.then(async (res) => {
				if ((res.action === "pulled" || res.action === "merged") && !this.session.isStreaming && !this.session.isCompacting) {
					await this.session.settingsManager.reload();
					await this.session.modelRuntime.refresh({ allowNetwork: false });
					await this.session.reload();
					const syncedProvider = this.session.settingsManager.getDefaultProvider();
					const syncedModelId = this.session.settingsManager.getDefaultModel();
					if (syncedProvider && syncedModelId) {
						const syncedModel = this.session.modelRuntime.getModel(syncedProvider, syncedModelId);
						const cur = this.session.model;
						if (syncedModel && (!cur || cur.provider !== syncedModel.provider || cur.id !== syncedModel.id)) {
							await this.session.setModel(syncedModel, { persist: false }).catch(() => {});
						}
					}
					this.onStateChange?.();
					this.broadcastRaw({ type: "session_changed" });
				}
			})
			.catch(() => {})
			.finally(() => {
				this.syncInFlight = false;
			});
	}

	async start(): Promise<string> {
		if (this.server && this.actualPort !== undefined) {
			return this.getUrl()!;
		}

		this.subscribeToCurrentSession();

		for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
			const candidatePort = this.preferredPort + offset;
			try {
				await this.listenOn(candidatePort);
				this.actualPort = candidatePort;
				return this.getUrl()!;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "EADDRINUSE") throw err;
			}
		}
		throw new Error(`Could not bind Web UI server on ports ${this.preferredPort}..${this.preferredPort + MAX_PORT_ATTEMPTS - 1}`);
	}

	private listenOn(port: number): Promise<void> {
		return new Promise((resolveListen, rejectListen) => {
			const srv = createServer((req, res) => {
				void this.handleRequest(req, res).catch((err) => {
					if (!res.headersSent) {
						this.sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
					}
				});
			});
			srv.once("error", rejectListen);
			srv.listen(port, this.host, () => {
				srv.removeListener("error", rejectListen);
				this.server = srv;
				resolveListen();
			});
		});
	}

	async stop(): Promise<void> {
		if (this.unsubscribeSession) {
			this.unsubscribeSession();
			this.unsubscribeSession = undefined;
		}
		for (const client of this.sseClients) {
			client.end();
		}
		this.sseClients.clear();
		const srv = this.server;
		this.server = undefined;
		this.actualPort = undefined;
		if (!srv) return;
		await new Promise<void>((resolveClose) => srv.close(() => resolveClose()));
	}

	private broadcastEvent(event: AgentSessionEvent): void {
		this.broadcastRaw(event);
	}

	private broadcastRaw(event: unknown): void {
		if (this.sseClients.size === 0) return;
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const client of this.sseClients) {
			try {
				client.write(payload);
			} catch {
				this.sseClients.delete(client);
			}
		}
	}

	private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
		if (!this.password) return true;
		const auth = req.headers.authorization || "";
		if (auth.startsWith("Basic ")) {
			const decoded = Buffer.from(auth.slice(6), "base64").toString("utf-8");
			const sepIdx = decoded.indexOf(":");
			const pass = sepIdx >= 0 ? decoded.slice(sepIdx + 1) : decoded;
			if (pass === this.password) return true;
		}
		res.writeHead(401, { "WWW-Authenticate": 'Basic realm="pi-awesome"' });
		res.end("Authentication required");
		return false;
	}

	private sendJson(res: ServerResponse, status: number, body: unknown): void {
		const json = JSON.stringify(body);
		res.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		});
		res.end(json);
	}

	private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		const raw = Buffer.concat(chunks).toString("utf-8").trim();
		if (!raw) return {};
		return JSON.parse(raw) as Record<string, unknown>;
	}

	private safeResolveInCwd(relPath: string): string {
		const root = resolve(this.session.sessionManager.getCwd());
		const target = resolve(root, relPath || ".");
		const rel = relative(root, target);
		if (rel.startsWith("..") || rel.includes(":")) {
			throw new Error("Path outside workspace");
		}
		return target;
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.checkAuth(req, res)) return;

		const urlObj = new URL(req.url || "/", "http://127.0.0.1");
		const pathname = urlObj.pathname;

		if (req.method === "GET" && pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(renderWebUiHtml());
			return;
		}
		if (req.method === "GET" && pathname === "/icon.svg") {
			res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
			res.end(PI_WEB_ICON_SVG);
			return;
		}
		if (req.method === "GET" && pathname === "/manifest.webmanifest") {
			res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8" });
			res.end(PI_WEB_MANIFEST);
			return;
		}
		if (req.method === "GET" && pathname === "/sw.js") {
			res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
			res.end(PI_WEB_SW_JS);
			return;
		}

		if (req.method === "GET" && pathname === "/api/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(": connected\n\n");
			this.sseClients.add(res);
			req.on("close", () => this.sseClients.delete(res));
			return;
		}

		if (req.method === "GET" && pathname === "/api/state") {
			const cwd = this.session.sessionManager.getCwd();
			const currentFile = this.session.sessionManager.getSessionFile();
			const archived = this.loadArchivedSet();
			let sessions: Array<{
				path: string;
				cwd: string;
				name?: string;
				firstMessage?: string;
				messageCount: number;
				modified: string;
				active: boolean;
				archived: boolean;
			}> = [];
			try {
				const listed = await SessionManager.listAll();
				sessions = listed
					.filter((s) => s.messageCount > 0 || s.path === currentFile)
					.slice(0, 500)
					.map((s) => ({
						path: s.path,
						cwd: s.cwd || cwd,
						name: s.name,
						firstMessage: s.firstMessage ? extractCleanTitle(s.firstMessage) : undefined,
						messageCount: s.messageCount,
						modified: s.modified.toISOString(),
						active: s.path === currentFile,
						archived: archived.has(s.path),
					}));
			} catch {
				// Ignore listing failures
			}
			const rawModels =
				this.session.scopedModels.length > 0
					? this.session.scopedModels.map((s) => s.model)
					: this.session.modelRuntime.getAvailableSnapshot();
			const availableModels = rawModels.map((m) => ({
				provider: m.provider,
				id: m.id,
				name: m.name,
			}));
			const loadedSkills = this.session.resourceLoader.getSkills().skills.map((s) => ({
				name: s.name,
				description: s.description,
			}));
			const commands = [
				...BUILTIN_SLASH_COMMANDS.map((c) => ({
					name: c.name,
					description: c.description,
					argumentHint: c.argumentHint,
					source: "builtin",
				})),
				...loadedSkills.map((s) => ({
					name: `skill:${s.name}`,
					description: s.description,
					source: "skill",
				})),
			];
			this.sendJson(res, 200, {
				cwd,
				isStreaming: this.session.isStreaming,
				model: this.session.model ? { provider: this.session.model.provider, id: this.session.model.id } : null,
				models: availableModels,
				thinkingLevel: this.session.thinkingLevel,
				availableThinkingLevels: this.session.getAvailableThinkingLevels(),
				theme: this.session.settingsManager.getTheme(),
				themeAccent: this.session.settingsManager.getThemeAccent(),
				contextUsage: this.session.getContextUsage(),
				messages: this.session.messages,
				sessions,
				skills: loadedSkills,
				commands,
			});
			return;
		}

		if (req.method === "POST" && pathname === "/api/prompt") {
			const body = await this.readJsonBody(req);
			let text = typeof body.text === "string" ? body.text.trim() : "";
			const rawImages = Array.isArray(body.images) ? body.images : [];
			const rawFiles = Array.isArray(body.files) ? body.files : [];
			const projectFiles = Array.isArray(body.projectFiles) ? body.projectFiles : [];
			const skillNames = Array.isArray(body.skills) ? body.skills : [];

			if (text === "/new" && this.onNewSession) {
				if (this.session.isStreaming) await this.session.abort().catch(() => {});
				await this.onNewSession();
				this.rebindSession();
				this.onStateChange?.();
				this.sendJson(res, 200, { ok: true });
				return;
			}
			if (text.startsWith("/compact")) {
				const instr = text.slice("/compact".length).trim() || undefined;
				void this.session.compact(instr).then(() => {
					this.broadcastRaw({ type: "session_changed" });
					this.onStateChange?.();
				}).catch(() => {});
				this.sendJson(res, 200, { ok: true });
				return;
			}
			if (text.startsWith("/thinking ")) {
				const lvl = text.slice("/thinking ".length).trim() as ThinkingLevel;
				if (lvl) {
					this.session.setThinkingLevel(lvl, { persist: true });
					this.onStateChange?.();
					this.broadcastRaw({ type: "system_notice", text: `Уровень мышления: ${lvl}` });
				}
				this.sendJson(res, 200, { ok: true });
				return;
			}
			if (text.startsWith("/name ")) {
				const name = text.slice("/name ".length).trim();
				if (name) {
					this.session.setSessionName(name);
					this.onStateChange?.();
					this.broadcastRaw({ type: "system_notice", text: `Сессия переименована: ${name}` });
				}
				this.sendJson(res, 200, { ok: true });
				return;
			}
			if (text === "/settings" || text === "/theme" || text === "/providers" || text === "/sync" || text === "/memory") {
				const tab =
					text === "/providers"
						? "providers"
						: text === "/sync"
							? "sync"
							: text === "/memory"
								? "memory"
								: "general";
				this.broadcastRaw({ type: "open_settings", tab });
				this.sendJson(res, 200, { ok: true, openSettings: tab });
				return;
			}
			if (text.startsWith("/theme ")) {
				const themeName = text.slice("/theme ".length).trim();
				if (themeName) {
					this.session.settingsManager.setTheme(themeName);
					await this.session.settingsManager.flush();
					this.onStateChange?.();
					this.triggerBackgroundSync();
					this.broadcastRaw({ type: "session_changed" });
					this.broadcastRaw({ type: "system_notice", text: `Тема: ${themeName}` });
				}
				this.sendJson(res, 200, { ok: true });
				return;
			}
			if (text === "/sync push" || text === "/sync pull") {
				const mode = text.split(" ")[1];
				try {
					const agentDir = this.session.settingsManager.getAgentDir();
					if (mode === "push") {
						await this.session.settingsManager.flush();
						const r = await syncPush(agentDir);
						this.broadcastRaw({
							type: "system_notice",
							text: `Cloud sync: pushed (${r.skillFiles} skills, ${r.extensionFiles} plugins)`,
						});
					} else {
						const r = await syncPull(agentDir);
						if (r.hasData && !this.session.isStreaming && !this.session.isCompacting) {
							await this.session.settingsManager.reload();
							await this.session.modelRuntime.refresh();
							await this.session.reload();
							this.onStateChange?.();
							this.broadcastRaw({ type: "session_changed" });
						}
						this.broadcastRaw({
							type: "system_notice",
							text: r.hasData ? `Cloud sync: pulled (${r.skillFiles} skills, ${r.extensionFiles} plugins)` : "Cloud sync: нет данных",
						});
					}
				} catch (err) {
					this.broadcastRaw({
						type: "system_notice",
						text: err instanceof Error ? err.message : String(err),
					});
				}
				this.sendJson(res, 200, { ok: true });
				return;
			}
			if (text.startsWith("/model ")) {
				const q = text.slice("/model ".length).trim().toLowerCase();
				const found = this.session.modelRuntime
					.getAvailableSnapshot()
					.find((m) => m.id.toLowerCase() === q || `${m.provider}/${m.id}`.toLowerCase() === q || m.id.toLowerCase().includes(q));
				if (found) {
					await this.session.setModel(found, { persist: true });
					this.onStateChange?.();
					this.broadcastRaw({ type: "system_notice", text: `Модель переключена: ${found.provider}/${found.id}` });
				} else {
					this.broadcastRaw({ type: "system_notice", text: `Модель не найдена: ${q}` });
				}
				this.sendJson(res, 200, { ok: true });
				return;
			}
			if (text === "/status") {
				const usage = this.session.getContextUsage();
				const m = this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : "none";
				this.broadcastRaw({
					type: "system_notice",
					text: `Модель: ${m} · Мышление: ${this.session.thinkingLevel} · Контекст: ${Math.round(usage?.percent || 0)}%`,
				});
				this.sendJson(res, 200, { ok: true });
				return;
			}
			if (text === "/help") {
				this.broadcastRaw({
					type: "system_notice",
					text: "Команды: /new, /compact, /model <id>, /thinking <lvl>, /name <title>, /status",
				});
				this.sendJson(res, 200, { ok: true });
				return;
			}

			const prefixParts: string[] = [];
			for (const sk of skillNames) {
				if (typeof sk === "string" && sk.trim()) {
					prefixParts.push(`Use skill: ${sk.trim()}`);
				}
			}
			for (const pf of projectFiles) {
				if (typeof pf === "string" && pf.trim()) {
					prefixParts.push(`@${pf.trim()}`);
				}
			}
			for (const f of rawFiles) {
				if (f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string" && typeof (f as { content?: unknown }).content === "string") {
					const df = f as { name: string; content: string };
					prefixParts.push(`Attached file \`${df.name}\`:\n\`\`\`\n${df.content.slice(0, 40_000)}\n\`\`\``);
				}
			}
			if (prefixParts.length > 0) {
				text = `${prefixParts.join("\n\n")}${text ? `\n\n${text}` : ""}`;
			}

			const images: ImageContent[] = rawImages
				.filter((im): im is { data: string; mimeType: string } => Boolean(im && typeof im === "object" && typeof (im as { data?: unknown }).data === "string"))
				.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType || "image/png" }));

			if (!text && images.length === 0) {
				this.sendJson(res, 400, { error: "Empty prompt" });
				return;
			}
			if (this.session.isStreaming) {
				void this.session.steer(text, images.length > 0 ? images : undefined).catch(() => {});
			} else {
				void this.session.prompt(text || "Describe attached image(s)", images.length > 0 ? { images } : undefined).catch(() => {});
			}
			this.sendJson(res, 200, { ok: true });
			return;
		}

		if (req.method === "POST" && pathname === "/api/voice") {
			const body = await this.readJsonBody(req);
			const audioBase64 = typeof body.audioBase64 === "string" ? body.audioBase64 : "";
			const mimeType = typeof body.mimeType === "string" ? body.mimeType : "audio/webm";
			if (!audioBase64) {
				this.sendJson(res, 400, { error: "Missing audio" });
				return;
			}
			const groqKey =
				process.env.GROQ_API_KEY ||
				this.session.settingsManager.getVoiceSettings?.()?.groqApiKey ||
				"";
			if (!groqKey) {
				this.sendJson(res, 200, { fallback: true, error: "Groq API key not configured" });
				return;
			}
			try {
				const buf = Buffer.from(audioBase64, "base64");
				const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
				const form = new FormData();
				form.append("file", new Blob([buf], { type: mimeType }), `voice.${ext}`);
				form.append("model", "whisper-large-v3");
				form.append("language", "ru");
				const groqRes = await scopedFetch("voice", "https://api.groq.com/openai/v1/audio/transcriptions", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${groqKey}`,
						"User-Agent": "pi-awesome/1.5.2",
						Accept: "application/json",
					},
					body: form,
				});
				if (!groqRes.ok) {
					this.sendJson(res, 200, { fallback: true, error: `Groq HTTP ${groqRes.status}` });
					return;
				}
				const groqJson = (await groqRes.json()) as { text?: string };
				this.sendJson(res, 200, { text: groqJson.text || "" });
			} catch (err) {
				this.sendJson(res, 200, { fallback: true, error: err instanceof Error ? err.message : String(err) });
			}
			return;
		}

		if (req.method === "POST" && pathname === "/api/abort") {
			await this.session.abort();
			this.sendJson(res, 200, { ok: true });
			return;
		}

		if (req.method === "POST" && pathname === "/api/new-session") {
			if (!this.onNewSession) {
				this.sendJson(res, 501, { error: "New session is not supported in this host" });
				return;
			}
			const body = (await this.readJsonBody(req).catch(() => ({}))) as Record<string, unknown>;
			const targetCwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : undefined;
			if (this.session.isStreaming) {
				await this.session.abort().catch(() => {});
			}
			if (targetCwd && targetCwd !== this.session.sessionManager.getCwd() && this.onSwitchSession) {
				const sm = SessionManager.create(targetCwd);
				const newFile = sm.getSessionFile();
				if (newFile) {
					await this.onSwitchSession(newFile);
				} else {
					await this.onNewSession();
				}
			} else {
				await this.onNewSession();
			}
			this.rebindSession();
			this.onStateChange?.();
			this.sendJson(res, 200, { ok: true });
			return;
		}

		if (req.method === "POST" && pathname === "/api/switch-session") {
			if (!this.onSwitchSession) {
				this.sendJson(res, 501, { error: "Session switching is not supported in this host" });
				return;
			}
			const body = await this.readJsonBody(req);
			const path = typeof body.path === "string" ? body.path : "";
			if (!path) {
				this.sendJson(res, 400, { error: "Missing session path" });
				return;
			}
			if (this.session.isStreaming) {
				await this.session.abort().catch(() => {});
			}
			await this.onSwitchSession(path);
			this.rebindSession();
			this.onStateChange?.();
			this.sendJson(res, 200, { ok: true });
			return;
		}

		if (req.method === "POST" && pathname === "/api/archive-session") {
			const body = await this.readJsonBody(req);
			const path = typeof body.path === "string" ? body.path : "";
			const archive = body.archived !== false;
			if (!path) {
				this.sendJson(res, 400, { error: "Missing session path" });
				return;
			}
			const set = this.loadArchivedSet();
			if (archive) set.add(path);
			else set.delete(path);
			this.saveArchivedSet(set);
			this.sendJson(res, 200, { ok: true });
			return;
		}

		if (req.method === "POST" && pathname === "/api/model") {
			const body = await this.readJsonBody(req);
			const provider = typeof body.provider === "string" ? body.provider : "";
			const id = typeof body.id === "string" ? body.id : "";
			const target =
				this.session.scopedModels
					.map((s) => s.model)
					.find((m) => m.provider === provider && m.id === id) ??
				this.session.modelRuntime
					.getAvailableSnapshot()
					.find((m) => m.provider === provider && m.id === id);
			if (!target) {
				this.sendJson(res, 404, { error: "Model not found" });
				return;
			}
			try {
				await this.session.setModel(target, { persist: true });
			} catch (err) {
				this.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
				return;
			}
			this.onStateChange?.();
			this.triggerBackgroundSync();
			this.broadcastRaw({ type: "session_changed" });
			this.sendJson(res, 200, { ok: true, model: { provider: target.provider, id: target.id } });
			return;
		}

		if (req.method === "POST" && pathname === "/api/thinking") {
			const body = await this.readJsonBody(req);
			const level = typeof body.level === "string" ? (body.level as ThinkingLevel) : undefined;
			if (!level) {
				this.sendJson(res, 400, { error: "Missing level" });
				return;
			}
			this.session.setThinkingLevel(level, { persist: true });
			this.onStateChange?.();
			this.triggerBackgroundSync();
			this.sendJson(res, 200, { ok: true });
			return;
		}

		if (req.method === "GET" && pathname === "/api/settings") {
			const sm = this.session.settingsManager;
			const agentDir = sm.getAgentDir();
			const cwd = this.session.sessionManager.getCwd();
			const modelsPath = join(agentDir, "models.json");
			const syncState = readSyncState(agentDir);
			const voice = sm.getVoiceSettings();
			const memSettings = sm.getMemorySettings();
			const memSnap = readMemorySnapshot({ cwd, agentDir });
			const providers = listCustomProviders(modelsPath).map((p) => ({
				id: p.id,
				baseUrl: p.baseUrl,
				api: p.api,
				modelIds: p.models.map((m) => m.id),
				hasApiKey: Boolean(p.apiKey),
			}));
			this.sendJson(res, 200, {
				theme: sm.getTheme() || "graphite",
				availableThemes: getAvailableThemes(),
				themeAccent: sm.getThemeAccent(),
				availableAccents: ["default", "slate", "sage", "amber", "coral", "cyan", "violet", "rose", "mono"],
				tuiStyle: sm.getTuiStyle(),
				availableTuiStyles: ["native", "rounded", "compact", "opentui", "sageveil"],
				codemodeEnabled: sm.getCodemodeEnabled(),
				hideThinkingBlock: sm.getHideThinkingBlock(),
				quietStartup: sm.getQuietStartup(),
				autoUpdate: sm.getAutoUpdate(),
				voice: {
					enabled: voice.enabled !== false,
					holdSpaceToTalk: voice.holdSpaceToTalk !== false,
				},
				proxy: sm.getProxySettings(),
				memory: {
					enabled: memSettings.reviewEnabled !== false,
					nudgeInterval: memSettings.nudgeInterval ?? 10,
					skillReviewMinToolCalls: memSettings.skillReviewMinToolCalls ?? 3,
					limits: MEMORY_CHAR_LIMITS,
					snapshot: memSnap,
				},
				sync: syncState
					? {
							signedIn: true,
							user: syncState.user,
							serverUrl: syncState.serverUrl,
							autoSync: syncState.autoSync,
							lastSyncUpdated: syncState.lastSyncUpdated,
						}
					: {
							signedIn: false,
							serverUrl: DEFAULT_CLOUD_SYNC_URL,
							autoSync: true,
							lastSyncUpdated: 0,
						},
				providers,
			});
			return;
		}

		if (req.method === "POST" && pathname === "/api/settings") {
			const body = await this.readJsonBody(req);
			const sm = this.session.settingsManager;
			if (typeof body.theme === "string" && body.theme.trim()) {
				sm.setTheme(body.theme.trim());
			}
			if (typeof body.themeAccent === "string") {
				sm.setThemeAccent(body.themeAccent as any);
			}
			if (typeof body.tuiStyle === "string") {
				sm.setTuiStyle(body.tuiStyle as any);
			}
			if (typeof body.hideThinkingBlock === "boolean") {
				sm.setHideThinkingBlock(body.hideThinkingBlock);
			}
			if (typeof body.quietStartup === "boolean") {
				sm.setQuietStartup(body.quietStartup);
			}
			if (typeof body.autoUpdate === "string") {
				sm.setAutoUpdate(body.autoUpdate as any);
			}
			if (body.voice && typeof body.voice === "object") {
				sm.setVoiceSettings(body.voice as any);
			}
			if (body.proxy && typeof body.proxy === "object") {
				sm.setProxySettings(body.proxy as any);
				configureHttpDispatcher(sm.getHttpIdleTimeoutMs(), sm.getProxySettings());
			}
			if (body.memory && typeof body.memory === "object") {
				sm.setMemorySettings(body.memory as any);
			}
			if (typeof body.codemodeEnabled === "boolean") {
				sm.setCodemodeEnabled(body.codemodeEnabled);
				const active = this.session.getActiveToolNames();
				const next = body.codemodeEnabled
					? active.includes("codemode")
						? active
						: [...active, "codemode"]
					: active.filter((name) => name !== "codemode");
				this.session.setActiveToolsByName(next);
			}
			await sm.flush();
			this.onStateChange?.();
			this.triggerBackgroundSync();
			this.broadcastRaw({ type: "session_changed" });
			this.sendJson(res, 200, { ok: true });
			return;
		}

		if (req.method === "POST" && pathname === "/api/proxy/test") {
			const body = await this.readJsonBody(req);
			const url = typeof body.url === "string" ? body.url : (this.session.settingsManager.getProxySettings().url ?? "");
			const result = await testProxyConnection(url);
			this.sendJson(res, 200, result);
			return;
		}

		if (req.method === "POST" && pathname === "/api/sync") {
			const body = await this.readJsonBody(req);
			const action = typeof body.action === "string" ? body.action : "";
			const agentDir = this.session.settingsManager.getAgentDir();
			try {
				if (action === "login" || action === "register") {
					const serverUrl = typeof body.serverUrl === "string" ? body.serverUrl : DEFAULT_CLOUD_SYNC_URL;
					const user = typeof body.user === "string" ? body.user : "";
					const pass = typeof body.pass === "string" ? body.pass : "";
					if (!user.trim() || !pass) {
						this.sendJson(res, 400, { error: "Введите логин и пароль" });
						return;
					}
					await syncAuthenticate(action, serverUrl, user, pass, agentDir);
					if (action === "login") {
						const pull = await syncPull(agentDir);
						if (!pull.hasData) {
							await this.session.settingsManager.flush();
							await syncPush(agentDir);
						} else if (!this.session.isStreaming && !this.session.isCompacting) {
							await this.session.settingsManager.reload();
							await this.session.modelRuntime.refresh();
							await this.session.reload();
						}
					} else {
						await this.session.settingsManager.flush();
						await syncPush(agentDir);
					}
					this.onStateChange?.();
					this.broadcastRaw({ type: "session_changed" });
					this.sendJson(res, 200, { ok: true });
					return;
				}
				if (action === "logout") {
					await syncLogout(agentDir);
					this.sendJson(res, 200, { ok: true });
					return;
				}
				if (action === "push") {
					await this.session.settingsManager.flush();
					const r = await syncPush(agentDir);
					this.sendJson(res, 200, { ok: true, ...r });
					return;
				}
				if (action === "pull") {
					const r = await syncPull(agentDir);
					if (r.hasData && !this.session.isStreaming && !this.session.isCompacting) {
						await this.session.settingsManager.reload();
						await this.session.modelRuntime.refresh();
						await this.session.reload();
						this.onStateChange?.();
						this.broadcastRaw({ type: "session_changed" });
					}
					this.sendJson(res, 200, { ok: true, ...r });
					return;
				}
				if (action === "toggleAutoSync") {
					const state = readSyncState(agentDir);
					if (!state) {
						this.sendJson(res, 400, { error: "Не выполнен вход в Cloud Sync" });
						return;
					}
					const nextAuto = typeof body.autoSync === "boolean" ? body.autoSync : !state.autoSync;
					writeSyncState({ ...state, autoSync: nextAuto }, agentDir);
					this.sendJson(res, 200, { ok: true, autoSync: nextAuto });
					return;
				}
				this.sendJson(res, 400, { error: "Unknown sync action" });
			} catch (err) {
				this.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
			}
			return;
		}

		if (req.method === "POST" && pathname === "/api/providers") {
			const body = await this.readJsonBody(req);
			const action = typeof body.action === "string" ? body.action : "";
			const agentDir = this.session.settingsManager.getAgentDir();
			const modelsPath = join(agentDir, "models.json");
			try {
				if (action === "fetchModels") {
					const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
					const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
					const api = typeof body.api === "string" ? body.api : "openai-completions";
					if (!baseUrl) {
						this.sendJson(res, 400, { error: "Укажите Base URL" });
						return;
					}
					const models = await fetchProviderModelsCatalog(baseUrl, apiKey, api as any);
					this.sendJson(res, 200, { ok: true, models });
					return;
				}
				if (action === "save") {
					const id = typeof body.id === "string" ? body.id.trim() : "";
					const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
					const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
					const api = typeof body.api === "string" ? body.api : "openai-completions";
					const rawModels = Array.isArray(body.models) ? body.models : [];
					if (!id || !baseUrl || rawModels.length === 0) {
						this.sendJson(res, 400, { error: "Укажите имя провайдера, URL и хотя бы одну модель" });
						return;
					}
					const models = rawModels.map((m: any) =>
						typeof m === "string" ? inferModelMetadata({ id: m }) : inferModelMetadata(m),
					);
					upsertCustomProvider({ id, baseUrl, apiKey, api: api as any, models }, modelsPath);
					await this.session.modelRuntime.refresh();
					if (!this.session.model && models[0]) {
						const first = this.session.modelRuntime.getModel(id, models[0].id);
						if (first) await this.session.setModel(first, { persist: true });
					}
					await this.session.settingsManager.flush();
					this.onStateChange?.();
					this.triggerBackgroundSync();
					this.broadcastRaw({ type: "session_changed" });
					this.sendJson(res, 200, { ok: true });
					return;
				}
				if (action === "delete") {
					const id = typeof body.id === "string" ? body.id.trim() : "";
					if (!id) {
						this.sendJson(res, 400, { error: "Missing provider id" });
						return;
					}
					deleteCustomProvider(id, modelsPath);
					await this.session.modelRuntime.refresh();
					this.onStateChange?.();
					this.triggerBackgroundSync();
					this.broadcastRaw({ type: "session_changed" });
					this.sendJson(res, 200, { ok: true });
					return;
				}
				this.sendJson(res, 400, { error: "Unknown providers action" });
			} catch (err) {
				this.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
			}
			return;
		}

		if (req.method === "POST" && pathname === "/api/memory") {
			const body = await this.readJsonBody(req);
			const action = typeof body.action === "string" ? body.action : "";
			const agentDir = this.session.settingsManager.getAgentDir();
			const cwd = this.session.sessionManager.getCwd();
			try {
				if (action === "clear") {
					const target = body.target;
					if (target !== "project" && target !== "memory" && target !== "user") {
						this.sendJson(res, 400, { error: "Invalid memory target" });
						return;
					}
					const resClear = clearMemoryTarget(target, { cwd, agentDir });
					this.triggerBackgroundSync();
					this.sendJson(res, 200, { ok: true, ...resClear });
					return;
				}
				if (action === "review") {
					const focus = typeof body.focus === "string" && body.focus.trim() ? body.focus.trim() : undefined;
					const resReview = await this.session.runMemoryReview(focus);
					if (resReview.saved) this.triggerBackgroundSync();
					this.sendJson(res, 200, { ok: true, ...resReview });
					return;
				}
				this.sendJson(res, 400, { error: "Unknown memory action" });
			} catch (err) {
				this.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
			}
			return;
		}

		if (req.method === "GET" && pathname === "/api/files") {
			const dirParam = urlObj.searchParams.get("dir") || ".";
			const root = resolve(this.session.sessionManager.getCwd());
			const abs = this.safeResolveInCwd(dirParam);
			const entries = readdirSync(abs, { withFileTypes: true })
				.filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
				.slice(0, 200)
				.map((e) => ({
					name: e.name,
					path: relative(root, join(abs, e.name)) || ".",
					isDir: e.isDirectory(),
				}));
			this.sendJson(res, 200, { dir: relative(root, abs) || ".", entries });
			return;
		}

		if (req.method === "GET" && pathname === "/api/file") {
			const pathParam = urlObj.searchParams.get("path") || "";
			const abs = this.safeResolveInCwd(pathParam);
			const st = statSync(abs);
			if (st.size > 200_000) {
				this.sendJson(res, 200, { content: readFileSync(abs, "utf-8").slice(0, 200_000) + "\n\n... (truncated)" });
				return;
			}
			this.sendJson(res, 200, { content: readFileSync(abs, "utf-8") });
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	}
}
