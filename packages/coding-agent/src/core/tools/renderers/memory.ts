import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { MemoryOperation, MemoryTarget } from "../../memory-store.ts";
import type { MemoryToolDetails } from "../memory.ts";

function formatOpLine(op: MemoryOperation, theme: Theme): string {
	if (op.action === "add") {
		const text = (op.content ?? "").trim();
		return `${theme.fg("success", "+")} ${theme.fg("toolOutput", text)}`;
	}
	if (op.action === "patch") {
		const text = (op.content ?? "").trim();
		return `${theme.fg("accent", "~")} ${theme.fg("toolOutput", text)}`;
	}
	const text = (op.old_text ?? "").trim();
	return `${theme.fg("error", "-")} ${theme.fg("muted", text)}`;
}

export const memoryRenderers: Pick<
	ToolDefinition<any, MemoryToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	renderCall(rawArgs: unknown, theme: Theme) {
		const args = rawArgs as { target?: MemoryTarget; operations?: MemoryOperation[] } | undefined;
		const target = args?.target ?? "project";
		const ops = Array.isArray(args?.operations) ? args.operations : [];
		let text = `${theme.fg("toolTitle", theme.bold("memory"))} ${theme.fg("accent", `[${target}]`)}`;
		if (ops.length > 0) {
			const lines = ops.slice(0, 6).map((op) => formatOpLine(op, theme));
			if (ops.length > 6) {
				lines.push(theme.fg("muted", `... (+${ops.length - 6} more operations)`));
			}
			text += `\n\n${lines.join("\n")}`;
		}
		return new Text(text, 0, 0);
	},
	renderResult(result, _options, theme, context) {
		if (context.isError) {
			const err = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text || "")
				.join("\n");
			return new Text(err ? `\n${theme.fg("error", err)}` : "", 0, 0);
		}
		const details = result.details as MemoryToolDetails | undefined;
		if (!details) return new Text("", 0, 0);
		return new Text(
			`\n${theme.fg("muted", `${details.entries.length} entries · ${details.chars}/${details.limit} chars`)}`,
			0,
			0,
		);
	},
};
