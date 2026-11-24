import type { ThemeAccent, TuiStyle } from "../../../core/settings-schema.ts";

export type UiPackId = "pi-graphite" | "claude-code" | "sageveil" | "tokyo-opentui" | "catppuccin-rounded";

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
		description: "Claude Code look: terracotta #d77757, > prompt, ∴ Thinking, compact tools",
		theme: "claude-code",
		themeAccent: "default",
		tuiStyle: "claude-code",
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
