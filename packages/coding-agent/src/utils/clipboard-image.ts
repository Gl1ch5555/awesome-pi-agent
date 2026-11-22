import { getNativeClipboard } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runClipboardCommand } from "./clipboard-command.ts";
import { detectSupportedImageMimeType } from "./mime.ts";
import { loadPhoton } from "./photon.ts";
import { isWSL } from "./wsl.ts";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * Convert unsupported image formats to PNG using Photon.
 * Returns null if conversion is unavailable or fails.
 */
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

// Undefined means the backend failed; null means it has no image. An empty
// Wayland clipboard must not fall through to stale X11 clipboard contents.
async function readClipboardImageViaWlPaste(): Promise<ClipboardImage | null | undefined> {
	const list = await runClipboardCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (list === undefined) return undefined;

	const types = list
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	const data = await runClipboardCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;

	return { bytes: data, mimeType: baseMimeType(selectedType) };
}

/**
 * On WSL, the Linux clipboard (Wayland/X11) does not receive image data from
 * Windows screenshots (Win+Shift+S). PowerShell can access the Windows clipboard
 * directly, so we use it as a fallback.
 */
function buildWindowsClipboardImageScript(psQuotedPath: string): string {
	return [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		`$path = '${psQuotedPath}'`,
		"$saved = $false",
		"try {",
		"  $png = [System.Windows.Forms.Clipboard]::GetData('PNG')",
		"  if ($png -is [System.IO.MemoryStream]) {",
		"    [System.IO.File]::WriteAllBytes($path, $png.ToArray())",
		"    $saved = $true",
		"  } elseif ($png -is [byte[]]) {",
		"    [System.IO.File]::WriteAllBytes($path, $png)",
		"    $saved = $true",
		"  }",
		"} catch {}",
		"if (-not $saved) {",
		"  $img = [System.Windows.Forms.Clipboard]::GetImage()",
		"  if ($img) {",
		"    try { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $saved = $true } finally { $img.Dispose() }",
		"  }",
		"}",
		"if ($saved) { Write-Output 'ok' } else { Write-Output 'empty' }",
	].join("; ");
}

async function readClipboardImageViaPowerShell(): Promise<ClipboardImage | null> {
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.png`);

	try {
		const winPathResult = await runClipboardCommand("wslpath", ["-w", tmpFile], {
			timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
		});
		if (winPathResult === undefined) {
			return null;
		}

		const winPath = winPathResult.toString("utf-8").trim();
		if (!winPath) {
			return null;
		}

		const psQuotedWinPath = winPath.replaceAll("'", "''");
		const psScript = buildWindowsClipboardImageScript(psQuotedWinPath);

		const result = await runClipboardCommand("powershell.exe", ["-NoProfile", "-STA", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		if (result === undefined) {
			return null;
		}

		const output = result.toString("utf-8").trim();
		if (output !== "ok") {
			return null;
		}

		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) {
			return null;
		}

		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
}

async function readClipboardImageViaXclip(): Promise<ClipboardImage | null | undefined> {
	const targets = await runClipboardCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	if (targets === undefined) return undefined;

	const candidateTypes = targets
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);
	const preferred = selectPreferredImageMimeType(candidateTypes);
	if (!preferred) return null;

	const data = await runClipboardCommand("xclip", ["-selection", "clipboard", "-t", preferred, "-o"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;
	return { bytes: data, mimeType: baseMimeType(preferred) };
}

async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null | undefined> {
	const bytes = await getNativeClipboard()?.getImage();
	if (bytes === undefined) return undefined;
	if (!bytes?.length) return null;
	return { bytes, mimeType: detectSupportedImageMimeType(bytes) ?? "application/octet-stream" };
}

async function readClipboardImageViaNativePowerShell(): Promise<ClipboardImage | null> {
	const tmpFile = join(tmpdir(), `pi-win-clip-${randomUUID()}.png`);
	try {
		const psQuotedPath = tmpFile.replaceAll("'", "''");
		const psScript = buildWindowsClipboardImageScript(psQuotedPath);
		const shells = ["powershell.exe", "pwsh.exe"] as const;
		for (const shell of shells) {
			const result = await runClipboardCommand(shell, ["-NoProfile", "-STA", "-Command", psScript], {
				timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
			});
			if (result === undefined) continue;
			if (result.toString("utf-8").trim() !== "ok") return null;
			const bytes = readFileSync(tmpFile);
			if (bytes.length === 0) return null;
			return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
		}
		return null;
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
}

async function readClipboardImageViaMacOS(): Promise<ClipboardImage | null> {
	// Fast path: pngpaste (if installed via Homebrew)
	const pngPasteData = await runClipboardCommand("pngpaste", ["-"], { timeoutMs: 2000 });
	if (pngPasteData && pngPasteData.length > 0) {
		return { bytes: new Uint8Array(pngPasteData), mimeType: detectSupportedImageMimeType(pngPasteData) ?? "image/png" };
	}

	// Built-in macOS fallback: AppleScript writes clipboard PNG/TIFF to a temp file
	const tmpFile = join(tmpdir(), `pi-mac-clip-${randomUUID()}.png`);
	const tmpTiff = join(tmpdir(), `pi-mac-clip-${randomUUID()}.tiff`);
	try {
		const escapedPng = tmpFile.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
		const escapedTiff = tmpTiff.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
		const script = [
			`try`,
			`  set theData to the clipboard as «class PNGf»`,
			`  set f to open for access POSIX file "${escapedPng}" with write permission`,
			`  set eof of f to 0`,
			`  write theData to f`,
			`  close access f`,
			`  return "png"`,
			`on error`,
			`  try`,
			`    set theData to the clipboard as TIFF picture`,
			`    set f to open for access POSIX file "${escapedTiff}" with write permission`,
			`    set eof of f to 0`,
			`    write theData to f`,
			`    close access f`,
			`    return "tiff"`,
			`  on error`,
			`    return "empty"`,
			`  end try`,
			`end try`,
		].join("\n");
		const out = await runClipboardCommand("osascript", ["-e", script], { timeoutMs: 3000 });
		const kind = out?.toString("utf-8").trim();
		if (kind === "png") {
			const bytes = readFileSync(tmpFile);
			if (bytes.length > 0) return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
		} else if (kind === "tiff") {
			const converted = await runClipboardCommand("sips", ["-s", "format", "png", tmpTiff, "--out", tmpFile], {
				timeoutMs: 3000,
			});
			if (converted !== undefined) {
				const bytes = readFileSync(tmpFile);
				if (bytes.length > 0) return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
			}
		}
		return null;
	} catch {
		return null;
	} finally {
		for (const f of [tmpFile, tmpTiff]) {
			try {
				unlinkSync(f);
			} catch {
				// ignore
			}
		}
	}
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	if (env.TERMUX_VERSION) {
		return null;
	}

	let image: ClipboardImage | null | undefined;

	if (platform === "linux") {
		const wsl = isWSL(env);
		if (isWaylandSession(env) || wsl) {
			image = await readClipboardImageViaWlPaste();
		}
		if (image === undefined) image = await readClipboardImageViaXclip();
		// Preserve Linux's empty/unavailable distinction if Windows has no image.
		if (!image && wsl) image = (await readClipboardImageViaPowerShell()) ?? image;
		if (image === undefined) image = await readClipboardImageViaNativeClipboard();
	} else if (platform === "win32") {
		image = await readClipboardImageViaNativeClipboard();
		if (!image) image = await readClipboardImageViaNativePowerShell();
	} else if (platform === "darwin") {
		image = await readClipboardImageViaNativeClipboard();
		if (!image) image = await readClipboardImageViaMacOS();
	} else {
		image = await readClipboardImageViaNativeClipboard();
	}

	if (!image) {
		return null;
	}

	// Convert unsupported formats (e.g., Windows DIB data wrapped as BMP) to PNG
	if (!isSupportedImageMimeType(image.mimeType)) {
		const sniffed = detectSupportedImageMimeType(image.bytes);
		if (sniffed) {
			return { bytes: image.bytes, mimeType: sniffed };
		}
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}
