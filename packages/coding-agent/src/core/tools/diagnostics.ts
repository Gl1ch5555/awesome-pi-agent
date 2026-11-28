import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 3000;
const MAX_DIAGNOSTIC_LINES = 8;

function runDiagCommand(
	cmd: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ cwd, timeout: timeoutMs, maxBuffer: 512 * 1024 },
			(error, stdout, stderr) => {
				const exitCode =
					error && typeof (error as { code?: unknown }).code === "number"
						? ((error as { code: number }).code)
						: error
							? 1
							: 0;
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
 * Collect fast, zero-token local diagnostics for the edited/written file.
 * Best-effort with a strict timeout; returns undefined when clean or unavailable.
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

		if (ext === ".py") {
			const pyCmd = process.platform === "win32" ? "python" : "python3";
			const compileRes = await runDiagCommand(pyCmd, ["-m", "py_compile", filePath], cwd, timeoutMs);
			if (compileRes.exitCode !== 0) {
				const lines = filterLinesForFile(`${compileRes.stderr}\n${compileRes.stdout}`, filePath, cwd);
				if (lines.length > 0) return `Diagnostics (${base}):\n  ${lines.join("\n  ")}`;
			}
			const ruffRes = await runDiagCommand("ruff", ["check", "--output-format", "concise", filePath], cwd, timeoutMs);
			if (ruffRes.exitCode !== 0 && (ruffRes.stdout || ruffRes.stderr)) {
				const lines = filterLinesForFile(`${ruffRes.stdout}\n${ruffRes.stderr}`, filePath, cwd);
				if (lines.length > 0) return `Diagnostics (${base}):\n  ${lines.join("\n  ")}`;
			}
			return undefined;
		}

		if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
			const tsconfig = findNearestUpward(fileDir, ["tsconfig.json"]);
			const projectDir = tsconfig ? dirname(tsconfig) : fileDir;
			const localTsc =
				findNearestUpward(projectDir, ["node_modules/.bin/tsc"], 6) ??
				(process.platform === "win32" ? "tsc.cmd" : "tsc");
			const args = tsconfig
				? ["--noEmit", "--pretty", "false", "--incremental", "-p", tsconfig]
				: ["--noEmit", "--pretty", "false", filePath];
			const res = await runDiagCommand(localTsc, args, projectDir, timeoutMs);
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
			if (res.exitCode !== 0 && (res.stderr || res.stdout)) {
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
				if (res.exitCode !== 0 && (res.stderr || res.stdout)) {
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
