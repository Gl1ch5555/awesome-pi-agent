import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { AskQuestionsToolDetails } from "../ask-questions.ts";

export const askQuestionsRenderers: Pick<
	ToolDefinition<any, AskQuestionsToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	renderCall(rawArgs: unknown, theme: Theme) {
		const args = rawArgs as { title?: unknown; questions?: unknown[] } | undefined;
		const count = Array.isArray(args?.questions) ? args.questions.length : 0;
		const title = typeof args?.title === "string" && args.title.trim() ? ` ${theme.fg("muted", args.title.trim())}` : "";
		const badge = count > 0 ? ` ${theme.fg("accent", `[${count}q]`)}` : "";
		return new Text(`${theme.fg("toolTitle", theme.bold("ask_questions"))}${badge}${title}`, 0, 0);
	},
	renderResult(result, { expanded }, theme, context) {
		if (context.isError) {
			const err = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text || "")
				.join("\n");
			return new Text(err ? `\n${theme.fg("error", err)}` : "", 0, 0);
		}
		const details = result.details as AskQuestionsToolDetails | undefined;
		if (!details) return new Text("", 0, 0);
		if (details.cancelled) {
			return new Text(`\n${theme.fg("muted", "Cancelled")}`, 0, 0);
		}
		const header = theme.fg("muted", `Answered ${details.answered}/${details.total}`);
		if (!expanded || details.summaryLines.length === 0) {
			return new Text(`\n${header}`, 0, 0);
		}
		const lines = details.summaryLines.map((line) => theme.fg("toolOutput", line));
		return new Text(`\n${header}\n${lines.join("\n")}`, 0, 0);
	},
};
