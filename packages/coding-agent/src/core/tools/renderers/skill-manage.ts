import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { SkillManageInput } from "../../skill-store.ts";
import type { SkillManageToolDetails } from "../skill-manage.ts";

export const skillManageRenderers: Pick<
	ToolDefinition<any, SkillManageToolDetails | undefined>,
	"renderCall" | "renderResult"
> = {
	renderCall(rawArgs: unknown, theme: Theme) {
		const args = rawArgs as Partial<SkillManageInput> | undefined;
		const action = args?.action ?? "patch";
		const name = args?.name ?? "...";
		const suffix = args?.file_path ? ` ${theme.fg("muted", args.file_path)}` : "";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("skill_manage"))} ${theme.fg("accent", `[${action}]`)} ${theme.fg("toolOutput", name)}${suffix}`,
			0,
			0,
		);
	},
	renderResult(result, _options, theme, context) {
		if (context.isError) {
			const err = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text || "")
				.join("\n");
			return new Text(err ? `\n${theme.fg("error", err)}` : "", 0, 0);
		}
		const details = result.details as SkillManageToolDetails | undefined;
		if (!details) return new Text("", 0, 0);
		return new Text(`\n${theme.fg("muted", details.summary)}`, 0, 0);
	},
};
