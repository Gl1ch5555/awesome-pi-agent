import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import { getTextOutput, invalidArgText, str } from "../render-utils.ts";

function formatOutputLines(
	output: string,
	options: ToolRenderResultOptions,
	theme: Theme,
	collapsedLimit = 12,
): string {
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : collapsedLimit;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return text;
}

export const webSearchRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(rawArgs: unknown, theme: Theme) {
		const args = rawArgs as { query?: string; provider?: string } | undefined;
		const query = str(args?.query);
		const provider = str(args?.provider);
		let text = theme.fg("toolTitle", theme.bold("web_search")) + " ";
		text += query === null ? invalidArgText(theme) : theme.fg("accent", `"${query || ""}"`);
		if (provider) text += theme.fg("muted", ` [${provider}]`);
		return new Text(text, 0, 0);
	},
	renderResult(result, options, theme) {
		const output = getTextOutput(result, false).trim();
		return new Text(formatOutputLines(output, options, theme, 12), 0, 0);
	},
};

export const webFetchRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(rawArgs: unknown, theme: Theme) {
		const args = rawArgs as { url?: string } | undefined;
		const url = str(args?.url);
		const text =
			theme.fg("toolTitle", theme.bold("web_fetch")) +
			" " +
			(url === null ? invalidArgText(theme) : theme.fg("accent", url || ""));
		return new Text(text, 0, 0);
	},
	renderResult(result, options, theme) {
		const output = getTextOutput(result, false).trim();
		return new Text(formatOutputLines(output, options, theme, 10), 0, 0);
	},
};
