import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath, shortenHomePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";
import type { ToolRenderContext } from "../extensions/types.ts";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	return shortenHomePath(path);
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function parseLineNumber(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim() !== "") value = Number(value);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Format finite numbers or numeric strings as a read line range, omitting malformed ranges. */
export function formatReadLineRange(offset: unknown, limit: unknown): string {
	// Strict schemas represent omitted optional arguments as null.
	if (offset == null && limit == null) return "";
	const start = offset == null ? 1 : parseLineNumber(offset);
	if (start === undefined) return "";
	if (limit == null) return `:${start}`;
	const count = parseLineNumber(limit);
	if (count === undefined) return "";
	const end = start + count - 1;
	return `:${start}${end ? `-${end}` : ""}`;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

const COLLAPSED_ARGS_CHARS = 100;

/**
 * Generic tool call header: the title followed by the arguments. Collapsed, they are `key=value`
 * pairs on the title line, cut to {@link COLLAPSED_ARGS_CHARS}. Expanded, each is a `key: value`
 * line below the title, with strings shown raw and continuation lines indented.
 */
export function formatToolCallWithArgs(title: string, args: unknown, theme: Theme, expanded: boolean): string {
	const header = theme.fg("toolTitle", theme.bold(title));
	if (args == null) return header;
	const entries =
		typeof args === "object" && !Array.isArray(args)
			? Object.entries(args)
			: ([["args", args]] as [string, unknown][]);
	if (entries.length === 0) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			return `  ${key}: ${replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ")}`;
		});
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	return `${header} ${theme.fg("muted", preview)}`;
}

/** Duration as `4.2s` below a minute, then `1m 30s` and `2h 3m 4s`. */
export function formatToolDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;

	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** Integer-seconds duration as `12s` below a minute, then `1m 30s` and `2h 3m 4s`. */
export function formatCountdownSeconds(totalSeconds: number): string {
	const safeSeconds = Math.max(0, Math.floor(totalSeconds));
	if (safeSeconds < 60) return `${safeSeconds}s`;

	const minutes = Math.floor(safeSeconds / 60);
	const remainder = safeSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;

	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** Renderer state of {@link startToolTimer} and {@link toolTimerText}, kept in `ToolRenderContext.state`. */
interface ToolTimerState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

/** Start the row's clock once execution starts. Call from `renderCall`. */
export function startToolTimer(context: ToolRenderContext<ToolTimerState>): void {
	const state = context.state;
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
}

/**
 * The row's timing line, from `renderResult`: `Elapsed 4.2s` while the result is partial, redrawn
 * every second, and `Took 4.2s` once it is final. Undefined when the row has no start time and no
 * recorded duration.
 */
export function toolTimerText(context: ToolRenderContext<ToolTimerState>, isPartial: boolean): string | undefined {
	const state = context.state;
	if (state.startedAt !== undefined && isPartial && !state.interval) {
		state.interval = setInterval(() => context.invalidate(), 1000);
	}
	if (!isPartial || context.isError) {
		state.endedAt ??= Date.now();
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}
	// A final result's recorded duration wins: it is monotonic and survives reloads. The renderer's own clock is the
	// fallback for live progress and for results stored without one.
	if (!isPartial && context.durationMs !== undefined) return `Took ${formatToolDuration(context.durationMs)}`;
	if (state.startedAt === undefined) return undefined;
	const endTime = state.endedAt ?? Date.now();
	return `${isPartial ? "Elapsed" : "Took"} ${formatToolDuration(endTime - state.startedAt)}`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function extractLiveProgress(output: string): { percent?: number; stage?: string } {
	const lines = output
		.split(/\r?\n/)
		.map((line) => stripAnsi(line).trim())
		.filter((line) => line.length > 0 && !/^[-=_─━│┃┌┐└┘]+$/.test(line));
	let percent: number | undefined;
	for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
		const line = lines[i]!;
		const pctMatch = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
		if (pctMatch) {
			const val = Number(pctMatch[1]);
			if (Number.isFinite(val) && val >= 0 && val <= 100) {
				percent = Math.round(val);
				break;
			}
		}
		const ratioMatch = line.match(/\[(\d+)\s*\/\s*(\d+)\]/);
		if (ratioMatch) {
			const cur = Number(ratioMatch[1]);
			const total = Number(ratioMatch[2]);
			if (Number.isFinite(cur) && Number.isFinite(total) && total > 0 && cur <= total) {
				percent = Math.round((cur / total) * 100);
				break;
			}
		}
	}
	const lastLine = lines[lines.length - 1];
	const stage = lastLine ? (lastLine.length > 64 ? `${lastLine.slice(0, 61)}...` : lastLine) : undefined;
	return { percent, stage };
}

export function formatLiveStatusBar(
	theme: Theme,
	options: { percent?: number; stage?: string; timerText?: string; nowMs?: number },
): string {
	const now = options.nowMs ?? Date.now();
	const tick = Math.floor(now / 180);
	const spinner = theme.fg("accent", SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!);

	let bar: string;
	if (typeof options.percent === "number" && Number.isFinite(options.percent)) {
		const pct = Math.max(0, Math.min(100, Math.round(options.percent)));
		const width = 14;
		const filled = Math.round((pct / 100) * width);
		const track = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
		bar = `${theme.fg("accent", `[${track}]`)} ${theme.fg("toolTitle", `${pct}%`)}`;
	} else {
		const width = 9;
		const cycle = (width - 1) * 2;
		const posRaw = tick % cycle;
		const pos = posRaw < width ? posRaw : cycle - posRaw;
		const track = `${"─".repeat(pos)}●${"─".repeat(width - 1 - pos)}`;
		bar = theme.fg("muted", `[${track}]`);
	}

	const parts = [spinner, bar];
	if (options.stage) parts.push(theme.fg("toolOutput", options.stage));
	if (options.timerText) parts.push(theme.fg("dim", options.timerText));
	return parts.join(" ");
}

export function startSmoothProgressTimer(context: ToolRenderContext<ToolTimerState>, isPartial: boolean): void {
	const state = context.state;
	if (state.startedAt !== undefined && isPartial && !state.interval) {
		state.interval = setInterval(() => context.invalidate(), 200);
	}
}

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export const TOOL_LABEL_DESCRIPTION =
	"REQUIRED for UI display: short human-readable summary (3-7 words, in the user's language) written FIRST before other arguments, e.g. 'Search large files on C:'. Stripped from LLM history.";

export interface LeftRailHeaderOptions {
	tag: string;
	label: string;
	isPartial?: boolean;
	isError?: boolean;
	isStreamingArgs?: boolean;
	suffix?: string;
	timerText?: string;
	nowMs?: number;
}

export function formatLeftRailPrefix(
	theme: Theme,
	options?: { isPartial?: boolean; isError?: boolean; isStreamingArgs?: boolean },
): string {
	if (options?.isError) return theme.fg("error", "┃");
	if (options?.isPartial || options?.isStreamingArgs) return theme.fg("warning", "┃");
	return theme.fg("success", "┃");
}

export function formatLeftRailHeader(theme: Theme, options: LeftRailHeaderOptions): string {
	const now = options.nowMs ?? Date.now();
	const tick = Math.floor(now / 180);
	const isActive = Boolean(options.isPartial || options.isStreamingArgs);
	const rail = formatLeftRailPrefix(theme, options);
	const icon = options.isError
		? theme.fg("error", "✗")
		: isActive
			? theme.fg("accent", SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!)
			: theme.fg("success", "✓");
	const tag = theme.fg("accent", `[${options.tag}]`);
	const title = theme.fg("toolTitle", theme.bold(options.label));
	let line = `${rail} ${icon} ${tag} ${title}`;
	if (options.suffix) line += ` ${options.suffix}`;
	if (options.timerText) line += ` ${theme.fg(isActive ? "warning" : "dim", options.timerText)}`;
	return line;
}

export function prefixLinesWithRail(
	theme: Theme,
	text: string,
	options?: { isPartial?: boolean; isError?: boolean; isStreamingArgs?: boolean },
): string {
	const rail = formatLeftRailPrefix(theme, options);
	return text
		.split("\n")
		.map((line) => `${rail} ${line}`)
		.join("\n");
}

export function summarizeShellCommandFallback(command: string): string {
	let clean = command.replace(/\r/g, "").trim();
	// Strip outer powershell.exe -NoProfile -Command "..." or bash -lc "..." wrappers
	clean = clean.replace(/^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-\w+\s+)*-Command\s+["']?/i, "");
	clean = clean.replace(/^(?:bash|sh|zsh)\s+-(?:l|c|lc)\s+["']?/i, "");
	clean = clean.replace(/["']\s*$/, "");
	clean = clean.replace(/\s+/g, " ").trim();
	if (!clean) return "Running command...";
	return clean.length > 72 ? `${clean.slice(0, 69)}...` : clean;
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
