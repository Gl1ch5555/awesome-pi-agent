import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getPackageDir } from "../config.ts";
import { scopedFetch } from "./http-dispatcher.ts";
import { isNewerPackageVersion } from "../utils/version-check.ts";

const webFetch: typeof fetch = (input, init) => scopedFetch("web", input as string | URL | Request, init);

export const AWESOME_PI_REPO = "Gl1ch5555/awesome-pi-agent";
export const AWESOME_PI_URL = `https://github.com/${AWESOME_PI_REPO}`;
export const AWESOME_PI_AUTHOR_URL = "https://github.com/Gl1ch5555";
const RELEASE_BASE_URL = `https://github.com/${AWESOME_PI_REPO}/releases/download/latest`;
const RELEASE_VERSION_URL = `${RELEASE_BASE_URL}/version.json`;
const GITHUB_COMMITS_URL = `https://api.github.com/repos/${AWESOME_PI_REPO}/commits/main`;
const GITHUB_CHANGELOG_URL = `https://raw.githubusercontent.com/${AWESOME_PI_REPO}/main/packages/coding-agent/CHANGELOG.md`;
const GITHUB_PACKAGE_JSON_URL = `https://raw.githubusercontent.com/${AWESOME_PI_REPO}/main/packages/coding-agent/package.json`;
const GITHUB_TARBALL_URL = `https://github.com/${AWESOME_PI_REPO}/archive/refs/heads/main.tar.gz`;
const GITHUB_ZIP_URL = `https://github.com/${AWESOME_PI_REPO}/archive/refs/heads/main.zip`;

export interface GithubUpdateInfo {
	hasUpdate: boolean;
	localVersion: string;
	remoteVersion: string;
	localSha?: string;
	remoteSha?: string;
	shortSha?: string;
	commitMessage?: string;
}

export function getInstallRootDir(): string {
	if (process.env.PI_INSTALL_DIR?.trim()) {
		return process.env.PI_INSTALL_DIR.trim();
	}
	return join(homedir(), ".pi-awesome");
}

export function getVersionStatePath(): string {
	return join(getInstallRootDir(), "version.json");
}

export function getPlatformReleaseAssetName(): string | undefined {
	const os =
		process.platform === "win32"
			? "windows"
			: process.platform === "darwin"
				? "darwin"
				: process.platform === "linux"
					? "linux"
					: undefined;
	const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : undefined;
	if (!os || !arch) return undefined;
	return os === "windows" ? `pi-windows-${arch}.zip` : `pi-${os}-${arch}.tar.gz`;
}

export function readInstalledSha(): string | undefined {
	const versionFile = getVersionStatePath();
	if (existsSync(versionFile)) {
		try {
			const parsed = JSON.parse(readFileSync(versionFile, "utf8")) as { sha?: string };
			if (parsed.sha && /^[0-9a-f]{7,40}$/i.test(parsed.sha)) {
				return parsed.sha;
			}
		} catch {
			// ignore
		}
	}

	// Fallback: check git HEAD if running from a git checkout
	try {
		const repoRoot = join(getPackageDir(), "..", "..");
		if (existsSync(join(repoRoot, ".git"))) {
			const sha = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
				encoding: "utf8",
				timeout: 1500,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
		}
	} catch {
		// ignore
	}
	return undefined;
}

export function writeInstalledSha(sha: string, version: string): void {
	const versionFile = getVersionStatePath();
	const dir = dirname(versionFile);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(
		versionFile,
		`${JSON.stringify({ sha, version, tag: "latest", updatedAt: Date.now() }, null, 2)}\n`,
		"utf8",
	);
}

export async function checkGithubUpdate(currentVersion: string): Promise<GithubUpdateInfo | undefined> {
	if (process.env.PI_OFFLINE || process.env.PI_SKIP_VERSION_CHECK) return undefined;

	const localSha = readInstalledSha();
	const headers: Record<string, string> = {
		"User-Agent": `awesome-pi-agent/${currentVersion}`,
		Accept: "application/vnd.github+json",
	};
	const token = process.env.PI_GH_TOKEN || process.env.GITHUB_TOKEN;
	if (token) headers.Authorization = `token ${token}`;

	let remoteSha: string | undefined;
	let commitMessage: string | undefined;
	let remoteVersion = currentVersion;

	try {
		// Prefer release version.json first (no GitHub REST API rate limits)
		const relRes = await webFetch(`${RELEASE_VERSION_URL}?t=${Date.now()}`, {
			headers: { "User-Agent": headers["User-Agent"]! },
			signal: AbortSignal.timeout(6000),
		}).catch(() => undefined);

		if (relRes?.ok) {
			const relJson = (await relRes.json()) as { sha?: string; version?: string };
			if (typeof relJson.sha === "string" && relJson.sha.trim()) {
				remoteSha = relJson.sha.trim();
			}
			if (typeof relJson.version === "string" && relJson.version.trim()) {
				remoteVersion = relJson.version.trim();
			}
		}

		if (!remoteSha) {
			const [commitRes, pkgRes] = await Promise.all([
				webFetch(GITHUB_COMMITS_URL, { headers, signal: AbortSignal.timeout(8000) }),
				webFetch(`${GITHUB_PACKAGE_JSON_URL}?t=${Date.now()}`, {
					headers: { "User-Agent": headers["User-Agent"]! },
					signal: AbortSignal.timeout(8000),
				}).catch(() => undefined),
			]);

			if (commitRes.ok) {
				const commitJson = (await commitRes.json()) as {
					sha?: string;
					commit?: { message?: string };
				};
				if (typeof commitJson.sha === "string" && commitJson.sha.trim()) {
					remoteSha = commitJson.sha.trim();
					commitMessage = commitJson.commit?.message?.split("\n")[0]?.trim();
				}
			}

			if (pkgRes?.ok) {
				const pkgJson = (await pkgRes.json()) as { version?: string };
				if (typeof pkgJson.version === "string" && pkgJson.version.trim()) {
					remoteVersion = pkgJson.version.trim();
				}
			}
		}
	} catch {
		return undefined;
	}

	if (!remoteSha && remoteVersion === currentVersion) return undefined;

	const versionNewer = isNewerPackageVersion(remoteVersion, currentVersion);
	const shaNewer = Boolean(remoteSha && localSha && remoteSha !== localSha);
	if (!localSha && remoteSha && !versionNewer) {
		try {
			writeInstalledSha(remoteSha, currentVersion);
		} catch {
			// ignore
		}
		return {
			hasUpdate: false,
			localVersion: currentVersion,
			remoteVersion,
			localSha: remoteSha,
			remoteSha,
			shortSha: remoteSha.slice(0, 7),
			commitMessage,
		};
	}

	return {
		hasUpdate: versionNewer || shaNewer,
		localVersion: currentVersion,
		remoteVersion,
		localSha,
		remoteSha,
		shortSha: remoteSha?.slice(0, 7),
		commitMessage,
	};
}

function runCommand(cmd: string, args: string[], cwd: string, useShell = false): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: useShell,
			windowsHide: true,
		});
		let errTail = "";
		proc.stderr?.on("data", (d: Buffer) => {
			errTail = `${errTail}${d.toString("utf8")}`.slice(-800);
		});
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(`${cmd} ${args.join(" ")} exited with code ${code}${errTail ? `: ${errTail.trim()}` : ""}`),
				);
		});
	});
}

function encodePowerShellCommand(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

function escapePowerShellSingleQuoted(value: string): string {
	return value.replace(/'/g, "''");
}

async function extractWindowsZip(archivePath: string, destDir: string, cwd: string): Promise<void> {
	try {
		await runCommand("tar.exe", ["-xf", archivePath, "-C", destDir], cwd);
		if (readdirSync(destDir).length > 0) return;
	} catch {
		// Fall back to PowerShell Expand-Archive if bsdtar is unavailable
	}
	const psScript = `Expand-Archive -LiteralPath '${escapePowerShellSingleQuoted(archivePath)}' -DestinationPath '${escapePowerShellSingleQuoted(destDir)}' -Force`;
	await runCommand(
		"powershell.exe",
		["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShellCommand(psScript)],
		cwd,
	);
}

function cleanupOldWindowsVersions(installRoot: string, keepDir: string): void {
	const activeDir = getPackageDir();
	const versionsDir = join(installRoot, "versions");
	if (existsSync(versionsDir)) {
		try {
			for (const entry of readdirSync(versionsDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const candidate = join(versionsDir, entry.name);
				if (candidate === keepDir || candidate === activeDir) continue;
				try {
					rmSync(candidate, { recursive: true, force: true });
				} catch {
					// Still locked by another running pi-awesome process
				}
			}
		} catch {
			// ignore
		}
	}
	const legacyAppDir = join(installRoot, "app");
	if (existsSync(legacyAppDir) && legacyAppDir !== keepDir && legacyAppDir !== activeDir) {
		try {
			rmSync(legacyAppDir, { recursive: true, force: true });
		} catch {
			// Still locked by the current running process; cleaned on next update
		}
	}
}

async function downloadRangeChunkWithResume(
	url: string,
	destPath: string,
	start: number,
	end: number,
	headers: Record<string, string>,
	onBytes: (delta: number) => void,
): Promise<boolean> {
	const { appendFileSync, statSync } = await import("node:fs");
	const expected = end - start + 1;

	for (let attempt = 1; attempt <= 6; attempt++) {
		let have = existsSync(destPath) ? statSync(destPath).size : 0;
		if (have > expected) {
			rmSync(destPath, { force: true });
			have = 0;
		}
		if (have === expected) return true;

		const reqStart = start + have;
		try {
			const res = await webFetch(url, {
				headers: { ...headers, Range: `bytes=${reqStart}-${end}` },
				signal: AbortSignal.timeout(60_000),
			});
			if (res.status !== 206 && res.status !== 200) {
				if (res.status === 416) rmSync(destPath, { force: true });
				continue;
			}
			if (res.status === 200) {
				// Server ignored Range; let caller fall back to single stream.
				return false;
			}
			const reader = res.body?.getReader();
			if (!reader) {
				const buf = Buffer.from(await res.arrayBuffer());
				appendFileSync(destPath, buf);
				onBytes(buf.byteLength);
			} else {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value && value.byteLength > 0) {
						appendFileSync(destPath, value);
						onBytes(value.byteLength);
					}
				}
			}
			if ((existsSync(destPath) ? statSync(destPath).size : 0) === expected) return true;
		} catch {
			// Retry chunk from current byte offset
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return false;
}

async function downloadWithResume(
	url: string,
	destPath: string,
	headers: Record<string, string>,
	onProgress?: (stage: string) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const { appendFileSync, statSync } = await import("node:fs");
	const maxAttempts = 6;
	let totalBytes: number | undefined;

	// Try 4-stream parallel Range download when supported (much faster on mobile/VPN links).
	try {
		const headRes = await webFetch(url, { method: "HEAD", headers, signal: AbortSignal.timeout(15_000) });
		if (headRes.ok) {
			const lenStr = headRes.headers.get("content-length");
			const acceptRanges = headRes.headers.get("accept-ranges")?.toLowerCase();
			const parsedLen = lenStr ? Number.parseInt(lenStr, 10) : 0;
			if (acceptRanges === "bytes" && Number.isFinite(parsedLen) && parsedLen >= 4 * 1024 * 1024) {
				const finalUrl = headRes.url || url;
				const parts = 4;
				const chunkSize = Math.floor(parsedLen / parts);
				const partPaths = Array.from({ length: parts }, (_, i) => `${destPath}.part.${i}`);
				let downloaded = 0;
				let lastReportedPct = -1;
				const totalMb = (parsedLen / 1048576).toFixed(1);
				const report = (delta: number) => {
					downloaded += delta;
					const pct = Math.min(100, Math.floor((downloaded * 100) / parsedLen));
					if (pct !== lastReportedPct && (pct % 5 === 0 || pct === 100)) {
						lastReportedPct = pct;
						const doneMb = (downloaded / 1048576).toFixed(1);
						onProgress?.(`Downloading prebuilt binary (${pct}% · ${doneMb}/${totalMb} MB)...`);
					}
				};
				const results = await Promise.all(
					partPaths.map((p, i) => {
						const start = i * chunkSize;
						const end = i === parts - 1 ? parsedLen - 1 : start + chunkSize - 1;
						return downloadRangeChunkWithResume(finalUrl, p, start, end, headers, report);
					}),
				);
				if (results.every(Boolean)) {
					rmSync(destPath, { force: true });
					const { readFileSync } = await import("node:fs");
					for (const p of partPaths) {
						appendFileSync(destPath, readFileSync(p));
						rmSync(p, { force: true });
					}
					if (statSync(destPath).size === parsedLen) {
						return { ok: true };
					}
				}
				for (const p of partPaths) rmSync(p, { force: true });
				rmSync(destPath, { force: true });
			}
		}
	} catch {
		// Fall through to single resumable stream
	}

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const existingBytes = existsSync(destPath) ? statSync(destPath).size : 0;
		const reqHeaders: Record<string, string> = { ...headers };
		if (existingBytes > 0) {
			reqHeaders.Range = `bytes=${existingBytes}-`;
		}

		try {
			const res = await webFetch(url, {
				headers: reqHeaders,
				signal: AbortSignal.timeout(90_000),
			});

			if (res.status === 416) {
				rmSync(destPath, { force: true });
				continue;
			}
			if (!res.ok) {
				return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
			}

			// If server ignored Range and sent full 200, restart file from byte 0.
			if (existingBytes > 0 && res.status === 200) {
				rmSync(destPath, { force: true });
			}

			if (totalBytes === undefined) {
				const contentRange = res.headers.get("content-range");
				const rangeMatch = contentRange?.match(/\/(\d+)$/);
				if (rangeMatch?.[1]) {
					totalBytes = Number.parseInt(rangeMatch[1], 10);
				} else {
					const contentLength = res.headers.get("content-length");
					if (contentLength) {
						const parsed = Number.parseInt(contentLength, 10);
						if (Number.isFinite(parsed) && parsed > 0) totalBytes = parsed;
					}
				}
			}

			const reader = res.body?.getReader();
			if (!reader) {
				writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
			} else {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (value && value.byteLength > 0) {
						appendFileSync(destPath, value);
					}
				}
			}

			const finalSize = existsSync(destPath) ? statSync(destPath).size : 0;
			if (totalBytes !== undefined && finalSize < totalBytes) {
				throw new Error(`Truncated download (${finalSize}/${totalBytes} bytes)`);
			}
			return { ok: true };
		} catch (err) {
			if (attempt === maxAttempts) {
				return { ok: false, reason: err instanceof Error ? err.message : String(err) };
			}
			onProgress?.(`Download interrupted, resuming (${attempt}/${maxAttempts})...`);
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
	}

	return { ok: false, reason: "Download failed after retries" };
}

async function tryUpdateFromPrebuiltRelease(
	installRoot: string,
	headers: Record<string, string>,
	onProgress?: (stage: string) => void,
): Promise<{ ok: true } | { ok: false; reason?: string }> {
	const assetName = getPlatformReleaseAssetName();
	if (!assetName) return { ok: false, reason: `Unsupported platform ${process.platform}/${process.arch}` };

	const tempDir = join(tmpdir(), `pi-awesome-bin-${Date.now()}`);
	mkdirSync(tempDir, { recursive: true });

	try {
		onProgress?.(`Downloading prebuilt binary (${assetName})...`);
		const archivePath = join(tempDir, assetName);
		const downloaded = await downloadWithResume(`${RELEASE_BASE_URL}/${assetName}`, archivePath, headers, onProgress);
		if (!downloaded.ok) return { ok: false, reason: downloaded.reason };

		const stageDir = join(tempDir, "stage");
		mkdirSync(stageDir, { recursive: true });

		onProgress?.("Extracting prebuilt binary...");
		const appDir = join(installRoot, "app");
		let targetExeDir = appDir;
		if (process.platform === "win32") {
			await extractWindowsZip(archivePath, stageDir, tempDir);
			const stagedExe = join(stageDir, "pi.exe");
			if (!existsSync(stagedExe)) {
				return { ok: false, reason: "Archive did not contain pi.exe" };
			}

			// Install side-by-side under versions/<timestamp> so running pi.exe and loaded
			// native/*.node binaries are never overwritten in place on Windows.
			const versionedDir = join(installRoot, "versions", `${Date.now()}`);
			mkdirSync(dirname(versionedDir), { recursive: true });
			try {
				renameSync(stageDir, versionedDir);
			} catch {
				mkdirSync(versionedDir, { recursive: true });
				cpSync(stageDir, versionedDir, { recursive: true, force: true });
			}
			targetExeDir = versionedDir;
			cleanupOldWindowsVersions(installRoot, targetExeDir);
		} else {
			await runCommand("tar", ["-xzf", archivePath, "-C", stageDir], tempDir);
			const extractedApp = join(stageDir, "pi");
			if (!existsSync(join(extractedApp, "pi"))) {
				return { ok: false, reason: "Archive did not contain pi binary" };
			}

			const backupDir = join(installRoot, "app.old");
			rmSync(backupDir, { recursive: true, force: true });
			if (existsSync(appDir)) {
				renameSync(appDir, backupDir);
			}
			cpSync(extractedApp, appDir, { recursive: true, force: true });
			chmodSync(join(appDir, "pi"), 0o755);
			rmSync(backupDir, { recursive: true, force: true });
		}

		const binDir = process.env.PI_BIN_DIR?.trim() || join(homedir(), ".local", "bin");
		mkdirSync(binDir, { recursive: true });
		if (process.platform === "win32") {
			const appExe = join(targetExeDir, "pi.exe");
			writeFileSync(join(binDir, "pi-awesome.cmd"), `@echo off\r\n"${appExe}" %*\r\n`, "ascii");
			writeFileSync(join(binDir, "pi-awesome.ps1"), `#!/usr/bin/env pwsh\n& "${appExe}" @args\n`, "utf8");
		} else {
			const targetBin = join(binDir, "pi-awesome");
			writeFileSync(targetBin, `#!/usr/bin/env bash\nexec "${join(appDir, "pi")}" "$@"\n`, "utf8");
			chmodSync(targetBin, 0o755);
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

async function fetchRemoteChangelogSection(version: string, headers: Record<string, string>): Promise<string | undefined> {
	try {
		const res = await webFetch(`${GITHUB_CHANGELOG_URL}?t=${Date.now()}`, {
			headers,
			signal: AbortSignal.timeout(4000),
		});
		if (!res.ok) return undefined;
		const text = await res.text();
		const lines = text.split(/\r?\n/);
		const sections: string[] = [];
		let collecting = false;
		for (const line of lines) {
			if (line.startsWith("## [")) {
				if (collecting) break;
				if (line.includes(`[${version}]`) || (!version && sections.length === 0)) {
					collecting = true;
				}
			}
			if (collecting) {
				sections.push(line);
			}
		}
		if (sections.length > 0) {
			return sections.join("\n").trim();
		}
		// Fallback to first version section in CHANGELOG.md
		collecting = false;
		for (const line of lines) {
			if (line.startsWith("## [") && !line.includes("[Unreleased]")) {
				if (collecting) break;
				collecting = true;
			}
			if (collecting) sections.push(line);
		}
		return sections.length > 0 ? sections.join("\n").trim() : undefined;
	} catch {
		return undefined;
	}
}

export async function performGithubSelfUpdate(
	currentVersion: string,
	onProgress?: (stage: string) => void,
): Promise<{
	updated: boolean;
	version: string;
	shortSha?: string;
	message: string;
	changelog?: string;
	commitMessage?: string;
}> {
	const check = await checkGithubUpdate(currentVersion);
	if (check && !check.hasUpdate) {
		return {
			updated: false,
			version: check.localVersion,
			shortSha: check.shortSha,
			message: `Already up to date (${check.shortSha ?? check.localVersion})`,
		};
	}

	const installRoot = getInstallRootDir();
	const headers: Record<string, string> = { "User-Agent": `awesome-pi-agent/${currentVersion}` };
	const token = process.env.PI_GH_TOKEN || process.env.GITHUB_TOKEN;
	if (token) headers.Authorization = `token ${token}`;

	const newSha = check?.remoteSha ?? "main";
	const newVer = check?.remoteVersion ?? currentVersion;

	const prebuilt = await tryUpdateFromPrebuiltRelease(installRoot, headers, onProgress);
	if (prebuilt.ok) {
		writeInstalledSha(newSha, newVer);
		const changelog = await fetchRemoteChangelogSection(newVer, headers);
		return {
			updated: true,
			version: newVer,
			shortSha: newSha.slice(0, 7),
			message: `Updated to prebuilt v${newVer} (${newSha.slice(0, 7)}). Restart pi-awesome to use the new build.`,
			changelog,
			commitMessage: check?.commitMessage,
		};
	}

	const srcDir = join(installRoot, "src");
	if (!existsSync(srcDir)) {
		const detail = prebuilt.reason ? ` (${prebuilt.reason})` : "";
		throw new Error(
			`Prebuilt release update failed${detail} and local source directory not found. Run the installer script.`,
		);
	}

	const tempDir = join(tmpdir(), `pi-awesome-update-${Date.now()}`);
	mkdirSync(tempDir, { recursive: true });

	try {
		onProgress?.("Downloading source update from GitHub...");
		const isWin = process.platform === "win32";
		const archiveUrl = isWin ? GITHUB_ZIP_URL : GITHUB_TARBALL_URL;
		const archivePath = join(tempDir, isWin ? "update.zip" : "update.tar.gz");

		const res = await webFetch(archiveUrl, { headers, signal: AbortSignal.timeout(60_000) });
		if (!res.ok) {
			throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
		}
		writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));

		onProgress?.("Extracting source update...");
		const extractDir = join(tempDir, "extracted");
		mkdirSync(extractDir, { recursive: true });
		if (isWin) {
			await extractWindowsZip(archivePath, extractDir, tempDir);
			const firstDir = readdirSync(extractDir, { withFileTypes: true }).find((e) => e.isDirectory())?.name;
			const entries = firstDir ? join(extractDir, firstDir) : "";
			if (!entries) throw new Error("Empty update archive");
			await runCommand(
				"robocopy",
				[entries, srcDir, "/MIR", "/XD", "node_modules", "/NFL", "/NDL", "/NJH", "/NJS"],
				tempDir,
			).catch(() => {});
		} else {
			await runCommand("tar", ["-xzf", archivePath, "--strip-components=1", "-C", srcDir], tempDir);
		}

		onProgress?.("Installing dependencies & building...");
		const npmCmd = isWin ? "npm.cmd" : "npm";
		await runCommand(npmCmd, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], srcDir, isWin);
		await runCommand(npmCmd, ["run", "hydrate:model-data"], srcDir, isWin).catch(() => {});
		await runCommand(npmCmd, ["run", "build:offline"], srcDir, isWin);

		writeInstalledSha(newSha, newVer);
		const changelog = await fetchRemoteChangelogSection(newVer, headers);
		return {
			updated: true,
			version: newVer,
			shortSha: newSha.slice(0, 7),
			message: `Updated to ${newVer} (${newSha.slice(0, 7)}). Restart pi-awesome to apply.`,
			changelog,
			commitMessage: check?.commitMessage,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
