import { applyEditsToNormalizedContent, type Edit, type TextReplacement } from "./edit-diff.ts";

const HASHLINE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface HashlineEdit {
	oldText?: string;
	anchor?: string;
	endAnchor?: string;
	newText: string;
}

/**
 * Deterministic 2-character hash of a single line (without trailing CR).
 * Uses 32-char Crockford-like alphabet without ambiguous 0/O/1/I.
 */
export function computeLineHash(line: string): string {
	const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
	let hash = 0x811c9dc5;
	for (let i = 0; i < clean.length; i++) {
		hash ^= clean.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const c1 = HASHLINE_ALPHABET[(hash >>> 5) & 31]!;
	const c2 = HASHLINE_ALPHABET[hash & 31]!;
	return `${c1}${c2}`;
}

export function formatLinesWithHash(content: string, startLine = 1): string {
	const lines = content.split("\n");
	return lines.map((line, idx) => `${startLine + idx}#${computeLineHash(line)}: ${line}`).join("\n");
}

export function parseHashlineAnchor(raw: string): { line: number; hash: string } | undefined {
	const match = raw.trim().match(/^(\d+)#([A-Za-z0-9]{2})$/);
	if (!match) return undefined;
	const line = Number(match[1]);
	if (!Number.isSafeInteger(line) || line < 1) return undefined;
	return { line, hash: match[2]!.toUpperCase() };
}

function parseAnchorRangeFromOldText(
	raw: string,
): { start: { line: number; hash: string }; end?: { line: number; hash: string } } | undefined {
	const trimmed = raw.trim();
	const rangeMatch = trimmed.match(/^(\d+#[A-Za-z0-9]{2})\s*(?:\.\.|-)\s*(\d+#[A-Za-z0-9]{2})$/);
	if (rangeMatch) {
		const start = parseHashlineAnchor(rangeMatch[1]!);
		const end = parseHashlineAnchor(rangeMatch[2]!);
		if (start && end) return { start, end };
	}
	const single = parseHashlineAnchor(trimmed);
	if (single) return { start: single };
	return undefined;
}

export function applyHashlineOrExactEdits(
	normalizedContent: string,
	edits: ReadonlyArray<HashlineEdit>,
	path: string,
): { baseContent: string; newContent: string; replacements: TextReplacement[] } {
	const hasAnyAnchor = edits.some(
		(e) => typeof e.anchor === "string" || (typeof e.oldText === "string" && parseAnchorRangeFromOldText(e.oldText) !== undefined),
	);
	if (!hasAnyAnchor) {
		const exactEdits: Edit[] = edits.map((e) => ({
			oldText: e.oldText ?? "",
			newText: e.newText,
		}));
		return applyEditsToNormalizedContent(normalizedContent, exactEdits, path);
	}

	const lines = normalizedContent.split("\n");
	const lineStarts: number[] = new Array(lines.length);
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		lineStarts[i] = offset;
		offset += lines[i]!.length + 1; // +1 for '\n'
	}

	const replacements: TextReplacement[] = [];

	for (let idx = 0; idx < edits.length; idx++) {
		const edit = edits[idx]!;
		let startRef = edit.anchor ? parseHashlineAnchor(edit.anchor) : undefined;
		let endRef = edit.endAnchor ? parseHashlineAnchor(edit.endAnchor) : undefined;

		if (!startRef && typeof edit.oldText === "string") {
			const parsed = parseAnchorRangeFromOldText(edit.oldText);
			if (parsed) {
				startRef = parsed.start;
				endRef = parsed.end ?? endRef;
			}
		}

		if (startRef) {
			if (startRef.line > lines.length) {
				throw new Error(
					`Hashline anchor ${startRef.line}#${startRef.hash} is out of bounds in ${path} (${lines.length} lines).`,
				);
			}
			const startLineText = lines[startRef.line - 1]!;
			const actualStartHash = computeLineHash(startLineText);
			if (actualStartHash !== startRef.hash) {
				throw new Error(
					`Hashline mismatch in ${path} at line ${startRef.line}: expected ${startRef.line}#${startRef.hash}, got ${startRef.line}#${actualStartHash} ("${startLineText.trim().slice(0, 60)}"). Re-read and retry.`,
				);
			}
			const endLine = endRef ? endRef.line : startRef.line;
			if (endRef) {
				if (endRef.line < startRef.line || endRef.line > lines.length) {
					throw new Error(
						`Hashline endAnchor ${endRef.line}#${endRef.hash} is invalid in ${path} (start line ${startRef.line}, total ${lines.length}).`,
					);
				}
				const endLineText = lines[endRef.line - 1]!;
				const actualEndHash = computeLineHash(endLineText);
				if (actualEndHash !== endRef.hash) {
					throw new Error(
						`Hashline mismatch in ${path} at line ${endRef.line}: expected ${endRef.line}#${endRef.hash}, got ${endRef.line}#${actualEndHash} ("${endLineText.trim().slice(0, 60)}"). Re-read and retry.`,
					);
				}
			}

			const matchIndex = lineStarts[startRef.line - 1]!;
			const lastLineIdx = endLine - 1;
			const matchEnd = lineStarts[lastLineIdx]! + lines[lastLineIdx]!.length;
			replacements.push({
				matchIndex,
				matchLength: matchEnd - matchIndex,
				newText: edit.newText,
			});
		} else {
			// Exact oldText fallback in mixed edit arrays
			const oldText = edit.oldText ?? "";
			const single = applyEditsToNormalizedContent(normalizedContent, [{ oldText, newText: edit.newText }], path);
			replacements.push(...single.replacements);
		}
	}

	replacements.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < replacements.length; i++) {
		const prev = replacements[i - 1]!;
		const curr = replacements[i]!;
		if (prev.matchIndex + prev.matchLength > curr.matchIndex) {
			throw new Error(`Overlapping edits in ${path}. Merge nearby changes into a single edit.`);
		}
	}

	const parts: string[] = [];
	let pos = 0;
	for (const r of replacements) {
		parts.push(normalizedContent.slice(pos, r.matchIndex));
		parts.push(r.newText);
		pos = r.matchIndex + r.matchLength;
	}
	parts.push(normalizedContent.slice(pos));

	return {
		baseContent: normalizedContent,
		newContent: parts.join(""),
		replacements,
	};
}
