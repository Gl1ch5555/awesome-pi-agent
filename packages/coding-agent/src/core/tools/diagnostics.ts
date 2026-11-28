import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";

const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 3000;
const MAX_DIAGNOSTIC_LINES = 8;

const inFlightInstalls = new Set<string>();
const attemptedToolsCache = new Set<string>();
let cacheLoaded = false;

function getAgentStateDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi-awesome", "agent");
}

function getDiagnosticsToolsStatePath(): string {
	return join(getAgentStateDir(), "diagnostics-tools.json");
}

function loadAttemptedCache(): void {
	if (cacheLoaded) return;
	cacheLoaded = true;
	try {
		const path = getDiagnosticsToolsStatePath();
		if (!existsSync(path)) return;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { attempted?: string[] };
		if (Array.isArray(parsed.attempted)) {
			for (const key of parsed.attempted) {
				if (typeof key === "string") attemptedToolsCache.add(key);
			}
		}
	} catch {
		// ignore corrupt cache
	}
}

function markToolAttempted(toolKey: string): void {
	loadAttemptedCache();
	if (attemptedToolsCache.has(toolKey)) return;
	attemptedToolsCache.add(toolKey);
	try {
		const path = getDiagnosticsToolsStatePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ attempted: [...attemptedToolsCache] }, null, 2)}\n`, "utf8");
	} catch {
		// best-effort
	}
}

function runDiagCommand(
	cmd: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; notFound?: boolean }> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ cwd, timeout: timeoutMs, maxBuffer: 512 * 1024 },
			(error, stdout, stderr) => {
				const errCode = (error as { code?: unknown } | null)?.code;
				if (errCode === "ENOENT") {
					resolve({ stdout: "", stderr: "", exitCode: 127, notFound: true });
					return;
				}
				const exitCode = typeof errCode === "number" ? errCode : error ? 1 : 0;
				resolve({
					stdout: typeof stdout === "string" ? stdout : "",
					stderr: typeof stderr === "string" ? stderr : "",
					exitCode,
				});
			},
		);
	});
}

function findNearestUpward(startDir: string, filenames: string[], maxDepth = 5): string | undefined {
	let current = startDir;
	for (let i = 0; i <= maxDepth; i++) {
		for (const name of filenames) {
			const candidate = join(current, name);
			if (existsSync(candidate)) return candidate;
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function filterLinesForFile(raw: string, filePath: string, cwd: string): string[] {
	const base = basename(filePath);
	const rel = relative(cwd, filePath).replace(/\\/g, "/");
	const lines = raw
		.split(/\r?\n/)
		.map((l) => l.trimEnd())
		.filter((l) => l.trim().length > 0);
	const matching = lines.filter((l) => l.includes(base) || (rel && l.includes(rel)));
	const selected = matching.length > 0 ? matching : lines;
	return selected.slice(0, MAX_DIAGNOSTIC_LINES);
}

/**
 * Try installing a missing language checker once in the background without blocking edit/write.
 */
export function scheduleAutoInstallChecker(
	toolKey: string,
	candidates: ReadonlyArray<{ cmd: string; args: string[]; cwd?: string }>,
): void {
	if (process.env.PI_OFFLINE || process.env.PI_NO_AUTO_INSTALL_DIAGNOSTICS) return;
	loadAttemptedCache();
	if (attemptedToolsCache.has(toolKey) || inFlightInstalls.has(toolKey)) return;

	inFlightInstalls.add(toolKey);
	markToolAttempted(toolKey);

	void (async () => {
		try {
			for (const step of candidates) {
				const res = await runDiagCommand(step.cmd, step.args, step.cwd ?? process.cwd(), 90_000);
				if (res.exitCode === 0) break;
			}
		} catch {
			// background install is strictly best-effort
		} finally {
			inFlightInstalls.delete(toolKey);
		}
	})();
}

function getIsolatedTsBin(): string {
	return join(
		homedir(),
		".pi-awesome",
		"tools",
		"ts",
		"node_modules",
		".bin",
		process.platform === "win32" ? "tsc.cmd" : "tsc",
	);
}

/**
 * Collect fast, zero-token local diagnostics for the edited/written file.
 * Automatically schedules one-time background installation of missing language checkers
 * (e.g. gdtoolkit for Godot .gd, ruff for Python, typescript for TS).
 */
export async function collectPostEditDiagnostics(
	filePath: string,
	cwd: string,
	options?: { timeoutMs?: number },
): Promise<string | undefined> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS;
	const ext = extname(filePath).toLowerCase();
	const fileDir = dirname(filePath);
	const base = basename(filePath);

	try {
		if (ext === ".json") {
			try {
				JSON.parse(readFileSync(filePath, "utf8"));
				return undefined;
			} catch (err) {
				return `Diagnostics (${base}):\n  ${err instanceof Error ? err.message : String(err)}`;
			}
		}

		if (ext === ".gd") {
			const gdlintRes = await runDiagCommand("gdlint", [filePath], cwd, timeoutMs);
			if (!gdlintRes.notFound) {
				if (gdlintRes.exitCode !== 0 && (gdlintRes.stdout || gdlintRes.stderr)) {
					const lines = filterLinesForFile(`${gdlintRes.stdout}\n${gdlintRes.stderr}`, filePath, cwd);
					if (lines.length > 0) return `Diagnostics (${base}):\n  ${lines.join("\n  ")}`;
				}
				return undefined;
			}

			const gdparseRes = await runDiagCommand("gdparse", [filePath], cwd, timeoutMs);
			if (!gdparseRes.notFound) {
				if (gdparseRes.exitCode !== 0 && (gdparseRes.stdout || gdparseRes.stderr)) {
					const lines = filterLinesForFile(`${gdparseRes.stdout}\n${gdparseRes.stderr}`, filePath, cwd);
					if (lines.length > 0) return `Diagnostics (${base}):\n  ${lines.join("\n  ")}`;
				}
				return undefined;
			}

			const projectGodot = findNearestUpward(fileDir, ["project.godot"]);
			if (projectGodot) {
				for (const godotBin of ["godot4", "godot"]) {
					const gRes = await runDiagCommand(
						godotBin,
						["--headless", "--path", dirname(projectGodot), "--check-only", "--script", filePath],
						dirname(projectGodot),
						timeoutMs,
					);
					if (!gRes.notFound) {
						if (gRes.exitCode !== 0 && (gRes.stderr || gRes.stdout)) {
							const lines = filterLinesForFile(`${gRes.stderr}\n${gRes.stdout}`, filePath, dirname(projectGodot));
							if (lines.length > 0) return `Diagnostics (${base}):\n  ${lines.join("\n  ")}`;
						}
						return undefined;
					}
				}
			}

			scheduleAutoInstallChecker("gdtoolkit", [
				{ cmd: "uv", args: ["tool", "install", "gdtoolkit"] },
				{ cmd: "pipx", args: ["install", "gdtoolkit"] },
				{ cmd: "pip3", args: ["install", "--user", "--quiet", "gdtoolkit"] },
				{ cmd: "pip", args: ["install", "--user", "--quiet", "gdtoolkit"] },
			]);
			return undefined;
		}

		if (ext === ".py") {
			const pyCmd = process.platform === "win32" ? "python" : "python3";
			const compileRes = await runDiagCommand(pyCmd, ["-m", "py_compile", filePath], cwd, timeoutMs);
			if (compileRes.exitCode !== 0) {
				const lines = filterLinesForFile(`${compileRes.stderr}\n${compileRes.stdout}`, filePath, cwd);
				if (lines.length > 0) return `Diagnostics (${base}):\n  ${lines.join("\n  ")}`;
			}
			const ruffRes = await runDiagCommand("ruff", ["check", "--output-format", "concise", filePath], cwd, timeoutMs);
			if (ruffRes.notFound) {
				scheduleAutoInstallChecker("ruff", [
					{ cmd: "uv", args: ["tool", "install", "ruff"] },
					{ cmd: "pipx", args: ["install", "ruff"] },
					{ cmd: "pip3", args: ["install", "--user", "--quiet", "ruff"] },
					{ cmd: "pip", args: ["install", "--user", "--quiet", "ruff"] },
				]);
				return undefined;
			}
			if (ruffRes.exitCode !== 0 && (ruffRes.stdout || ruffRes.stderr)) {
				const lines = filterLinesForFile(`${ruffRes.stdout}\n${ruffRes.stderr}`, filePath, cwd);
				if (lines.length > 0) return `Diagnostics (${base}):\n  ${lines.join("\n  ")}`;
			}
			return undefined;
		}

		if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
			const tsconfig = findNearestUpward(fileDir, ["tsconfig.json"]);
			const projectDir = tsconfig ? dirname(tsconfig) : fileDir;
			const isolatedTsBin = getIsolatedTsBin();
			const localTsc =
				findNearestUpward(projectDir, ["node_modules/.bin/tsc"], 6) ??
				(existsSync(isolatedTsBin) ? isolatedTsBin : process.platform === "win32" ? "tsc.cmd" : "tsc");
			const args = tsconfig
				? ["--noEmit", "--pretty", "false", "--incremental", "-p", tsconfig]
				: ["--noEmit", "--pretty", "false", filePath];
			const res = await runDiagCommand(localTsc, args, projectDir, timeoutMs);
			if (res.notFound) {
				const tsDir = join(homedir(), ".pi-awesome", "tools", "ts");
				mkdirSync(tsDir, { recursive: true });
				const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
				scheduleAutoInstallChecker("typescript", [
					{ cmd: npmCmd, args: ["install", "--prefix", tsDir, "--no-save", "--silent", "typescript"] },
				]);
				return undefined;
			}
			if (res.exitCode !== 0 && (res.stdout || res.stderr)) {
				const lines = filterLinesForFile(`${res.stdout}\n${res.stderr}`, filePath, projectDir);
				if (lines.length > 0) {
					return `Diagnostics (${base}):\n  ${lines.join("\n  ")}`;
				}
			}
			return undefined;
		}

		if (ext === ".go") {
			const res = await runDiagCommand("go", ["vet", fileDir], cwd, timeoutMs);
			if (!res.notFound && res.exitCode !== 0 && (res.stderr || res.stdout)) {
				const lines = filterLinesForFile(`${res.stderr}\n${res.stdout}`, filePath, cwd);
				if (lines.length > 0) return `Diagnostics (${base}):\n  ${lines.join("\n  ")}`;
			}
			return undefined;
		}

		if (ext === ".rs") {
			const cargoToml = findNearestUpward(fileDir, ["Cargo.toml"]);
			if (cargoToml) {
				const res = await runDiagCommand(
					"cargo",
					["check", "--quiet", "--message-format=short"],
					dirname(cargoToml),
					timeoutMs,
				);
				if (!res.notFound && res.exitCode !== 0 && (res.stderr || res.stdout)) {
					const lines = filterLinesForFile(`${res.stderr}\n${res.stdout}`, filePath, dirname(cargoToml));
					if (lines.length > 0) return `Diagnostics (${base}):\n  ${lines.join("\n  ")}`;
				}
			}
		}
	} catch {
		// Diagnostics must never fail edit/write
	}
	return undefined;
}
