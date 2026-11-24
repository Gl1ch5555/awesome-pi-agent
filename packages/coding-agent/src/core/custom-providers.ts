import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getModelsPath } from "../config.ts";
import { runWithProxyScope } from "./http-dispatcher.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";
import type { ModelsJsonModel, ModelsJsonProvider } from "./model-config.ts";

export interface DiscoveredProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
}

export interface CustomProviderSummary {
	id: string;
	name?: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	models: ModelsJsonModel[];
}

export interface ModelsJsonFileShape {
	$schema?: string;
	providers: Record<string, ModelsJsonProvider>;
}

export function normalizeBaseUrl(rawUrl: string): string {
	return rawUrl.trim().replace(/\/+$/, "");
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
	for (const val of values) {
		if (typeof val === "number" && Number.isFinite(val) && val > 0) {
			return Math.floor(val);
		}
	}
	return undefined;
}

function inferContextWindowById(lower: string): number {
	if (/\b1m\b|1000k|1048576/.test(lower)) return 1048576;
	if (/gemini-(?:4|3|2\.5|2\.0|1\.5)/.test(lower)) return 1048576;
	if (/gpt-5|gpt-6/.test(lower)) return 400000;
	if (/grok-4/.test(lower)) return 256000;
	if (/claude-|o1|o3|o4|glm-4|glm-5|kimi|minimax/.test(lower)) return 200000;
	if (/deepseek|qwen|qwq|grok-3|nemotron|gpt-4o|gpt-4\.1/.test(lower)) return 131072;
	return 128000;
}

function inferMaxTokensById(lower: string): number {
	if (/gemini-(?:4|3|2\.5)|gpt-5|gpt-6|o3|o4|claude-opus-5|claude-opus-4|claude-sonnet-4|deepseek-r|deepseek-v4/.test(lower)) {
		return 65536;
	}
	if (/claude-|deepseek|qwen3|glm-5|kimi|grok-4/.test(lower)) {
		return 32768;
	}
	return 16384;
}

export function inferModelMetadata(raw: Record<string, unknown>): DiscoveredProviderModel {
	const id = String(raw.id ?? "").trim();
	const displayName =
		typeof raw.display_name === "string" && raw.display_name.trim()
			? raw.display_name.trim()
			: typeof raw.name === "string" && raw.name.trim()
				? raw.name.trim()
				: id;

	const lower = `${id} ${displayName}`.toLowerCase();
	const topProvider =
		raw.top_provider && typeof raw.top_provider === "object"
			? (raw.top_provider as Record<string, unknown>)
			: undefined;
	const arch =
		raw.architecture && typeof raw.architecture === "object"
			? (raw.architecture as Record<string, unknown>)
			: undefined;
	const limits =
		raw.limits && typeof raw.limits === "object" ? (raw.limits as Record<string, unknown>) : undefined;
	const capabilities =
		raw.capabilities && typeof raw.capabilities === "object"
			? (raw.capabilities as Record<string, unknown>)
			: undefined;
	const supportedParams = Array.isArray(raw.supported_parameters)
		? raw.supported_parameters.map((p) => String(p).toLowerCase())
		: [];

	const reasoning =
		typeof raw.reasoning === "boolean"
			? raw.reasoning
			: typeof raw.thinking === "boolean"
				? raw.thinking
				: typeof raw.supports_reasoning === "boolean"
					? raw.supports_reasoning
					: typeof capabilities?.reasoning === "boolean"
						? capabilities.reasoning
						: supportedParams.includes("reasoning") || supportedParams.includes("include_reasoning")
							? true
							: /(reason|think|r1|o1|o3|o4|opus|sonnet|haiku-4|claude-4|claude-3\.7|gpt-5|gpt-6|deepseek|qwq|qwen3|gemini-2\.5|gemini-3|gemini-4|glm-4|glm-5|kimi|minimax|grok-3|grok-4|nemotron)/.test(
									lower,
								);

	const isGemini4XHigh = /gemini-4-hydrogen/i.test(lower);
	const isGemini4OrPro = /(?:gemini-4|gemini-3(?:\.\d+)?-pro)/i.test(lower);
	const isGeminiFlash3Plus = /gemini-3(?:\.\d+)?-flash/i.test(lower);
	const supportsExtended =
		reasoning && /(gemini-4|gemini-3|gpt-5|gpt-6|opus-4-6|opus-5|sonnet-4-6|grok-4)/.test(lower);
	const thinkingLevelMap: ThinkingLevelMap | undefined = !supportsExtended
		? undefined
		: isGemini4XHigh
			? {
					off: null,
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
				}
			: isGemini4OrPro
			? {
					off: null,
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: null,
				}
			: isGeminiFlash3Plus
				? {
						off: null,
						minimal: "minimal",
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: null,
					}
				: {
						minimal: "minimal",
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "xhigh",
					};

	const visionCapable =
		Array.isArray(raw.input) && raw.input.includes("image")
			? true
			: typeof capabilities?.vision === "boolean"
				? capabilities.vision
				: /(vision|vl|gpt-4o|gpt-4\.1|gpt-5|gpt-6|claude-3|claude-4|claude-5|claude-fable|claude-sonnet|claude-opus|claude-haiku|gemini|pixtral|qwen.*vl|grok-4|kimi)/.test(
						lower,
					);

	const contextWindow =
		firstPositiveNumber(
			raw.context_window,
			raw.context_length,
			raw.max_context_length,
			raw.input_token_limit,
			raw.max_input_tokens,
			raw.max_model_len,
			limits?.context,
			topProvider?.context_length,
			arch?.context_length,
		) ?? inferContextWindowById(lower);

	const maxTokens =
		firstPositiveNumber(
			raw.max_tokens,
			raw.max_output_tokens,
			raw.output_token_limit,
			limits?.output,
			topProvider?.max_completion_tokens,
		) ?? inferMaxTokensById(lower);

	return {
		id,
		name: displayName,
		reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: visionCapable ? ["text", "image"] : ["text"],
		contextWindow,
		maxTokens,
	};
}

function buildModelsEndpoints(baseUrl: string): string[] {
	const clean = normalizeBaseUrl(baseUrl);
	const endpoints: string[] = [];
	if (clean.endsWith("/models")) {
		endpoints.push(clean);
	} else if (/\/v\d+(?:beta)?$/i.test(clean)) {
		endpoints.push(`${clean}/models`);
	} else {
		endpoints.push(`${clean}/models`, `${clean}/v1/models`);
	}
	return [...new Set(endpoints)];
}

function resolveInlineSecret(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("$") && trimmed.length > 1) {
		return process.env[trimmed.slice(1)]?.trim() || undefined;
	}
	return trimmed;
}

export async function fetchProviderModelsCatalog(
	baseUrl: string,
	apiKey?: string,
	apiFormat = "openai-completions",
	signal?: AbortSignal,
): Promise<DiscoveredProviderModel[]> {
	const endpoints = buildModelsEndpoints(baseUrl);
	const resolvedKey = resolveInlineSecret(apiKey);
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (resolvedKey) {
		if (apiFormat === "anthropic-messages") {
			headers["x-api-key"] = resolvedKey;
			headers["anthropic-version"] = "2023-06-01";
		} else {
			headers.Authorization = `Bearer ${resolvedKey}`;
		}
	}

	let lastError = "Failed to fetch models";
	for (const endpoint of endpoints) {
		try {
			const timeout = AbortSignal.timeout(15_000);
			const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const res = await runWithProxyScope("ai", () => fetch(endpoint, { method: "GET", headers, signal: merged }));
			if (!res.ok) {
				const errBody = await res.text().catch(() => "");
				lastError = `${endpoint} -> HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 180)}` : ""}`;
				continue;
			}
			const data = (await res.json()) as { data?: unknown[]; models?: unknown[] } | unknown[];
			const rawList = Array.isArray(data)
				? data
				: Array.isArray(data.data)
					? data.data
					: Array.isArray(data.models)
						? data.models
						: [];

			const seen = new Set<string>();
			const models: DiscoveredProviderModel[] = [];
			for (const entry of rawList) {
				if (!entry || typeof entry !== "object") continue;
				const parsed = inferModelMetadata(entry as Record<string, unknown>);
				if (!parsed.id || seen.has(parsed.id)) continue;
				seen.add(parsed.id);
				models.push(parsed);
			}
			models.sort((a, b) => a.id.localeCompare(b.id));
			if (models.length > 0) {
				return models;
			}
			lastError = `${endpoint} returned 0 models`;
		} catch (error) {
			if (signal?.aborted) throw error;
			lastError = `${endpoint}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	throw new Error(lastError);
}

export function readModelsJsonFile(modelsPath: string = getModelsPath()): ModelsJsonFileShape {
	if (!existsSync(modelsPath)) {
		return { providers: {} };
	}
	const raw = stripBom(readFileSync(modelsPath, "utf8"));
	const parsed = JSON.parse(stripJsonComments(raw)) as Partial<ModelsJsonFileShape>;
	return {
		...(parsed.$schema ? { $schema: parsed.$schema } : {}),
		providers: parsed.providers && typeof parsed.providers === "object" ? { ...parsed.providers } : {},
	};
}

export function writeModelsJsonFile(data: ModelsJsonFileShape, modelsPath: string = getModelsPath()): void {
	const dir = dirname(modelsPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(modelsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function listCustomProviders(modelsPath: string = getModelsPath()): CustomProviderSummary[] {
	try {
		const data = readModelsJsonFile(modelsPath);
		return Object.entries(data.providers).map(([id, provider]) => ({
			id,
			name: provider.name,
			baseUrl: provider.baseUrl ?? "",
			apiKey: provider.apiKey ?? "",
			api: provider.api ?? "openai-completions",
			models: Array.isArray(provider.models) ? provider.models : [],
		}));
	} catch {
		return [];
	}
}

export function upsertCustomProvider(
	input: {
		id: string;
		baseUrl: string;
		apiKey: string;
		api?: string;
		models: DiscoveredProviderModel[];
	},
	modelsPath: string = getModelsPath(),
): void {
	const file = readModelsJsonFile(modelsPath);
	const existing = file.providers[input.id];
	const existingById = new Map((existing?.models ?? []).map((m) => [m.id, m]));

	const models: ModelsJsonModel[] = input.models.map((m) => {
		const prev = existingById.get(m.id);
		if (prev) {
			return {
				...prev,
				name: m.name || prev.name || m.id,
				reasoning: m.reasoning,
				...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
				input: m.input,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
			};
		}
		return {
			id: m.id,
			name: m.name || m.id,
			reasoning: m.reasoning,
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			input: m.input,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	});

	file.providers[input.id] = {
		...(existing ?? {}),
		baseUrl: normalizeBaseUrl(input.baseUrl),
		apiKey: input.apiKey.trim() || "local-key",
		api: input.api?.trim() || existing?.api || "openai-completions",
		models,
	};

	writeModelsJsonFile(file, modelsPath);
}

export function deleteCustomProvider(providerId: string, modelsPath: string = getModelsPath()): void {
	const file = readModelsJsonFile(modelsPath);
	delete file.providers[providerId];
	writeModelsJsonFile(file, modelsPath);
}
