import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getModelsPath } from "../config.ts";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";
import type { ModelsJsonModel, ModelsJsonProvider } from "./model-config.ts";

export interface DiscoveredProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
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

function inferModelMetadata(raw: Record<string, unknown>): DiscoveredProviderModel {
	const id = String(raw.id ?? "").trim();
	const displayName =
		typeof raw.display_name === "string" && raw.display_name.trim()
			? raw.display_name.trim()
			: typeof raw.name === "string" && raw.name.trim()
				? raw.name.trim()
				: id;

	const lower = `${id} ${displayName}`.toLowerCase();
	const reasoning =
		typeof raw.reasoning === "boolean"
			? raw.reasoning
			: /(reason|think|r1|o1|o3|o4|opus|sonnet|gpt-5|deepseek-r|qwq|gemini-2\.5|gemini-3)/.test(lower);

	const visionCapable =
		Array.isArray(raw.input) && raw.input.includes("image")
			? true
			: /(vision|vl|gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-4|claude-sonnet|claude-opus|gemini|pixtral|qwen.*vl)/.test(
					lower,
				);

	const contextWindow =
		typeof raw.context_window === "number" && raw.context_window > 0
			? raw.context_window
			: typeof raw.context_length === "number" && raw.context_length > 0
				? raw.context_length
				: typeof raw.max_input_tokens === "number" && raw.max_input_tokens > 0
					? raw.max_input_tokens
					: 128000;

	const maxTokens =
		typeof raw.max_tokens === "number" && raw.max_tokens > 0
			? raw.max_tokens
			: typeof raw.max_output_tokens === "number" && raw.max_output_tokens > 0
				? raw.max_output_tokens
				: 16384;

	return {
		id,
		name: displayName,
		reasoning,
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
			const res = await fetch(endpoint, { method: "GET", headers, signal: merged });
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
			return prev;
		}
		return {
			id: m.id,
			name: m.name || m.id,
			reasoning: m.reasoning,
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
