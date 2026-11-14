import { execFileSync, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getPackageDir } from "../config.ts";
import { isNewerPackageVersion } from "../utils/version-check.ts";

export const AWESOME_PI_REPO = "Gl1ch5555/awesome-pi-agent";
const RELEASE_BASE_URL = `https://github.com/${AWESOME_PI_REPO}/releases/download/latest`;
const RELEASE_VERSION_URL = `${RELEASE_BASE_URL}/version.json`;
const GITHUB_COMMITS_URL = `https://api.github.com/repos/${AWESOME_PI_REPO}/commits/main`;
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
		const relRes = await fetch(`${RELEASE_VERSION_URL}?t=${Date.now()}`, {
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
				fetch(GITHUB_COMMITS_URL, { headers, signal: AbortSignal.timeout(8000) }),
				fetch(`${GITHUB_PACKAGE_JSON_URL}?t=${Date.now()}`, {
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

function runCommand(cmd: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
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

async function tryUpdateFromPrebuiltRelease(
	installRoot: string,
	headers: Record<string, string>,
	onProgress?: (stage: string) => void,
): Promise<boolean> {
	const assetName = getPlatformReleaseAssetName();
	if (!assetName) return false;

	const tempDir = join(tmpdir(), `pi-awesome-bin-${Date.now()}`);
	mkdirSync(tempDir, { recursive: true });

	try {
		onProgress?.(`Downloading prebuilt binary (${assetName})...`);
		const res = await fetch(`${RELEASE_BASE_URL}/${assetName}`, {
			headers,
			signal: AbortSignal.timeout(90_000),
		});
		if (!res.ok) return false;

		const archivePath = join(tempDir, assetName);
		writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));

		const stageDir = join(tempDir, "stage");
		mkdirSync(stageDir, { recursive: true });

		onProgress?.("Extracting prebuilt binary...");
		const appDir = join(installRoot, "app");
		if (process.platform === "win32") {
			await runCommand(
				"powershell.exe",
				["-NoProfile", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${stageDir}' -Force`],
				tempDir,
			);
			const stagedExe = join(stageDir, "pi.exe");
			if (!existsSync(stagedExe)) return false;

			const existingExe = join(appDir, "pi.exe");
			const backupExe = join(appDir, "pi.exe.old");
			if (existsSync(backupExe)) {
				try {
					rmSync(backupExe, { force: true });
				} catch {
					// ignore
				}
			}
			if (existsSync(existingExe)) {
				try {
					renameSync(existingExe, backupExe);
				} catch {
					// ignore
				}
			}
			mkdirSync(appDir, { recursive: true });
			cpSync(stageDir, appDir, { recursive: true, force: true });
		} else {
			await runCommand("tar", ["-xzf", archivePath, "-C", stageDir], tempDir);
			const extractedApp = join(stageDir, "pi");
			if (!existsSync(join(extractedApp, "pi"))) return false;

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
			const appExe = join(appDir, "pi.exe");
			writeFileSync(join(binDir, "pi-awesome.cmd"), `@echo off\r\n"${appExe}" %*\r\n`, "ascii");
			writeFileSync(join(binDir, "pi-awesome.ps1"), `#!/usr/bin/env pwsh\n& "${appExe}" @args\n`, "utf8");
		} else {
			const targetBin = join(binDir, "pi-awesome");
			writeFileSync(targetBin, `#!/usr/bin/env bash\nexec "${join(appDir, "pi")}" "$@"\n`, "utf8");
			chmodSync(targetBin, 0o755);
		}
		return true;
	} catch {
		return false;
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

export async function performGithubSelfUpdate(
	currentVersion: string,
	onProgress?: (stage: string) => void,
): Promise<{ updated: boolean; version: string; shortSha?: string; message: string }> {
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

	if (await tryUpdateFromPrebuiltRelease(installRoot, headers, onProgress)) {
		writeInstalledSha(newSha, newVer);
		return {
			updated: true,
			version: newVer,
			shortSha: newSha.slice(0, 7),
			message: `Updated to prebuilt v${newVer} (${newSha.slice(0, 7)}). Restart pi-awesome to use the new build.`,
		};
	}

	const srcDir = join(installRoot, "src");
	if (!existsSync(srcDir)) {
		throw new Error("Prebuilt release unavailable and local source directory not found. Run the installer script.");
	}

	const tempDir = join(tmpdir(), `pi-awesome-update-${Date.now()}`);
	mkdirSync(tempDir, { recursive: true });

	try {
		onProgress?.("Downloading source update from GitHub...");
		const isWin = process.platform === "win32";
		const archiveUrl = isWin ? GITHUB_ZIP_URL : GITHUB_TARBALL_URL;
		const archivePath = join(tempDir, isWin ? "update.zip" : "update.tar.gz");

		const res = await fetch(archiveUrl, { headers, signal: AbortSignal.timeout(60_000) });
		if (!res.ok) {
			throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
		}
		writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));

		onProgress?.("Extracting source update...");
		const extractDir = join(tempDir, "extracted");
		mkdirSync(extractDir, { recursive: true });
		if (isWin) {
			await runCommand(
				"powershell.exe",
				["-NoProfile", "-Command", `Expand-Archive -Path '${archivePath}' -DestinationPath '${extractDir}' -Force`],
				tempDir,
			);
			const entries = execFileSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-Command",
					`(Get-ChildItem -Path '${extractDir}' -Directory | Select-Object -First 1).FullName`,
				],
				{ encoding: "utf8" },
			).trim();
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
		await runCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], srcDir);
		await runCommand("npm", ["run", "hydrate:model-data"], srcDir).catch(() => {});
		await runCommand("npm", ["run", "build:offline"], srcDir);

		writeInstalledSha(newSha, newVer);
		return {
			updated: true,
			version: newVer,
			shortSha: newSha.slice(0, 7),
			message: `Updated to ${newVer} (${newSha.slice(0, 7)}). Restart pi-awesome to apply.`,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}
