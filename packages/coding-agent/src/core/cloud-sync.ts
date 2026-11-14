import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../config.ts";
import { stripBom } from "../utils/text.ts";

export const DEFAULT_CLOUD_SYNC_URL = "https://grzxk.ru/pi-sync";
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const SKIP_DIR_NAMES = new Set([".git", "node_modules", "__pycache__", ".venv", "dist"]);

export interface CloudSyncState {
	serverUrl: string;
	user: string;
	token: string;
	lastSyncUpdated: number;
	autoSync: boolean;
}

export interface SyncedFileEntry {
	encoding: "utf8" | "base64";
	content: string;
}

export interface CloudSyncBundle {
	version: 1;
	syncedAt: number;
	settings?: Record<string, unknown>;
	models?: Record<string, unknown>;
	auth?: Record<string, unknown>;
	keybindings?: Record<string, unknown>;
	skills?: Record<string, SyncedFileEntry>;
	prompts?: Record<string, SyncedFileEntry>;
	extensions?: Record<string, SyncedFileEntry>;
	themes?: Record<string, SyncedFileEntry>;
	tools?: Record<string, SyncedFileEntry>;
	plugins?: Record<string, SyncedFileEntry>;
	gitPackages?: Record<string, SyncedFileEntry>;
}

export function getSyncStatePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "sync.json");
}

export function normalizeSyncUrl(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, "");
	return trimmed || DEFAULT_CLOUD_SYNC_URL;
}

export function readSyncState(agentDir: string = getAgentDir()): CloudSyncState | undefined {
	const file = getSyncStatePath(agentDir);
	if (!existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(stripBom(readFileSync(file, "utf8"))) as Partial<CloudSyncState>;
		if (!parsed.user || !parsed.token) return undefined;
		return {
			serverUrl: normalizeSyncUrl(parsed.serverUrl ?? DEFAULT_CLOUD_SYNC_URL),
			user: parsed.user,
			token: parsed.token,
			lastSyncUpdated: typeof parsed.lastSyncUpdated === "number" ? parsed.lastSyncUpdated : 0,
			autoSync: parsed.autoSync !== false,
		};
	} catch {
		return undefined;
	}
}

export function writeSyncState(state: CloudSyncState, agentDir: string = getAgentDir()): void {
	const file = getSyncStatePath(agentDir);
	const dir = dirname(file);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function clearSyncState(agentDir: string = getAgentDir()): void {
	const file = getSyncStatePath(agentDir);
	try {
		if (existsSync(file)) unlinkSync(file);
	} catch {
		// ignore
	}
}

function readJsonOptional(filePath: string): Record<string, unknown> | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		const parsed = JSON.parse(stripBom(readFileSync(filePath, "utf8")));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function writeJsonSafe(filePath: string, data: Record<string, unknown>, mode = 0o644): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode });
}

function isProbablyUtf8Text(buf: Buffer): boolean {
	for (let i = 0; i < Math.min(buf.length, 4096); i++) {
		if (buf[i] === 0) return false;
	}
	return true;
}

function collectDirectoryFiles(rootDir: string): Record<string, SyncedFileEntry> | undefined {
	if (!existsSync(rootDir)) return undefined;
	const result: Record<string, SyncedFileEntry> = {};

	const walk = (dir: string) => {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (SKIP_DIR_NAMES.has(entry.name)) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile()) {
				try {
					const st = statSync(full);
					if (st.size > MAX_SKILL_FILE_BYTES) continue;
					const buf = readFileSync(full);
					const relPosix = relative(rootDir, full).split(sep).join("/");
					if (!relPosix || relPosix.startsWith("..")) continue;
					if (isProbablyUtf8Text(buf)) {
						result[relPosix] = { encoding: "utf8", content: buf.toString("utf8") };
					} else {
						result[relPosix] = { encoding: "base64", content: buf.toString("base64") };
					}
				} catch {
					// skip unreadable file
				}
			}
		}
	};

	walk(rootDir);
	return Object.keys(result).length > 0 ? result : {};
}

function applyDirectoryFiles(rootDir: string, files: Record<string, SyncedFileEntry> | undefined): number {
	if (!files || typeof files !== "object") return 0;
	const resolvedRoot = resolve(rootDir);
	if (!existsSync(resolvedRoot)) mkdirSync(resolvedRoot, { recursive: true });
	let count = 0;
	for (const [relPath, entry] of Object.entries(files)) {
		if (!entry || typeof entry.content !== "string") continue;
		const normalizedRel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
		if (!normalizedRel || normalizedRel.includes("..")) continue;
		const target = resolve(resolvedRoot, ...normalizedRel.split("/"));
		const relCheck = relative(resolvedRoot, target);
		if (!relCheck || relCheck.startsWith("..") || isAbsolute(relCheck)) continue;

		const parent = dirname(target);
		if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
		if (entry.encoding === "base64") {
			writeFileSync(target, Buffer.from(entry.content, "base64"));
		} else {
			writeFileSync(target, entry.content, "utf8");
		}
		count++;
	}
	return count;
}

export function collectLocalSyncBundle(agentDir: string = getAgentDir()): CloudSyncBundle {
	return {
		version: 1,
		syncedAt: Date.now(),
		settings: readJsonOptional(join(agentDir, "settings.json")),
		models: readJsonOptional(join(agentDir, "models.json")),
		auth: readJsonOptional(join(agentDir, "auth.json")),
		keybindings: readJsonOptional(join(agentDir, "keybindings.json")),
		skills: collectDirectoryFiles(join(agentDir, "skills")),
		prompts: collectDirectoryFiles(join(agentDir, "prompts")),
		extensions: collectDirectoryFiles(join(agentDir, "extensions")),
		themes: collectDirectoryFiles(join(agentDir, "themes")),
		tools: collectDirectoryFiles(join(agentDir, "tools")),
		plugins: collectDirectoryFiles(join(agentDir, "plugins")),
		gitPackages: collectDirectoryFiles(join(agentDir, "git")),
	};
}

export function applyRemoteSyncBundle(
	bundle: CloudSyncBundle,
	agentDir: string = getAgentDir(),
): { skillFiles: number; promptFiles: number; extensionFiles: number } {
	if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
	if (bundle.settings) writeJsonSafe(join(agentDir, "settings.json"), bundle.settings, 0o644);
	if (bundle.models) writeJsonSafe(join(agentDir, "models.json"), bundle.models, 0o644);
	if (bundle.auth) writeJsonSafe(join(agentDir, "auth.json"), bundle.auth, 0o600);
	if (bundle.keybindings) writeJsonSafe(join(agentDir, "keybindings.json"), bundle.keybindings, 0o644);
	const skillFiles = applyDirectoryFiles(join(agentDir, "skills"), bundle.skills);
	const promptFiles = applyDirectoryFiles(join(agentDir, "prompts"), bundle.prompts);
	const extensionFiles =
		applyDirectoryFiles(join(agentDir, "extensions"), bundle.extensions) +
		applyDirectoryFiles(join(agentDir, "themes"), bundle.themes) +
		applyDirectoryFiles(join(agentDir, "tools"), bundle.tools) +
		applyDirectoryFiles(join(agentDir, "plugins"), bundle.plugins) +
		applyDirectoryFiles(join(agentDir, "git"), bundle.gitPackages);
	return { skillFiles, promptFiles, extensionFiles };
}

async function syncRequest(url: string, init: RequestInit): Promise<any> {
	const res = await fetch(url, {
		...init,
		signal: AbortSignal.timeout(20_000),
	});
	const text = await res.text();
	let json: any = {};
	try {
		json = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`Invalid sync server response (HTTP ${res.status})`);
	}
	if (!res.ok) {
		throw new Error(json?.error || `HTTP ${res.status} ${res.statusText}`);
	}
	return json;
}

export async function syncAuthenticate(
	mode: "login" | "register",
	serverUrl: string,
	user: string,
	pass: string,
	agentDir: string = getAgentDir(),
): Promise<CloudSyncState> {
	const base = normalizeSyncUrl(serverUrl);
	const data = await syncRequest(`${base}/${mode}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ user: user.trim(), pass }),
	});
	const prev = readSyncState(agentDir);
	const state: CloudSyncState = {
		serverUrl: base,
		user: String(data.user || user.trim()),
		token: String(data.token),
		lastSyncUpdated: prev?.user === user.trim() ? prev.lastSyncUpdated : 0,
		autoSync: prev?.autoSync ?? true,
	};
	writeSyncState(state, agentDir);
	return state;
}

export async function syncLogout(agentDir: string = getAgentDir()): Promise<void> {
	const state = readSyncState(agentDir);
	if (state) {
		try {
			await syncRequest(`${state.serverUrl}/logout`, {
				method: "POST",
				headers: { Authorization: `Bearer ${state.user}:${state.token}` },
			});
		} catch {
			// Clear local session even if server unreachable
		}
	}
	clearSyncState(agentDir);
}

export async function syncPush(
	agentDir: string = getAgentDir(),
): Promise<{ updated: number; skillFiles: number; extensionFiles: number }> {
	const state = readSyncState(agentDir);
	if (!state) throw new Error("Not signed in to Cloud Sync.");
	const bundle = collectLocalSyncBundle(agentDir);
	const res = await syncRequest(`${state.serverUrl}/data`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${state.user}:${state.token}`,
		},
		body: JSON.stringify({ data: bundle }),
	});
	const updated = Number(res.updated || Date.now());
	writeSyncState({ ...state, lastSyncUpdated: updated }, agentDir);
	const extensionFiles =
		Object.keys(bundle.extensions ?? {}).length +
		Object.keys(bundle.themes ?? {}).length +
		Object.keys(bundle.tools ?? {}).length +
		Object.keys(bundle.plugins ?? {}).length +
		Object.keys(bundle.gitPackages ?? {}).length;
	return { updated, skillFiles: Object.keys(bundle.skills ?? {}).length, extensionFiles };
}

export async function syncPull(
	agentDir: string = getAgentDir(),
): Promise<{ hasData: boolean; updated: number; skillFiles: number; promptFiles: number; extensionFiles: number }> {
	const state = readSyncState(agentDir);
	if (!state) throw new Error("Not signed in to Cloud Sync.");
	const res = await syncRequest(`${state.serverUrl}/data`, {
		method: "GET",
		headers: { Authorization: `Bearer ${state.user}:${state.token}` },
	});
	const updated = Number(res.updated || 0);
	if (!res.data || typeof res.data !== "object") {
		return { hasData: false, updated, skillFiles: 0, promptFiles: 0, extensionFiles: 0 };
	}
	const applied = applyRemoteSyncBundle(res.data as CloudSyncBundle, agentDir);
	writeSyncState({ ...state, lastSyncUpdated: updated }, agentDir);
	return { hasData: true, updated, ...applied };
}

export async function syncAutoOnStartup(
	agentDir: string = getAgentDir(),
): Promise<{ action: "none" | "pulled" | "pushed" | "up-to-date"; skillFiles?: number; extensionFiles?: number }> {
	const state = readSyncState(agentDir);
	if (!state || !state.autoSync) return { action: "none" };
	const res = await syncRequest(`${state.serverUrl}/data`, {
		method: "GET",
		headers: { Authorization: `Bearer ${state.user}:${state.token}` },
	});
	const remoteUpdated = Number(res.updated || 0);
	if (!res.data || remoteUpdated === 0) {
		const pushed = await syncPush(agentDir);
		return { action: "pushed", skillFiles: pushed.skillFiles, extensionFiles: pushed.extensionFiles };
	}
	if (remoteUpdated > state.lastSyncUpdated) {
		const applied = applyRemoteSyncBundle(res.data as CloudSyncBundle, agentDir);
		writeSyncState({ ...state, lastSyncUpdated: remoteUpdated }, agentDir);
		return { action: "pulled", skillFiles: applied.skillFiles, extensionFiles: applied.extensionFiles };
	}
	return { action: "up-to-date" };
}
