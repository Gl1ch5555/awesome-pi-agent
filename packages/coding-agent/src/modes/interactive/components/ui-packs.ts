import type { ThemeAccent, TuiStyle } from "../../../core/settings-schema.ts";

export type UiPackId =
	| "pi-graphite"
	| "claude-code"
	| "codex-cli"
	| "opencode"
	| "kiro-cli"
	| "gemini-cli"
	| "sageveil"
	| "tokyo-opentui"
	| "catppuccin-rounded";

export interface UiPack {
	id: UiPackId;
	label: string;
	description: string;
	theme: string;
	themeAccent: ThemeAccent;
	tuiStyle: TuiStyle;
}

export const UI_PACKS: readonly UiPack[] = [
	{
		id: "pi-graphite",
		label: "pi-graphite",
		description: "Default dark graphite theme + native pi TUI",
		theme: "graphite",
		themeAccent: "default",
		tuiStyle: "native",
	},
	{
		id: "claude-code",
		label: "claude-code",
		description: "Claude Code look: terracotta #d77757, Clawd mascot, ❯ prompt, ∴ Thinking",
		theme: "claude-code",
		themeAccent: "default",
		tuiStyle: "claude-code",
	},
	{
		id: "codex-cli",
		label: "codex-cli",
		description: "OpenAI Codex CLI look: #63A8F8 blue, >_ header, › prompt, • bullet",
		theme: "codex-cli",
		themeAccent: "default",
		tuiStyle: "codex-cli",
	},
	{
		id: "opencode",
		label: "opencode",
		description: "OpenCode look: #fab283 peach, open/code ASCII, ┃ split-border prompt",
		theme: "opencode",
		themeAccent: "default",
		tuiStyle: "opencode",
	},
	{
		id: "kiro-cli",
		label: "kiro-cli",
		description: "Kiro CLI look: #b080ff violet, ▎ left-bar messages, compact Kiro footer",
		theme: "kiro-cli",
		themeAccent: "default",
		tuiStyle: "kiro-cli",
	},
	{
		id: "gemini-cli",
		label: "gemini-cli",
		description: "Google Gemini CLI look: #87AFFF/#D7AFFF palette, ✦ GEMINI, > prompt",
		theme: "gemini-cli",
		themeAccent: "default",
		tuiStyle: "gemini-cli",
	},
	{
		id: "sageveil",
		label: "sageveil",
		description: "Graphite + sage accent + pill status bar",
		theme: "graphite",
		themeAccent: "sage",
		tuiStyle: "sageveil",
	},
	{
		id: "tokyo-opentui",
		label: "tokyo-opentui",
		description: "Tokyo Night + cyan accent + rounded OpenTUI editor",
		theme: "tokyo-night",
		themeAccent: "cyan",
		tuiStyle: "opentui",
	},
	{
		id: "catppuccin-rounded",
		label: "catppuccin-rounded",
		description: "Catppuccin Mocha + violet accent + rounded compact layout",
		theme: "catppuccin-mocha",
		themeAccent: "violet",
		tuiStyle: "rounded",
	},
] as const;

export function getUiPackById(id: string): UiPack | undefined {
	return UI_PACKS.find((pack) => pack.id === id);
}

export function detectUiPack(theme: string, themeAccent: ThemeAccent, tuiStyle: TuiStyle): UiPackId | "custom" {
	const match = UI_PACKS.find(
		(pack) => pack.theme === theme && pack.themeAccent === themeAccent && pack.tuiStyle === tuiStyle,
	);
	return match ? match.id : "custom";
}
