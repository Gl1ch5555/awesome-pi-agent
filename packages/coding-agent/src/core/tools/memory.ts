import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { applyMemoryOperations, type MemoryOperation, type MemoryTarget } from "../memory-store.ts";
import { memoryRenderers } from "./renderers/memory.ts";

const memoryOperationSchema = Type.Object({
	action: Type.Union([Type.Literal("add"), Type.Literal("patch"), Type.Literal("remove")], {
		description: "Operation type: add a new durable fact/note, patch an existing entry, or remove a stale entry.",
	}),
	content: Type.Optional(
		Type.String({
			description: "Required for 'add' and 'patch'. Concise declarative fact (no dates or session logs).",
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
			"'project' = current repo conventions, build/test commands & pitfalls; 'memory' = cross-project environment notes & tool quirks; 'user' = who the user is, communication style & standing preferences.",
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
			"Save durable facts across sessions, loaded into each new session's context. " +
			"Call immediately when the user explicitly asks you to remember something or states a standing preference ('always', 'from now on', 'never'). " +
			"Route each fact to ONE store only: 'project' (current repo rules, commands, pitfalls), 'memory' (global environment notes), or 'user' (user profile & preferences). " +
			"Write declarative facts ('User prefers concise responses'), not directives ('Always respond concisely').",
		promptSnippet: "Save durable cross-session facts, project rules, or user preferences when asked to remember",
		promptGuidelines: [
			"Use memory when the user explicitly asks to remember something or states a lasting preference; periodic background review handles automatic reflection.",
			"Write compact declarative facts (e.g. 'User prefers concise Russian replies', not 'Always reply concisely in Russian'), one fact per store, with no dates or session logs.",
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
