import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";
import { stripBom } from "../utils/text.ts";

export type MemoryTarget = "project" | "memory" | "user";

export interface MemoryOperation {
	action: "add" | "patch" | "remove";
	content?: string;
	old_text?: string;
}

export interface MemoryStoreLimits {
	project: number;
	memory: number;
	user: number;
}

export const MEMORY_CHAR_LIMITS: MemoryStoreLimits = {
	project: 3000,
	memory: 2200,
	user: 1400,
};

const ENTRY_SEPARATOR = "\n§\n";

interface GlobalMemoryFileShape {
	version: 1;
	memory: string[];
	user: string[];
}

interface ProjectMemoryFileShape {
	version: 1;
	projectRoot: string;
	updatedAt: number;
	entries: string[];
}

export interface MemorySnapshot {
	projectRoot: string;
	projectKey: string;
	project: string[];
	memory: string[];
	user: string[];
}

export interface MemoryOperationResult {
	ok: boolean;
	target: MemoryTarget;
	chars: number;
	limit: number;
	entries: string[];
	summary: string;
	error?: string;
}

function canonicalizePath(targetPath: string): string {
	const resolved = resolve(targetPath);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/**
 * Walk up from `cwd` looking for a `.git` root so subdirectories of the same
 * repository share one project memory file.
 */
export function resolveProjectRoot(cwd: string): string {
	let current = canonicalizePath(cwd);
	while (true) {
		if (existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return canonicalizePath(cwd);
		}
		current = parent;
	}
}

export function resolveProjectMemoryKey(cwd: string): { projectRoot: string; projectKey: string } {
	const projectRoot = resolveProjectRoot(cwd);
	const normalizedForHash = process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot;
	const hash = createHash("sha256").update(normalizedForHash).digest("hex").slice(0, 10);
	const rawName = basename(projectRoot) || "root";
	const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
	return {
		projectRoot,
		projectKey: `${safeName}--${hash}`,
	};
}

export function getGlobalMemoryPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "memory.json");
}

export function getProjectMemoryPath(cwd: string, agentDir: string = getAgentDir()): string {
	const { projectKey } = resolveProjectMemoryKey(cwd);
	return join(agentDir, "projects", projectKey, "lessons.json");
}

function readJsonSafe<T>(filePath: string): T | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		return JSON.parse(stripBom(readFileSync(filePath, "utf8"))) as T;
	} catch {
		return undefined;
	}
}

function writeJsonAtomic(filePath: string, data: unknown): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeEntries(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

export function countMemoryChars(entries: readonly string[]): number {
	if (entries.length === 0) return 0;
	return entries.join(ENTRY_SEPARATOR).length;
}

export function readMemorySnapshot(options: { cwd: string; agentDir?: string }): MemorySnapshot {
	const agentDir = options.agentDir ?? getAgentDir();
	const { projectRoot, projectKey } = resolveProjectMemoryKey(options.cwd);
	const globalData = readJsonSafe<Partial<GlobalMemoryFileShape>>(getGlobalMemoryPath(agentDir));
	const projectData = readJsonSafe<Partial<ProjectMemoryFileShape>>(getProjectMemoryPath(options.cwd, agentDir));
	return {
		projectRoot,
		projectKey,
		project: normalizeEntries(projectData?.entries),
		memory: normalizeEntries(globalData?.memory),
		user: normalizeEntries(globalData?.user),
	};
}

export function clearMemoryTarget(
	target: MemoryTarget,
	options: { cwd: string; agentDir?: string },
): { target: MemoryTarget; clearedCount: number } {
	const agentDir = options.agentDir ?? getAgentDir();
	if (target === "project") {
		const path = getProjectMemoryPath(options.cwd, agentDir);
		const existing = readJsonSafe<Partial<ProjectMemoryFileShape>>(path);
		const prev = normalizeEntries(existing?.entries);
		const { projectRoot } = resolveProjectMemoryKey(options.cwd);
		writeJsonAtomic(path, {
			version: 1,
			projectRoot,
			updatedAt: Date.now(),
			entries: [],
		} satisfies ProjectMemoryFileShape);
		return { target, clearedCount: prev.length };
	}
	const globalPath = getGlobalMemoryPath(agentDir);
	const existing = readJsonSafe<Partial<GlobalMemoryFileShape>>(globalPath);
	const memory = normalizeEntries(existing?.memory);
	const user = normalizeEntries(existing?.user);
	const clearedCount = target === "memory" ? memory.length : user.length;
	writeJsonAtomic(globalPath, {
		version: 1,
		memory: target === "memory" ? [] : memory,
		user: target === "user" ? [] : user,
	} satisfies GlobalMemoryFileShape);
	return { target, clearedCount };
}

export function applyMemoryOperations(
	target: MemoryTarget,
	operations: readonly MemoryOperation[],
	options: { cwd: string; agentDir?: string },
): MemoryOperationResult {
	const agentDir = options.agentDir ?? getAgentDir();
	const limit = MEMORY_CHAR_LIMITS[target];
	const snapshot = readMemorySnapshot({ cwd: options.cwd, agentDir });
	const working = [...snapshot[target]];

	if (!Array.isArray(operations) || operations.length === 0) {
		return {
			ok: false,
			target,
			chars: countMemoryChars(working),
			limit,
			entries: working,
			summary: "No operations provided",
			error: "operations must be a non-empty array",
		};
	}

	const summaryParts: string[] = [];

	for (let i = 0; i < operations.length; i++) {
		const op = operations[i]!;
		if (op.action === "add") {
			const content = typeof op.content === "string" ? op.content.trim() : "";
			if (!content) {
				return {
					ok: false,
					target,
					chars: countMemoryChars(working),
					limit,
					entries: snapshot[target],
					summary: "Rejected empty add",
					error: `operation[${i}] (add): content is required`,
				};
			}
			if (!working.includes(content)) {
				working.push(content);
				summaryParts.push(`+ ${content}`);
			} else {
				summaryParts.push(`= already present: ${content}`);
			}
		} else if (op.action === "patch") {
			const oldText = typeof op.old_text === "string" ? op.old_text : "";
			const content = typeof op.content === "string" ? op.content : "";
			if (!oldText || !content.trim()) {
				return {
					ok: false,
					target,
					chars: countMemoryChars(working),
					limit,
					entries: snapshot[target],
					summary: "Invalid patch",
					error: `operation[${i}] (patch): old_text and content are required`,
				};
			}
			const matches = working
				.map((entry, idx) => ({ idx, count: entry.split(oldText).length - 1 }))
				.filter((m) => m.count > 0);
			if (matches.length !== 1 || matches[0]!.count !== 1) {
				return {
					ok: false,
					target,
					chars: countMemoryChars(working),
					limit,
					entries: snapshot[target],
					summary: "Patch target mismatch",
					error: `operation[${i}] (patch): old_text must match uniquely in one entry (matched ${matches.length} entries)`,
				};
			}
			const idx = matches[0]!.idx;
			working[idx] = working[idx]!.replace(oldText, content).trim();
			summaryParts.push(`~ ${working[idx]}`);
		} else if (op.action === "remove") {
			const oldText = typeof op.old_text === "string" ? op.old_text.trim() : "";
			if (!oldText) {
				return {
					ok: false,
					target,
					chars: countMemoryChars(working),
					limit,
					entries: snapshot[target],
					summary: "Invalid remove",
					error: `operation[${i}] (remove): old_text is required`,
				};
			}
			const idx = working.findIndex((entry) => entry === oldText || entry.includes(oldText));
			if (idx === -1) {
				return {
					ok: false,
					target,
					chars: countMemoryChars(working),
					limit,
					entries: snapshot[target],
					summary: "Remove target not found",
					error: `operation[${i}] (remove): no entry matching "${oldText}"`,
				};
			}
			const [removed] = working.splice(idx, 1);
			summaryParts.push(`- ${removed}`);
		} else {
			return {
				ok: false,
				target,
				chars: countMemoryChars(working),
				limit,
				entries: snapshot[target],
				summary: "Unknown action",
				error: `operation[${i}]: unsupported action "${String((op as { action?: unknown }).action)}"`,
			};
		}
	}

	const finalEntries = normalizeEntries(working);
	const finalChars = countMemoryChars(finalEntries);
	if (finalChars > limit) {
		return {
			ok: false,
			target,
			chars: countMemoryChars(snapshot[target]),
			limit,
			entries: snapshot[target],
			summary: "Memory limit exceeded",
			error: `Target "${target}" would be ${finalChars}/${limit} chars. Consolidate or remove stale entries in the same operations batch.`,
		};
	}

	if (target === "project") {
		const path = getProjectMemoryPath(options.cwd, agentDir);
		writeJsonAtomic(path, {
			version: 1,
			projectRoot: snapshot.projectRoot,
			updatedAt: Date.now(),
			entries: finalEntries,
		} satisfies ProjectMemoryFileShape);
	} else {
		const globalPath = getGlobalMemoryPath(agentDir);
		const existing = readJsonSafe<Partial<GlobalMemoryFileShape>>(globalPath);
		const memory = target === "memory" ? finalEntries : normalizeEntries(existing?.memory);
		const user = target === "user" ? finalEntries : normalizeEntries(existing?.user);
		writeJsonAtomic(globalPath, {
			version: 1,
			memory,
			user,
		} satisfies GlobalMemoryFileShape);
	}

	return {
		ok: true,
		target,
		chars: finalChars,
		limit,
		entries: finalEntries,
		summary: summaryParts.join("\n"),
	};
}

export function formatMemoryPromptSection(options: { cwd: string; agentDir?: string }): string {
	const snap = readMemorySnapshot(options);
	const parts: string[] = [];

	if (snap.project.length > 0) {
		const chars = countMemoryChars(snap.project);
		parts.push(
			`PROJECT LESSONS (${snap.projectRoot.replace(/\\/g, "/")}) [${chars}/${MEMORY_CHAR_LIMITS.project} chars]:\n${snap.project.map((e) => `- ${e}`).join("\n")}`,
		);
	}
	if (snap.memory.length > 0) {
		const chars = countMemoryChars(snap.memory);
		parts.push(
			`AGENT NOTES [${chars}/${MEMORY_CHAR_LIMITS.memory} chars]:\n${snap.memory.map((e) => `- ${e}`).join("\n")}`,
		);
	}
	if (snap.user.length > 0) {
		const chars = countMemoryChars(snap.user);
		parts.push(
			`USER PREFERENCES [${chars}/${MEMORY_CHAR_LIMITS.user} chars]:\n${snap.user.map((e) => `- ${e}`).join("\n")}`,
		);
	}

	return parts.join("\n\n");
}
