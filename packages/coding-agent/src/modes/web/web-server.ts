import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import { SessionManager } from "../../core/session-manager.ts";
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
			if (
				event.type === "agent_start" ||
				event.type === "agent_end" ||
				event.type === "agent_settled" ||
				event.type === "message_start" ||
				event.type === "message_update" ||
				event.type === "message_end" ||
				event.type === "tool_execution_start" ||
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
			let sessions: Array<{ path: string; name?: string; firstMessage?: string; messageCount: number; modified: string; active: boolean }> = [];
			try {
				const listed = await SessionManager.list(cwd);
				sessions = listed
					.filter((s) => s.messageCount > 0 || s.path === currentFile)
					.slice(0, 30)
					.map((s) => ({
						path: s.path,
						name: s.name,
						firstMessage: s.firstMessage,
						messageCount: s.messageCount,
						modified: s.modified.toISOString(),
						active: s.path === currentFile,
					}));
			} catch {
				// Ignore listing failures
			}
			const availableModels = this.session.modelRuntime.getAvailableSnapshot().map((m) => ({
				provider: m.provider,
				id: m.id,
				name: m.name,
			}));
			this.sendJson(res, 200, {
				cwd,
				isStreaming: this.session.isStreaming,
				model: this.session.model ? { provider: this.session.model.provider, id: this.session.model.id } : null,
				models: availableModels,
				thinkingLevel: this.session.thinkingLevel,
				availableThinkingLevels: this.session.getAvailableThinkingLevels(),
				contextUsage: this.session.getContextUsage(),
				messages: this.session.messages,
				sessions,
			});
			return;
		}

		if (req.method === "POST" && pathname === "/api/prompt") {
			const body = await this.readJsonBody(req);
			const text = typeof body.text === "string" ? body.text.trim() : "";
			if (!text) {
				this.sendJson(res, 400, { error: "Empty prompt" });
				return;
			}
			if (this.session.isStreaming) {
				void this.session.steer(text).catch(() => {});
			} else {
				void this.session.prompt(text).catch(() => {});
			}
			this.sendJson(res, 200, { ok: true });
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
			if (this.session.isStreaming) {
				await this.session.abort().catch(() => {});
			}
			await this.onNewSession();
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

		if (req.method === "POST" && pathname === "/api/model") {
			const body = await this.readJsonBody(req);
			const provider = typeof body.provider === "string" ? body.provider : "";
			const id = typeof body.id === "string" ? body.id : "";
			const target = this.session.modelRuntime
				.getAvailableSnapshot()
				.find((m) => m.provider === provider && m.id === id);
			if (!target) {
				this.sendJson(res, 404, { error: "Model not found" });
				return;
			}
			await this.session.setModel(target, { persist: true });
			this.onStateChange?.();
			this.sendJson(res, 200, { ok: true });
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
			this.sendJson(res, 200, { ok: true });
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
