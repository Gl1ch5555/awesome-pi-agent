import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { applySkillManage, type SkillManageAction, type SkillManageInput } from "../skill-store.ts";
import { skillManageRenderers } from "./renderers/skill-manage.ts";

const skillManageSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("patch"),
			Type.Literal("write_file"),
			Type.Literal("remove_file"),
			Type.Literal("delete"),
		],
		{
			description: "Operation to perform on a skill.",
		},
	),
	name: Type.String({
		description: "Skill identifier (lowercase letters, digits, hyphens, underscores; max 64 chars).",
	}),
	category: Type.Optional(
		Type.String({
			description: "Optional category subdirectory for action='create' (e.g. 'devops').",
		}),
	),
	content: Type.Optional(
		Type.String({
			description: "Full SKILL.md markdown (YAML frontmatter + body) for create or full-file patch.",
		}),
	),
	old_string: Type.Optional(
		Type.String({
			description: "Exact text to replace for action='patch'.",
		}),
	),
	new_string: Type.Optional(
		Type.String({
			description: "Replacement text for action='patch'.",
		}),
	),
	replace_all: Type.Optional(
		Type.Boolean({
			description: "Replace all occurrences of old_string during action='patch'.",
		}),
	),
	file_path: Type.Optional(
		Type.String({
			description: "Relative supporting path (references/, templates/, scripts/, assets/) for write_file/remove_file/patch.",
		}),
	),
	file_content: Type.Optional(
		Type.String({
			description: "Supporting file contents for action='write_file'.",
		}),
	),
});

export interface SkillManageToolDetails {
	action: SkillManageAction;
	name: string;
	summary: string;
	filePath?: string;
}

export interface SkillManageToolOptions {
	getAgentDir?: () => string;
	onUpdated?: () => void;
}

export function createSkillManageToolDefinition(
	options?: SkillManageToolOptions,
): ToolDefinition<typeof skillManageSchema, SkillManageToolDetails | undefined> {
	return {
		name: "skill_manage",
		label: "skill_manage",
		description:
			"Create, patch, or delete reusable skills (SKILL.md + references/scripts/templates) under ~/.pi/agent/skills. " +
			"Use after discovering a non-trivial workflow, multi-step procedure, or pitfall worth reusing across sessions. " +
			"Patch existing skills before creating duplicates; write concise imperative rules and verified commands, never session logs or dates.",
		promptSnippet: "Create or update reusable skills (SKILL.md) for recurring workflows and pitfalls",
		promptGuidelines: [
			"After complex or multi-step tasks, save reusable procedures, commands, and pitfalls in a skill via skill_manage (patch existing skills first).",
			"Keep skill entries concise and actionable (rules + why + verified commands), with no session dates or logs.",
		],
		parameters: skillManageSchema,
		async execute(
			_toolCallId,
			params: SkillManageInput,
			_signal?: AbortSignal,
			_onUpdate?,
			_ctx?: ExtensionContext,
		) {
			const agentDir = options?.getAgentDir?.() ?? getAgentDir();
			const result = applySkillManage(params, agentDir);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: result.error ?? "skill_manage failed" }],
					details: undefined,
					isError: true,
				};
			}
			options?.onUpdated?.();
			return {
				content: [{ type: "text", text: `${result.summary}${result.filePath ? ` (${result.filePath})` : ""}` }],
				details: {
					action: params.action,
					name: params.name,
					summary: result.summary,
					filePath: result.filePath,
				},
			};
		},
		...skillManageRenderers,
	};
}
