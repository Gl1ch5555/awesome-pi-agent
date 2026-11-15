import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type HttpOptions,
	type PartialArg,
	ResourceScope,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	FetchFunction,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	getDisabledGoogleThinkingConfig,
	isThinkingPart,
	mapStopReason,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
	retryGoogleRequest,
	supportsGoogleStrictToolSampling,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface GoogleVertexOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleApiThinkingLevel;
	};
	project?: string;
	location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

type JsonPathSegment = string | number;

function parseGoogleJsonPath(jsonPath: string): { segments: JsonPathSegment[]; emptyInit?: "array" | "object" } {
	let path = jsonPath.trim();
	let emptyInit: "array" | "object" | undefined;
	if (path.endsWith("[]")) {
		emptyInit = "array";
		path = path.slice(0, -2);
	} else if (path.endsWith("{}")) {
		emptyInit = "object";
		path = path.slice(0, -2);
	}
	if (path.startsWith("$")) path = path.slice(1);
	const segments: JsonPathSegment[] = [];
	let i = 0;
	while (i < path.length) {
		if (path[i] === ".") {
			i++;
			let end = i;
			while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
			if (end > i) segments.push(path.slice(i, end));
			i = end;
		} else if (path[i] === "[") {
			const closeIdx = path.indexOf("]", i + 1);
			if (closeIdx === -1) break;
			const inner = path.slice(i + 1, closeIdx).trim();
			if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
				segments.push(inner.slice(1, -1));
			} else {
				const num = Number.parseInt(inner, 10);
				if (Number.isInteger(num) && num >= 0) segments.push(num);
			}
			i = closeIdx + 1;
		} else {
			let end = i;
			while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
			if (end > i) segments.push(path.slice(i, end));
			i = end;
		}
	}
	return { segments, emptyInit };
}

function applyGooglePartialArgs(
	target: Record<string, any>,
	partialArgs: readonly PartialArg[],
): { delta: string; arguments: Record<string, any> } {
	const root: Record<string, any> = { ...target };
	let delta = "";

	for (const arg of partialArgs) {
		if (!arg.jsonPath) continue;
		const { segments, emptyInit } = parseGoogleJsonPath(arg.jsonPath);
		if (segments.length === 0) continue;

		let curr: any = root;
		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i]!;
			const nextSeg = segments[i + 1]!;
			if (curr[seg] === undefined || curr[seg] === null || typeof curr[seg] !== "object") {
				curr[seg] = typeof nextSeg === "number" ? [] : {};
			} else {
				curr[seg] = Array.isArray(curr[seg]) ? [...curr[seg]] : { ...curr[seg] };
			}
			curr = curr[seg];
		}

		const lastSeg = segments[segments.length - 1]!;
		if (emptyInit === "array") {
			if (!Array.isArray(curr[lastSeg])) curr[lastSeg] = [];
		} else if (emptyInit === "object") {
			if (typeof curr[lastSeg] !== "object" || curr[lastSeg] === null || Array.isArray(curr[lastSeg])) {
				curr[lastSeg] = {};
			}
		} else if (arg.stringValue !== undefined) {
			const prev = typeof curr[lastSeg] === "string" ? curr[lastSeg] : "";
			curr[lastSeg] = prev + arg.stringValue;
			delta += arg.stringValue;
		} else if (arg.numberValue !== undefined) {
			curr[lastSeg] = arg.numberValue;
			delta += String(arg.numberValue);
		} else if (arg.boolValue !== undefined) {
			curr[lastSeg] = arg.boolValue;
			delta += String(arg.boolValue);
		} else if (arg.nullValue !== undefined) {
			curr[lastSeg] = null;
			delta += "null";
		}
	}

	return { delta, arguments: root };
}

export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-vertex" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const apiKey = resolveApiKey(options);
			// Create the client using either a Vertex API key, if provided, or ADC with project and location
			const client = apiKey
				? createClientWithApiKey(model, apiKey, options?.headers, options?.identity, options?.fetch)
				: createClient(
						model,
						resolveProject(options),
						resolveLocation(options),
						options?.headers,
						options?.env,
						options?.identity,
						options?.fetch,
					);
			let params = buildParams(model, normalizedContext, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			let activeToolCall: { block: ToolCall; index: number } | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			const finishActiveToolCall = () => {
				if (!activeToolCall) return;
				stream.push({
					type: "toolcall_end",
					contentIndex: activeToolCall.index,
					toolCall: activeToolCall.block,
					partial: output,
				});
				activeToolCall = null;
			};
			for await (const chunk of googleStream) {
				await options?.onProviderStreamEvent?.(chunk, model);
				// Vertex uses the same @google/genai GenerateContentResponse type as Gemini.
				// responseId is documented there as an output-only identifier for each response.
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						if (part.text !== undefined) {
							finishActiveToolCall();
							const isThinking = isThinkingPart(part);
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blocks.length - 1,
											content: currentBlock.text,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
								}
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								currentBlock.text += part.text;
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}

						if (part.functionCall) {
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
								currentBlock = null;
							}

							const hasPartialArgs = Array.isArray(part.functionCall.partialArgs) && part.functionCall.partialArgs.length > 0;
							const isStreamingCall = hasPartialArgs || part.functionCall.willContinue === true;

							if (activeToolCall && (!part.functionCall.name || part.functionCall.name === activeToolCall.block.name) && (isStreamingCall || (!part.functionCall.args && part.functionCall.willContinue !== true))) {
								if (part.thoughtSignature) {
									activeToolCall.block.thoughtSignature = retainThoughtSignature(
										activeToolCall.block.thoughtSignature,
										part.thoughtSignature,
									);
								}
								if (hasPartialArgs) {
									const applied = applyGooglePartialArgs(
										activeToolCall.block.arguments,
										part.functionCall.partialArgs!,
									);
									activeToolCall.block.arguments = applied.arguments;
									stream.push({
										type: "toolcall_delta",
										contentIndex: activeToolCall.index,
										delta: applied.delta,
										partial: output,
									});
								}
								if (part.functionCall.willContinue !== true) {
									finishActiveToolCall();
								}
								continue;
							}

							finishActiveToolCall();

							const providedId = part.functionCall.id;
							const needsNewId =
								!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: providedId;

							if (isStreamingCall) {
								const initialArgs = hasPartialArgs
									? applyGooglePartialArgs({}, part.functionCall.partialArgs!)
									: { delta: "", arguments: (part.functionCall.args as Record<string, any>) ?? {} };
								const toolCall: ToolCall = {
									type: "toolCall",
									id: toolCallId,
									name: part.functionCall.name || "",
									arguments: initialArgs.arguments,
									...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
								};
								output.content.push(toolCall);
								const idx = blockIndex();
								activeToolCall = { block: toolCall, index: idx };
								stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
								if (initialArgs.delta) {
									stream.push({
										type: "toolcall_delta",
										contentIndex: idx,
										delta: initialArgs.delta,
										partial: output,
									});
								}
								if (part.functionCall.willContinue !== true) {
									finishActiveToolCall();
								}
							} else {
								const toolCall: ToolCall = {
									type: "toolCall",
									id: toolCallId,
									name: part.functionCall.name || "",
									arguments: (part.functionCall.args as Record<string, any>) ?? {},
									...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
								};

								output.content.push(toolCall);
								stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta: JSON.stringify(toolCall.arguments),
									partial: output,
								});
								stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
							}
						}
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}

				if (chunk.usageMetadata) {
					output.usage = {
						input:
							(chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
						output:
							(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
						cacheWrite: 0,
						reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};
					calculateCost(model, output.usage);
				}
			}

			finishActiveToolCall();

			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Google Vertex stream ended without a finish reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				const errorMessage = output.rawStopReason
					? `Provider stopped with: ${output.rawStopReason}`
					: "An unknown error occurred";
				throw new Error(errorMessage);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	} satisfies GoogleVertexOptions;
	if (!options?.reasoning) {
		return stream(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleVertexOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	if (clampedReasoning === "off") {
		return stream(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleVertexOptions);
	}
	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);

	if (usesGoogleThinkingLevel(model)) {
		return stream(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: toGoogleThinkingLevel(resolvedLevel),
			},
		} satisfies GoogleVertexOptions);
	}

	return stream(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(model, resolvedLevel, options.thinkingBudgets),
		},
	} satisfies GoogleVertexOptions);
};

function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: ProviderHeaders,
	env?: ProviderEnv,
	identity?: ClientIdentity,
	fetch?: FetchFunction,
): GoogleGenAI {
	const googleAuthOptions = buildGoogleAuthOptions(env);
	return new GoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		...(googleAuthOptions ? { googleAuthOptions } : {}),
		httpOptions: buildHttpOptions(model, optionsHeaders, identity, fetch),
	});
}

function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
	fetch?: FetchFunction,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders, identity, fetch),
	});
}

function buildHttpOptions(
	model: Model<"google-vertex">,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
	fetch?: FetchFunction,
): HttpOptions {
	// Always pass fetch: without one, @google/genai adds a per-request dispatcher that disables
	// undici's header and body timeouts, bypassing the idle timeouts of the global dispatcher.
	const httpOptions: HttpOptions = { fetch: fetch ?? globalThis.fetch };
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		if (baseUrlIncludesApiVersion(baseUrl)) {
			httpOptions.apiVersion = "";
		}
	}

	const headers = providerHeadersToRecord(getIdentityHeaders(model, identity), model.headers, optionsHeaders);
	if (headers) {
		httpOptions.headers = headers;
	}

	return httpOptions;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed || trimmed.includes("{location}")) {
		return undefined;
	}
	return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

function buildGoogleAuthOptions(env?: ProviderEnv): { keyFilename: string } | undefined {
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	return keyFilename ? { keyFilename } : undefined;
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim();
	if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
		return undefined;
	}
	return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project =
		options?.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options?.env);
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options?.env);
	if (!location) {
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	return location;
}

function buildParams(
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options: GoogleVertexOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const currentTools = getCurrentTools(context.messages);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	const functionCallingMode =
		currentTools.length > 0
			? resolveGoogleFunctionCallingMode(currentTools, options.toolChoice, supportsStrictMode)
			: undefined;
	const supportsStreamToolArgs =
		currentTools.length > 0 &&
		usesGoogleThinkingLevel(model) &&
		!model.id.includes("3.1-flash-lite") &&
		functionCallingMode !== "NONE";
	const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(systemInstruction && { systemInstruction: sanitizeSurrogates(systemInstruction) }),
		...(currentTools.length > 0 && {
			tools: convertTools(currentTools, false, supportsStrictMode),
		}),
		...((functionCallingMode !== undefined || supportsStreamToolArgs) && {
			toolConfig: {
				functionCallingConfig: {
					...(functionCallingMode !== undefined ? { mode: functionCallingMode } : {}),
					...(supportsStreamToolArgs ? { streamFunctionCallArguments: true } : {}),
				},
			},
		}),
		// Off for now, until we have evaluated the implications of the SDK's automatic continuation
		// (extra requests and stream resumes inside the SDK). A CONTINUATION finish ends the turn as "length".
		automaticContinuation: false,
	};

	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}

function getGoogleBudget(
	model: Model<"google-vertex">,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	const budgetLevel: keyof ThinkingBudgets = level === "xhigh" ? "high" : level;
	if (customBudgets?.[budgetLevel] !== undefined) {
		return customBudgets[budgetLevel]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
			xhigh: 32768,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
			xhigh: 24576,
		};
		return budgets[level];
	}

	return -1;
}
