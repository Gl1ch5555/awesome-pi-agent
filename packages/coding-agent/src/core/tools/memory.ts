import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { applyMemoryOperations, type MemoryOperation, type MemoryTarget } from "../memory-store.ts";
import { memoryRenderers } from "./renderers/memory.ts";

const memoryOperationSchema = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("patch"), Type.Literal("remove")], {
		description: "Operation type: add a new lesson/note, patch an existing entry, or remove a stale entry.",
	}),
	content: Type.Optional(
		Type.String({
			description: "Required for 'add' and 'patch'. Concise imperative rule/fact (no dates or session logs).",
		}),
	),
	old_text: Type.Optional(
		Type.String({
			description: "Required for 'patch' (exact unique substring) and 'remove' (substring matching the entry).",
		}),
	),
});

const memorySchema = Type.Object({
	target: Type.Union([Type.Literal("project"), Type.Literal("memory"), Type.Literal("user")], {
		description:
			"'project' = mistakes, pitfalls, build/test commands & invariants for the current repo; 'memory' = cross-project environment notes; 'user' = user preferences & style.",
	}),
	operations: Type.Array(memoryOperationSchema, {
		minItems: 1,
		description: "Atomic batch of add/patch/remove edits evaluated against the target's char budget.",
	}),
});

export interface MemoryToolDetails {
	target: MemoryTarget;
	chars: number;
	limit: number;
	entries: string[];
	summary: string;
}

export interface MemoryToolOptions {
	getAgentDir?: () => string;
	onUpdated?: () => void;
}

export function createMemoryToolDefinition(
	cwd: string,
	options?: MemoryToolOptions,
): ToolDefinition<typeof memorySchema, MemoryToolDetails> {
	return {
		name: "memory",
		label: "memory",
		description:
			"Save durable self-reflection lessons, project pitfalls/mistakes, and user preferences across sessions. " +
			"Automatically record non-obvious root causes after fixing a mistake, project build/test quirks, and user corrections. " +
			"Use target='project' for repo-specific lessons, 'memory' for global environment notes, and 'user' for user preferences.",
		promptSnippet: "Record durable self-reflection lessons, project mistakes/pitfalls, and user preferences",
		promptGuidelines: [
			"Self-reflect automatically via memory when you make a mistake and discover the fix, hit a non-obvious project quirk/build/test rule, or get corrected by the user.",
			"Write compact, high-signal imperative rules with 'why' (e.g. 'Run npm run generate:schemas after editing settings-schema.ts — config-schemas.test.ts fails otherwise'), never dates or session logs.",
			"Consolidate or remove stale entries in the same operations batch if a target approaches its character limit.",
		],
		parameters: memorySchema,
		async execute(
			_toolCallId,
			params: { target: MemoryTarget; operations: MemoryOperation[] },
			_signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			const effectiveCwd = ctx?.cwd || cwd;
			const agentDir = options?.getAgentDir?.() ?? getAgentDir();
			const result = applyMemoryOperations(params.target, params.operations, {
				cwd: effectiveCwd,
				agentDir,
			});

			if (!result.ok) {
				const existingPreview =
					result.entries.length > 0
						? `\nCurrent entries (${result.chars}/${result.limit} chars):\n${result.entries.map((e) => `- ${e}`).join("\n")}`
						: `\nCurrent entries: (empty, 0/${result.limit} chars)`;
				return {
					content: [{ type: "text", text: `Error: ${result.error}${existingPreview}` }],
					isError: true,
					details: {
						target: result.target,
						chars: result.chars,
						limit: result.limit,
						entries: result.entries,
						summary: result.summary,
					},
				};
			}

			options?.onUpdated?.();

			return {
				content: [
					{
						type: "text",
						text: `Saved to ${result.target} (${result.chars}/${result.limit} chars, ${result.entries.length} entries):\n${result.summary}`,
					},
				],
				details: {
					target: result.target,
					chars: result.chars,
					limit: result.limit,
					entries: result.entries,
					summary: result.summary,
				},
			};
		},
		...memoryRenderers,
	};
}
