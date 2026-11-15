import type { AgentTool, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	contentText,
	getCurrentSystemMessage,
	type Message,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { markSkipCacheWarmer } from "./cache-warmer.ts";
import { formatMemoryPromptSection } from "./memory-store.ts";
import type { MemoryReviewMode } from "./settings-schema.ts";

const MAX_REVIEW_ITERATIONS = 4;
const DIGEST_TAIL_MESSAGES = 24;

const DIGEST_REVIEW_SYSTEM_PROMPT =
	"You are a background self-improvement reviewer. Inspect the conversation and save only durable, grounded facts via `memory` or reusable procedures/pitfalls via `skill_manage`. If nothing is worth saving, reply 'Nothing to save.' and stop.";

export function buildMemoryReviewPrompt(options: {
	cwd: string;
	agentDir: string;
	focus?: string;
	includeSnapshot?: boolean;
	allowSkillManage?: boolean;
}): string {
	const routingBlock = [
		"THREE distinct stores — pick the right one for each fact:",
		"  • project (memory tool, target='project'): conventions, build/test/deploy/lint commands, architecture invariants, and non-obvious pitfalls for the current repository.",
		"  • memory (memory tool, target='memory'): facts about the global ENVIRONMENT you operate in — cross-project paths, services, endpoints, and tool quirks.",
		"  • user (memory tool, target='user'): who the user is — persona, preferences, communication and work style, personal details they revealed, and standing expectations.",
		"",
		"One fact goes to ONE store, never duplicated across stores — duplicating bloats files until they hit character limits.",
		"",
		"Save only facts GROUNDED in this conversation — a user message or tool result you can point to. Never infer the user's traits, skill level, role, mood or preferences from topic, tone or tools used, and never turn a one-off request into a standing preference unless the user marked it general ('always', 'from now on', 'remember', 'всегда', 'запомни') or stated a standing like/dislike. Write entries as declarative facts ('User prefers concise responses'), not directives ('Always respond concisely'), with no dates or session logs.",
	].join("\n");

	const allowedList = options.allowSkillManage ? "`memory` and `skill_manage`" : "`memory`";
	const skillBlock = options.allowSkillManage
		? [
				"",
				"SKILLS (`skill_manage` tool):",
				"  • If the conversation worked out a non-trivial multi-step workflow, fix, or non-obvious pitfall worth reusing across sessions, save or update a skill via `skill_manage` (patch an existing skill first if one matches, or create a concise new one).",
				"  • Keep skills actionable (imperative rules + why + verified commands), with no session dates or logs.",
			].join("\n")
		: "";

	const parts = [
		"Review the conversation above and update persistent memory/skills only if something genuinely durable stands out.",
		"",
		routingBlock,
		...(skillBlock ? [skillBlock] : []),
	];

	if (options.includeSnapshot) {
		const snapshot = formatMemoryPromptSection({ cwd: options.cwd, agentDir: options.agentDir });
		parts.push("", "Current saved memory:", snapshot || "(empty)");
	}

	if (options.focus?.trim()) {
		parts.push("", `Focus requested by the user: ${options.focus.trim()}`);
	}

	parts.push(
		"",
		`You may ONLY call ${allowedList} during this review (other tools are disabled). Consolidate stale entries only if near the character budget. If nothing is worth saving, just say 'Nothing to save.' and stop without calling any tool.`,
	);

	return parts.join("\n");
}

function summarizeMessageText(message: Message): string {
	if (message.role === "user") {
		return typeof message.content === "string" ? message.content.trim() : contentText(message.content).trim();
	}
	if (message.role === "assistant") {
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join(" ")
			.trim();
	}
	if (message.role === "toolResult") {
		return contentText(message.content).trim();
	}
	return "";
}

/**
 * Compact replay for digest mode: keep the recent `tail` non-system messages verbatim
 * (extended backward so it never starts on a `toolResult`) and collapse older turns into one
 * synthetic user-role digest.
 */
export function buildDigestMessages(messages: readonly Message[], tail = DIGEST_TAIL_MESSAGES): Message[] {
	const nonSystem = messages.filter((message) => message.role !== "system");
	if (nonSystem.length <= tail) {
		// Still ensure we don't start on an orphaned toolResult.
		let start = 0;
		while (start < nonSystem.length && nonSystem[start]?.role === "toolResult") {
			start++;
		}
		return nonSystem.slice(start);
	}

	let keepCount = tail;
	while (keepCount < nonSystem.length) {
		const firstKept = nonSystem[nonSystem.length - keepCount];
		if (!firstKept || firstKept.role !== "toolResult") break;
		keepCount++;
	}

	const older = nonSystem.slice(0, nonSystem.length - keepCount);
	const kept = nonSystem.slice(nonSystem.length - keepCount);
	if (older.length === 0) return kept;

	const lines: string[] = [];
	for (const message of older) {
		if (message.role === "user") {
			const text = summarizeMessageText(message).replace(/\s+/g, " ");
			if (text) lines.push(`USER: ${text.slice(0, 300)}`);
		} else if (message.role === "assistant") {
			const toolCalls = message.content.filter((b): b is ToolCall => b.type === "toolCall");
			if (toolCalls.length > 0) {
				lines.push(`ASSISTANT[tools: ${toolCalls.map((tc) => tc.name).join(", ")}]`);
			}
			const text = summarizeMessageText(message).replace(/\s+/g, " ");
			if (text) lines.push(`ASSISTANT: ${text.slice(0, 200)}`);
		}
	}

	if (lines.length === 0) return kept;

	const digestText =
		"[Earlier conversation digest — older turns summarised to bound review input tokens. Recent turns follow verbatim.]\n" +
		lines.join("\n");

	const digestMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: digestText }],
		timestamp: Date.now(),
	};

	return [digestMessage, ...kept];
}

export interface RunMemoryReviewOptions {
	model: Model<any>;
	messages: readonly Message[];
	memoryTool: AgentTool<any>;
	skillManageTool?: AgentTool<any>;
	cwd: string;
	agentDir: string;
	reviewMode: MemoryReviewMode;
	streamFn: StreamFn;
	thinkingLevel?: ThinkingLevel;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	sessionId?: string;
	focus?: string;
	signal?: AbortSignal;
	maxIterations?: number;
}

export interface MemoryReviewResult {
	saved: boolean;
	changes: string[];
	responseText: string;
	aborted: boolean;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	error?: string;
}

function toMemoryToolDeclaration(tool: AgentTool<any>): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.constrainedSampling !== undefined ? { constrainedSampling: tool.constrainedSampling } : {}),
	};
}

export async function runMemoryReview(options: RunMemoryReviewOptions): Promise<MemoryReviewResult> {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const changes: string[] = [];
	const maxIterations = options.maxIterations ?? MAX_REVIEW_ITERATIONS;

	if (options.signal?.aborted) {
		return { saved: false, changes, responseText: "", aborted: true, usage };
	}

	const hasSystemPrefix = getCurrentSystemMessage(options.messages) !== undefined;
	const useCachedPrefix = options.reviewMode === "auto" && hasSystemPrefix;

	const reviewUserMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: buildMemoryReviewPrompt({
					cwd: options.cwd,
					agentDir: options.agentDir,
					focus: options.focus,
					includeSnapshot: !useCachedPrefix,
					allowSkillManage: Boolean(options.skillManageTool),
				}),
			},
		],
		timestamp: Date.now(),
	};

	let workingMessages: Message[];
	let digestSystemPrompt: string | undefined;
	let digestTools: Tool[] | undefined;

	if (useCachedPrefix) {
		workingMessages = [...options.messages, reviewUserMessage];
	} else {
		digestSystemPrompt = DIGEST_REVIEW_SYSTEM_PROMPT;
		digestTools = [
			toMemoryToolDeclaration(options.memoryTool),
			...(options.skillManageTool ? [toMemoryToolDeclaration(options.skillManageTool)] : []),
		];
		workingMessages = [...buildDigestMessages(options.messages), reviewUserMessage];
	}

	let lastResponseText = "";

	for (let iter = 0; iter < maxIterations; iter++) {
		if (options.signal?.aborted) {
			return { saved: changes.length > 0, changes, responseText: lastResponseText, aborted: true, usage };
		}

		const context = useCachedPrefix
			? normalizeContext({ messages: workingMessages })
			: normalizeContext({
					systemPrompt: digestSystemPrompt,
					tools: digestTools,
					messages: workingMessages,
				});

		const streamOptions: SimpleStreamOptions & {
			headers?: Record<string, string>;
			env?: Record<string, string>;
		} = markSkipCacheWarmer({
			apiKey: options.apiKey,
			headers: options.headers,
			env: options.env,
			signal: options.signal,
			...(options.thinkingLevel && options.thinkingLevel !== "off" ? { reasoning: options.thinkingLevel } : {}),
			...(useCachedPrefix && options.sessionId ? { sessionId: options.sessionId } : {}),
		});

		let assistantMessage: AssistantMessage;
		try {
			const stream = await options.streamFn(options.model, context, streamOptions);
			assistantMessage = await stream.result();
		} catch (error) {
			if (options.signal?.aborted) {
				return { saved: changes.length > 0, changes, responseText: lastResponseText, aborted: true, usage };
			}
			return {
				saved: changes.length > 0,
				changes,
				responseText: lastResponseText,
				aborted: false,
				usage,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		usage.input += assistantMessage.usage?.input ?? 0;
		usage.output += assistantMessage.usage?.output ?? 0;
		usage.cacheRead += assistantMessage.usage?.cacheRead ?? 0;
		usage.cacheWrite += assistantMessage.usage?.cacheWrite ?? 0;

		if (assistantMessage.stopReason === "aborted" || options.signal?.aborted) {
			return { saved: changes.length > 0, changes, responseText: lastResponseText, aborted: true, usage };
		}

		if (assistantMessage.stopReason === "error") {
			return {
				saved: changes.length > 0,
				changes,
				responseText: lastResponseText,
				aborted: false,
				usage,
				error: assistantMessage.errorMessage || "Memory review failed",
			};
		}

		lastResponseText = assistantMessage.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();

		const toolCalls = assistantMessage.content.filter((b): b is ToolCall => b.type === "toolCall");
		if (toolCalls.length === 0) {
			break;
		}

		workingMessages.push(assistantMessage);

		for (const toolCall of toolCalls) {
			let resultText: string;
			let isError = false;
			const targetTool =
				toolCall.name === options.memoryTool.name
					? options.memoryTool
					: options.skillManageTool && toolCall.name === options.skillManageTool.name
						? options.skillManageTool
						: undefined;
			if (!targetTool) {
				isError = true;
				const allowed = options.skillManageTool
					? `"${options.memoryTool.name}", "${options.skillManageTool.name}"`
					: `"${options.memoryTool.name}"`;
				resultText = `Background review denied non-whitelisted tool "${toolCall.name}". Only ${allowed} allowed here.`;
			} else {
				try {
					const toolResult = await targetTool.execute(toolCall.id, toolCall.arguments, options.signal);
					const text = toolResult.content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("\n");
					resultText = text || "ok";
					isError = Boolean((toolResult as { isError?: boolean }).isError);
					if (!isError) {
						const details = toolResult.details as { summary?: string } | undefined;
						if (details?.summary) {
							changes.push(details.summary);
						} else if (resultText) {
							changes.push(resultText);
						}
					}
				} catch (error) {
					isError = true;
					resultText = `Error: ${error instanceof Error ? error.message : String(error)}`;
				}
			}

			const toolResultMessage: ToolResultMessage = {
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: resultText }],
				isError,
				timestamp: Date.now(),
			};
			workingMessages.push(toolResultMessage);
		}
	}

	return {
		saved: changes.length > 0,
		changes,
		responseText: lastResponseText,
		aborted: false,
		usage,
	};
}
