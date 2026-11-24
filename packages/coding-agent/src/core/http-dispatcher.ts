import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import * as undici from "undici";
import type { ProxySettings } from "./settings-schema.ts";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

export type ProxyScope = "ai" | "voice" | "sync" | "web" | "other";

const proxyScopeStorage = new AsyncLocalStorage<ProxyScope>();
const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
let currentTimeoutMs = DEFAULT_HTTP_IDLE_TIMEOUT_MS;
let currentProxySettings: ProxySettings | undefined;

export function runWithProxyScope<T>(scope: ProxyScope, fn: () => T): T {
	return proxyScopeStorage.run(scope, fn);
}

export function scopedFetch(
	scope: ProxyScope,
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	return runWithProxyScope(scope, () => {
		const isDeliberatelyOverridden =
			globalThis.fetch !== originalGlobalFetch && globalThis.fetch !== installedGlobalFetch;
		if (isDeliberatelyOverridden) {
			return globalThis.fetch(input, init);
		}
		return undici.fetch(input as undici.RequestInfo, {
			...(init as undici.RequestInit),
			dispatcher: undici.getGlobalDispatcher(),
		}) as unknown as Promise<Response>;
	});
}

export function getCurrentProxyScope(): ProxyScope {
	return proxyScopeStorage.getStore() ?? "other";
}

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function normalizeProxyUrl(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
	try {
		const parsed = new URL(withScheme);
		if (!parsed.hostname) return undefined;
		const proto = parsed.protocol.toLowerCase();
		if (proto !== "http:" && proto !== "https:" && proto !== "socks5:" && proto !== "socks5h:") {
			return undefined;
		}
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

export function formatProxyUrlForDisplay(raw: string | undefined): string {
	const normalized = normalizeProxyUrl(raw);
	if (!normalized) return raw?.trim() || "not set";
	try {
		const parsed = new URL(normalized);
		if (parsed.password) {
			parsed.password = "***";
		}
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return normalized;
	}
}

export function formatProxySummary(proxy: ProxySettings | undefined): string {
	if (!proxy?.enabled || !normalizeProxyUrl(proxy.url)) {
		return "off";
	}
	const scopes: string[] = [];
	if (proxy.forAi !== false) scopes.push("AI");
	if (proxy.forVoice !== false) scopes.push("Voice");
	if (proxy.forSync === true) scopes.push("Sync");
	if (proxy.forWeb === true) scopes.push("Web");
	if (scopes.length === 0) return "on (no scopes)";
	if (scopes.length === 4) return "on (all)";
	return `on (${scopes.join(", ")})`;
}

export function shouldUseProxyForScope(scope: ProxyScope, proxy: ProxySettings | undefined): boolean {
	if (!proxy?.enabled || !normalizeProxyUrl(proxy.url)) {
		return false;
	}
	switch (scope) {
		case "ai":
			return proxy.forAi !== false;
		case "voice":
			return proxy.forVoice !== false;
		case "sync":
			return proxy.forSync === true;
		case "web":
			return proxy.forWeb === true;
		case "other":
		default:
			return false;
	}
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

export function createProxyDispatcher(
	proxyUrl: string,
	timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
): undici.Dispatcher | undefined {
	const normalized = normalizeProxyUrl(proxyUrl);
	if (!normalized) return undefined;

	const connectOptions = {
		autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
		keepAlive: true,
		keepAliveInitialDelay: 15_000,
	};

	if (normalized.startsWith("socks5://") || normalized.startsWith("socks5h://")) {
		const Socks5Agent = (undici as unknown as {
			Socks5ProxyAgent?: new (uri: string, opts?: object) => undici.Dispatcher;
		}).Socks5ProxyAgent;
		if (Socks5Agent) {
			return withUndiciErrorListener(
				new Socks5Agent(normalized, {
					bodyTimeout: timeoutMs,
					headersTimeout: timeoutMs,
					connect: connectOptions,
				}),
			);
		}
		return undefined;
	}

	return withUndiciErrorListener(
		new undici.ProxyAgent({
			uri: normalized,
			allowH2: false,
			proxyTunnel: true,
			bodyTimeout: timeoutMs,
			headersTimeout: timeoutMs,
			connect: connectOptions,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
}

class ScopedRoutingDispatcher extends undici.Dispatcher {
	private readonly directDispatcher: undici.Dispatcher;
	private readonly proxyDispatcher: undici.Dispatcher | undefined;
	private readonly proxySettings: ProxySettings | undefined;

	constructor(
		directDispatcher: undici.Dispatcher,
		proxyDispatcher: undici.Dispatcher | undefined,
		proxySettings: ProxySettings | undefined,
	) {
		super();
		this.directDispatcher = directDispatcher;
		this.proxyDispatcher = proxyDispatcher;
		this.proxySettings = proxySettings;
	}

	dispatch(options: undici.Dispatcher.DispatchOptions, handler: undici.Dispatcher.DispatchHandler): boolean {
		const scope = getCurrentProxyScope();
		const target =
			this.proxyDispatcher && shouldUseProxyForScope(scope, this.proxySettings)
				? this.proxyDispatcher
				: this.directDispatcher;
		return target.dispatch(options, handler);
	}

	close(): Promise<void>;
	close(callback: () => void): void;
	close(callback?: () => void): Promise<void> | void {
		const done = Promise.allSettled([this.directDispatcher.close(), this.proxyDispatcher?.close()]).then(() => {});
		if (callback) {
			done.then(callback, callback);
			return;
		}
		return done;
	}

	destroy(): Promise<void>;
	destroy(err: Error | null): Promise<void>;
	destroy(callback: () => void): void;
	destroy(err: Error | null, callback: () => void): void;
	destroy(errOrCallback?: Error | null | (() => void), maybeCallback?: () => void): Promise<void> | void {
		const err = typeof errOrCallback === "function" ? null : (errOrCallback ?? null);
		const callback = typeof errOrCallback === "function" ? errOrCallback : maybeCallback;
		const done = Promise.allSettled([
			this.directDispatcher.destroy(err),
			this.proxyDispatcher?.destroy(err),
		]).then(() => {});
		if (callback) {
			done.then(callback, callback);
			return;
		}
		return done;
	}
}

export async function testProxyConnection(
	proxyUrl: string,
	targetUrl = "https://api.groq.com/openai/v1/models",
	timeoutMs = 8_000,
): Promise<{ ok: boolean; latencyMs: number; status?: number; error?: string }> {
	const dispatcher = createProxyDispatcher(proxyUrl, timeoutMs);
	if (!dispatcher) {
		return { ok: false, latencyMs: 0, error: "Invalid proxy URL (use http://, https://, socks5://, or socks5h://)" };
	}
	const startedAt = Date.now();
	try {
		const res = await undici.fetch(targetUrl, {
			method: "GET",
			headers: {
				"User-Agent": "pi-awesome/1.5.2",
				Accept: "application/json",
			},
			dispatcher,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.status === 403 || res.status === 407) {
			return {
				ok: false,
				latencyMs: Date.now() - startedAt,
				status: res.status,
				error: res.status === 407 ? "HTTP 407 Proxy Authentication Required" : "HTTP 403 Forbidden (target/geo blocked)",
			};
		}
		return { ok: true, latencyMs: Date.now() - startedAt, status: res.status };
	} catch (error) {
		return {
			ok: false,
			latencyMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		await dispatcher.close().catch(() => {});
	}
}

export function configureHttpDispatcher(
	timeoutMs: number = currentTimeoutMs,
	proxySettings?: ProxySettings,
): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	currentTimeoutMs = normalizedTimeoutMs;
	if (proxySettings !== undefined) {
		currentProxySettings = { ...proxySettings };
	}

	const directDispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
			proxyTunnel: true,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
				keepAlive: true,
				keepAliveInitialDelay: 15_000,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);

	const proxyUrl = currentProxySettings?.enabled ? normalizeProxyUrl(currentProxySettings.url) : undefined;
	const proxyDispatcher = proxyUrl ? createProxyDispatcher(proxyUrl, normalizedTimeoutMs) : undefined;
	const dispatcher = proxyDispatcher
		? withUndiciErrorListener(new ScopedRoutingDispatcher(directDispatcher, proxyDispatcher, currentProxySettings))
		: directDispatcher;

	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
