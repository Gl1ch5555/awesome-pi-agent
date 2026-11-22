import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import { processImage } from "./image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "./mime.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export interface PendingImageAttachment {
	path: string;
	temporary?: boolean;
}

export function normalizePastedFilePathCandidate(raw: string, cwd: string): string | undefined {
	let candidate = raw.trim();
	if (!candidate) return undefined;

	// Strip PowerShell drag-and-drop call operator prefix (e.g. & 'C:\path\img.png')
	if (/^&\s+['"]/.test(candidate)) {
		candidate = candidate.replace(/^&\s+/, "").trim();
	}

	// Strip matching surrounding quotes (common when copying paths on Windows Explorer or dragging files)
	if (
		(candidate.startsWith('"') && candidate.endsWith('"')) ||
		(candidate.startsWith("'") && candidate.endsWith("'"))
	) {
		candidate = candidate.slice(1, -1).trim();
	}

	if (!candidate) return undefined;

	if (candidate.startsWith("file://")) {
		try {
			candidate = fileURLToPath(candidate);
		} catch {
			return undefined;
		}
	}

	// Unescape backslash-escaped spaces on POSIX shells (e.g. /path/my\ image.png)
	if (process.platform !== "win32" && candidate.includes("\\ ")) {
		candidate = candidate.replace(/\\ /g, " ");
	}

	if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) {
		candidate = resolve(homedir(), candidate.slice(2));
	} else if (!isAbsolute(candidate)) {
		candidate = resolve(cwd, candidate);
	}

	return candidate;
}

export function tryResolveImagePath(raw: string, cwd: string): string | undefined {
	if (raw.includes("\n") || raw.includes("\r")) return undefined;
	const resolved = normalizePastedFilePathCandidate(raw, cwd);
	if (!resolved) return undefined;
	const ext = extname(resolved).toLowerCase();
	if (!IMAGE_EXTENSIONS.has(ext)) return undefined;
	try {
		if (!existsSync(resolved)) return undefined;
		const st = statSync(resolved);
		if (!st.isFile() || st.size === 0) return undefined;
		return resolved;
	} catch {
		return undefined;
	}
}

export function extractMultipleImagePathsFromText(raw: string, cwd: string): string[] | undefined {
	const lines = raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	const resolved: string[] = [];
	for (const line of lines) {
		const path = tryResolveImagePath(line, cwd);
		if (!path) return undefined;
		resolved.push(path);
	}
	return resolved.length > 0 ? resolved : undefined;
}

export async function loadImageAttachment(
	filePath: string,
	options: { autoResizeImages: boolean },
): Promise<ImageContent | undefined> {
	if (!existsSync(filePath)) return undefined;
	const mimeType = (await detectSupportedImageMimeTypeFromFile(filePath)) ?? "image/png";
	const bytes = await readFile(filePath);
	if (bytes.length === 0) return undefined;
	const processed = await processImage(bytes, mimeType, { autoResizeImages: options.autoResizeImages });
	if (!processed.ok) return undefined;
	return {
		type: "image",
		mimeType: processed.mimeType,
		data: processed.data,
	};
}

/**
 * Resolve `(image)` tokens in prompt text against pending attachments (and also detect inline raw image paths),
 * returning clean text with `(image)` markers and loaded `ImageContent[]` attachments.
 */
export async function resolvePromptImages(
	rawText: string,
	attachments: PendingImageAttachment[],
	options: { cwd: string; autoResizeImages: boolean; blockImages: boolean },
): Promise<{ text: string; images: ImageContent[]; errors: string[] }> {
	const images: ImageContent[] = [];
	const errors: string[] = [];
	if (options.blockImages) {
		return { text: rawText, images, errors };
	}

	let attachmentCursor = 0;
	// Replace each `(image)` placeholder in order with its corresponding attachment
	const tokenRegex = /\(image(?:\s*#\d+)?\)/gi;
	const matches = [...rawText.matchAll(tokenRegex)];
	for (const _m of matches) {
		const item = attachments[attachmentCursor++];
		if (!item) break;
		const loaded = await loadImageAttachment(item.path, { autoResizeImages: options.autoResizeImages });
		if (loaded) {
			images.push(loaded);
		} else {
			errors.push(`Could not load image: ${item.path}`);
		}
	}

	// Also detect any remaining quoted or unquoted image file paths directly in the prompt text
	let text = rawText;
	const pathRegex =
		/(?:"([^"\r\n]+\.(?:png|jpe?g|webp|gif|bmp))"|'([^'\r\n]+\.(?:png|jpe?g|webp|gif|bmp))'|((?:file:\/\/\/|[A-Za-z]:[\\/]|\/|~\/)[^\s\r\n"'<>]+\.(?:png|jpe?g|webp|gif|bmp)))/gi;
	const replacements: Array<{ full: string; start: number; end: number; resolvedPath: string }> = [];
	for (const m of text.matchAll(pathRegex)) {
		const rawMatch = m[1] ?? m[2] ?? m[3];
		if (!rawMatch || m.index === undefined) continue;
		const resolvedPath = tryResolveImagePath(rawMatch, options.cwd);
		if (resolvedPath) {
			replacements.push({
				full: m[0],
				start: m.index,
				end: m.index + m[0].length,
				resolvedPath,
			});
		}
	}

	if (replacements.length > 0) {
		for (const rep of replacements) {
			const loaded = await loadImageAttachment(rep.resolvedPath, { autoResizeImages: options.autoResizeImages });
			if (loaded) {
				images.push(loaded);
			} else {
				errors.push(`Could not load image: ${rep.resolvedPath}`);
			}
		}
		// Replace from end to start so indices stay valid
		for (let i = replacements.length - 1; i >= 0; i--) {
			const rep = replacements[i]!;
			text = `${text.slice(0, rep.start)}(image)${text.slice(rep.end)}`;
		}
	}

	return { text, images, errors };
}
