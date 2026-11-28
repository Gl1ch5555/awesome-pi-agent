import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	applyReplacementsToOriginal,
	generateEditDiff,
	normalizeToLF,
} from "./edit-diff.ts";
import { collectPostEditDiagnostics } from "./diagnostics.ts";
import { applyHashlineOrExactEdits, type HashlineEdit } from "./hashline.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "./tool-definition-wrapper.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.Optional(
			Type.String({
				description:
					"Exact text for one targeted replacement (or a LINE#HASH / START#HASH..END#HASH anchor). Must be unique in the original file if exact text is used.",
			}),
		),
		anchor: Type.Optional(
			Type.String({
				description: "LINE#HASH anchor from read/grep (e.g. '9#KT') to replace that line or start a range.",
			}),
		),
		endAnchor: Type.Optional(
			Type.String({
				description: "Optional inclusive end LINE#HASH anchor (e.g. '14#PQ') when replacing a multi-line range.",
			}),
		),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Prefer LINE#HASH anchors (anchor / endAnchor) from read/grep to save tokens and avoid whitespace mismatches, or provide exact oldText.",
		}),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits using LINE#HASH anchors or exact text replacement",
	guidelines: [
		"Use edit for targeted changes. Batch changes to one file in a single call.",
		"Prefer LINE#HASH anchors (e.g. anchor='9#KT', optional endAnchor='14#PQ') returned by read/grep instead of quoting large oldText blocks.",
	],
} as const;

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	anchor?: unknown;
	endAnchor?: unknown;
	newText?: unknown;
};

type SingleEditInput = HashlineEdit;

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const edit = value as Record<string, unknown>;
	return (
		(typeof edit.oldText === "string" || typeof edit.anchor === "string") &&
		typeof edit.newText === "string"
	);
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
	/** Run fast zero-token local diagnostics after edit. Default: true */
	diagnostics?: boolean;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array.
	// Others send a single edit object instead of a one-element edits array.
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.newText !== "string" || (typeof legacy.oldText !== "string" && typeof legacy.anchor !== "string")) {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({
		...(typeof legacy.oldText === "string" ? { oldText: legacy.oldText } : {}),
		...(typeof legacy.anchor === "string" ? { anchor: legacy.anchor } : {}),
		...(typeof legacy.endAnchor === "string" ? { endAnchor: legacy.endAnchor } : {}),
		newText: legacy.newText,
	});
	const { oldText: _oldText, anchor: _anchor, endAnchor: _endAnchor, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: HashlineEdit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, ctx?.cwd || cwd);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists.
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = splitBom(rawContent);
				const normalizedContent = normalizeToLF(content);
				const { baseContent, newContent, replacements } = applyHashlineOrExactEdits(
					normalizedContent,
					edits,
					path,
				);
				// Diff before writing, so diff computation cannot fail after the write.
				const editDiff = generateEditDiff(path, baseContent, newContent, replacements);
				throwIfAborted();

				// Splice into the original text, so untouched lines keep their line endings. Without any CR
				// the original is the normalized text, and the normalized result is already final.
				const finalContent =
					bom + (content === normalizedContent ? newContent : applyReplacementsToOriginal(content, replacements));
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diagNote =
					options?.diagnostics !== false && !options?.operations
						? await collectPostEditDiagnostics(absolutePath, ctx?.cwd || cwd)
						: undefined;

				return {
					content: [
						{
							type: "text",
							text: diagNote
								? `Successfully replaced ${edits.length} block(s) in ${path}.\n\n${diagNote}`
								: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					details: editDiff,
				};
			});
		},
		...editRenderers,
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): TypeBoxAgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
