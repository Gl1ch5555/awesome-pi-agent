import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { scopedFetch } from "../http-dispatcher.ts";
import type { SearchProviderId, SearchSettings } from "../settings-schema.ts";

export interface SearchProviderMeta {
	id: SearchProviderId;
	label: string;
	envVar?: string;
	requiresKey: boolean;
	description: string;
}

export const SEARCH_PROVIDERS: readonly SearchProviderMeta[] = [
	{
		id: "tavily",
		label: "Tavily",
		envVar: "TAVILY_API_KEY",
		requiresKey: true,
		description: "AI-optimized search and extract API (recommended)",
	},
	{
		id: "brave",
		label: "Brave Search",
		envVar: "BRAVE_API_KEY",
		requiresKey: true,
		description: "Independent web index with fast REST search",
	},
	{
		id: "exa",
		label: "Exa",
		envVar: "EXA_API_KEY",
		requiresKey: true,
		description: "Neural semantic search with clean page highlights",
	},
	{
		id: "serper",
		label: "Serper (Google)",
		envVar: "SERPER_API_KEY",
		requiresKey: true,
		description: "Fast Google SERP JSON API",
	},
	{
		id: "perplexity",
		label: "Perplexity Sonar",
		envVar: "PERPLEXITY_API_KEY",
		requiresKey: true,
		description: "Grounded web answers and citations via Sonar",
	},
	{
		id: "firecrawl",
		label: "Firecrawl",
		envVar: "FIRECRAWL_API_KEY",
		requiresKey: true,
		description: "Search with full markdown page extraction",
	},
	{
		id: "jina",
		label: "Jina Search",
		envVar: "JINA_API_KEY",
		requiresKey: false,
		description: "LLM-friendly search (key optional for higher rate limits)",
	},
	{
		id: "linkup",
		label: "Linkup",
		envVar: "LINKUP_API_KEY",
		requiresKey: true,
		description: "Deep web retrieval API",
	},
	{
		id: "serpapi",
		label: "SerpAPI",
		envVar: "SERPAPI_API_KEY",
		requiresKey: true,
		description: "Multi-engine SERP API",
	},
	{
		id: "google_cse",
		label: "Google Custom Search",
		envVar: "GOOGLE_SEARCH_API_KEY",
		requiresKey: true,
		description: "Google Programmable Search Engine (requires key + cx)",
	},
	{
		id: "duckduckgo",
		label: "DuckDuckGo",
		requiresKey: false,
		description: "Zero-config web search (no API key required)",
	},
	{
		id: "searxng",
		label: "SearXNG",
		envVar: "SEARXNG_URL",
		requiresKey: false,
		description: "Self-hosted SearXNG instance",
	},
];

export interface SearchResultItem {
	title: string;
	url: string;
	snippet: string;
	score?: number;
}

export interface WebSearchToolDetails {
	provider: SearchProviderId;
	query: string;
	resultCount: number;
	fallbackUsed?: boolean;
}

export interface WebSearchToolOptions {
	getSettings?: () => SearchSettings;
}

const WebSearchSchema = Type.Object({
	query: Type.String({ minLength: 1, description: "Search query." }),
	limit: Type.Optional(
		Type.Number({ minimum: 1, maximum: 20, description: "Maximum number of results (default 6)." }),
	),
	provider: Type.Optional(
		Type.String({
			description:
				"Optional search provider override (tavily, brave, exa, serper, perplexity, firecrawl, jina, linkup, serpapi, google_cse, duckduckgo, searxng).",
		}),
	),
	topic: Type.Optional(
		Type.Union([Type.Literal("general"), Type.Literal("news")], {
			description: 'Search topic hint (e.g. "general" or "news").',
		}),
	),
	include_domains: Type.Optional(Type.Array(Type.String(), { description: "Restrict results to these domains." })),
	exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Exclude these domains from results." })),
});

export type WebSearchInput = {
	query: string;
	limit?: number;
	provider?: string;
	topic?: "general" | "news";
	include_domains?: string[];
	exclude_domains?: string[];
};

export function resolveSearchApiKey(
	provider: SearchProviderId,
	settings?: SearchSettings,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const configured = settings?.apiKeys?.[provider]?.trim();
	if (configured) return configured;
	const meta = SEARCH_PROVIDERS.find((p) => p.id === provider);
	if (meta?.envVar) {
		const envVal = env[meta.envVar]?.trim();
		if (envVal) return envVal;
	}
	if (provider === "google_cse") {
		const alt = env.GOOGLE_API_KEY?.trim();
		if (alt) return alt;
	}
	return undefined;
}

function decodeHtmlEntities(input: string): string {
	return input
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
	return decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<any> {
	const timeoutSignal = AbortSignal.timeout(20_000);
	const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const res = await scopedFetch("web", url, { ...init, signal: mergedSignal });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 240)}` : ""}`);
	}
	return res.json();
}

async function fetchText(url: string, init: RequestInit, signal?: AbortSignal): Promise<string> {
	const timeoutSignal = AbortSignal.timeout(20_000);
	const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const res = await scopedFetch("web", url, { ...init, signal: mergedSignal });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 240)}` : ""}`);
	}
	return res.text();
}

async function runProviderSearch(
	provider: SearchProviderId,
	input: WebSearchInput,
	settings: SearchSettings,
	signal?: AbortSignal,
): Promise<{ answer?: string; results: SearchResultItem[] }> {
	const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 6)));
	const apiKey = resolveSearchApiKey(provider, settings);

	switch (provider) {
		case "tavily": {
			if (!apiKey) throw new Error("Missing TAVILY_API_KEY");
			const data = await fetchJson(
				"https://api.tavily.com/search",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						api_key: apiKey,
						query: input.query,
						max_results: limit,
						topic: input.topic ?? "general",
						include_answer: true,
						...(input.include_domains?.length ? { include_domains: input.include_domains } : {}),
						...(input.exclude_domains?.length ? { exclude_domains: input.exclude_domains } : {}),
					}),
				},
				signal,
			);
			const results: SearchResultItem[] = Array.isArray(data.results)
				? data.results.map((r: any) => ({
						title: String(r.title ?? r.url ?? ""),
						url: String(r.url ?? ""),
						snippet: String(r.content ?? r.snippet ?? ""),
						score: typeof r.score === "number" ? r.score : undefined,
					}))
				: [];
			return { answer: typeof data.answer === "string" ? data.answer : undefined, results };
		}

		case "brave": {
			if (!apiKey) throw new Error("Missing BRAVE_API_KEY");
			const params = new URLSearchParams({ q: input.query, count: String(limit) });
			const data = await fetchJson(
				`https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
				{ headers: { Accept: "application/json", "X-Subscription-Token": apiKey } },
				signal,
			);
			const webResults = data.web?.results ?? [];
			return {
				results: webResults.slice(0, limit).map((r: any) => ({
					title: String(r.title ?? ""),
					url: String(r.url ?? ""),
					snippet: String(r.description ?? ""),
				})),
			};
		}

		case "exa": {
			if (!apiKey) throw new Error("Missing EXA_API_KEY");
			const data = await fetchJson(
				"https://api.exa.ai/search",
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "x-api-key": apiKey },
					body: JSON.stringify({
						query: input.query,
						numResults: limit,
						...(input.include_domains?.length ? { includeDomains: input.include_domains } : {}),
						...(input.exclude_domains?.length ? { excludeDomains: input.exclude_domains } : {}),
						contents: { text: { maxCharacters: 600 } },
					}),
				},
				signal,
			);
			const results = (data.results ?? []).map((r: any) => ({
				title: String(r.title ?? r.url ?? ""),
				url: String(r.url ?? ""),
				snippet: String(r.text ?? r.highlights?.join(" ") ?? ""),
				score: typeof r.score === "number" ? r.score : undefined,
			}));
			return { results };
		}

		case "serper": {
			if (!apiKey) throw new Error("Missing SERPER_API_KEY");
			const endpoint =
				input.topic === "news" ? "https://google.serper.dev/news" : "https://google.serper.dev/search";
			const data = await fetchJson(
				endpoint,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
					body: JSON.stringify({ q: input.query, num: limit }),
				},
				signal,
			);
			const items = data.organic ?? data.news ?? [];
			return {
				answer: data.answerBox?.answer ?? data.answerBox?.snippet,
				results: items.slice(0, limit).map((r: any) => ({
					title: String(r.title ?? ""),
					url: String(r.link ?? ""),
					snippet: String(r.snippet ?? ""),
				})),
			};
		}

		case "perplexity": {
			if (!apiKey) throw new Error("Missing PERPLEXITY_API_KEY");
			const data = await fetchJson(
				"https://api.perplexity.ai/chat/completions",
				{
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
					body: JSON.stringify({
						model: "sonar",
						messages: [{ role: "user", content: input.query }],
					}),
				},
				signal,
			);
			const answer = data.choices?.[0]?.message?.content;
			const citations: string[] = Array.isArray(data.citations) ? data.citations : [];
			return {
				answer: typeof answer === "string" ? answer : undefined,
				results: citations.slice(0, limit).map((url, idx) => ({
					title: `Citation ${idx + 1}`,
					url,
					snippet: "",
				})),
			};
		}

		case "firecrawl": {
			if (!apiKey) throw new Error("Missing FIRECRAWL_API_KEY");
			const data = await fetchJson(
				"https://api.firecrawl.dev/v1/search",
				{
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
					body: JSON.stringify({ query: input.query, limit }),
				},
				signal,
			);
			const items = data.data ?? [];
			return {
				results: items.slice(0, limit).map((r: any) => ({
					title: String(r.title ?? r.url ?? ""),
					url: String(r.url ?? ""),
					snippet: String(r.description ?? r.markdown?.slice(0, 500) ?? ""),
				})),
			};
		}

		case "jina": {
			const headers: Record<string, string> = { Accept: "application/json" };
			if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
			const data = await fetchJson(`https://s.jina.ai/?q=${encodeURIComponent(input.query)}`, { headers }, signal);
			const items = Array.isArray(data.data) ? data.data : [];
			return {
				results: items.slice(0, limit).map((r: any) => ({
					title: String(r.title ?? r.url ?? ""),
					url: String(r.url ?? ""),
					snippet: String(r.description ?? r.content?.slice(0, 500) ?? ""),
				})),
			};
		}

		case "linkup": {
			if (!apiKey) throw new Error("Missing LINKUP_API_KEY");
			const data = await fetchJson(
				"https://api.linkup.so/v1/search",
				{
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
					body: JSON.stringify({
						q: input.query,
						depth: "standard",
						outputType: "searchResults",
					}),
				},
				signal,
			);
			const items = Array.isArray(data.results) ? data.results : [];
			return {
				results: items.slice(0, limit).map((r: any) => ({
					title: String(r.name ?? r.title ?? r.url ?? ""),
					url: String(r.url ?? ""),
					snippet: String(r.content ?? r.snippet ?? ""),
				})),
			};
		}

		case "serpapi": {
			if (!apiKey) throw new Error("Missing SERPAPI_API_KEY");
			const params = new URLSearchParams({
				engine: "google",
				q: input.query,
				num: String(limit),
				api_key: apiKey,
			});
			const data = await fetchJson(`https://serpapi.com/search.json?${params.toString()}`, {}, signal);
			const items = data.organic_results ?? [];
			return {
				answer: data.answer_box?.answer ?? data.answer_box?.snippet,
				results: items.slice(0, limit).map((r: any) => ({
					title: String(r.title ?? ""),
					url: String(r.link ?? ""),
					snippet: String(r.snippet ?? ""),
				})),
			};
		}

		case "google_cse": {
			if (!apiKey) throw new Error("Missing GOOGLE_SEARCH_API_KEY");
			const cx = settings.googleCseId?.trim() || process.env.GOOGLE_CSE_ID?.trim();
			if (!cx) throw new Error("Missing Google Custom Search Engine ID (cx)");
			const params = new URLSearchParams({
				key: apiKey,
				cx,
				q: input.query,
				num: String(Math.min(10, limit)),
			});
			const data = await fetchJson(`https://www.googleapis.com/customsearch/v1?${params.toString()}`, {}, signal);
			const items = data.items ?? [];
			return {
				results: items.slice(0, limit).map((r: any) => ({
					title: String(r.title ?? ""),
					url: String(r.link ?? ""),
					snippet: String(r.snippet ?? ""),
				})),
			};
		}

		case "searxng": {
			const baseUrl = (settings.searxngUrl?.trim() || process.env.SEARXNG_URL?.trim() || "").replace(/\/+$/, "");
			if (!baseUrl) throw new Error("Missing SearXNG base URL");
			const params = new URLSearchParams({ q: input.query, format: "json" });
			const data = await fetchJson(`${baseUrl}/search?${params.toString()}`, {}, signal);
			const items = data.results ?? [];
			return {
				results: items.slice(0, limit).map((r: any) => ({
					title: String(r.title ?? ""),
					url: String(r.url ?? ""),
					snippet: String(r.content ?? ""),
				})),
			};
		}

		case "duckduckgo": {
			const html = await fetchText(
				`https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`,
				{
					headers: {
						"User-Agent": "Mozilla/5.0 (compatible; pi-coding-agent/1.5)",
						Accept: "text/html",
					},
				},
				signal,
			);
			const results: SearchResultItem[] = [];
			const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
			const snippetRegex =
				/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/gi;
			const snippets = [...html.matchAll(snippetRegex)].map((sm) => stripTags(sm[1] ?? sm[2] ?? ""));
			let idx = 0;
			for (const lm of html.matchAll(linkRegex)) {
				if (results.length >= limit) break;
				let url = decodeHtmlEntities(lm[1] ?? "");
				const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
				if (uddgMatch?.[1]) {
					try {
						url = decodeURIComponent(uddgMatch[1]);
					} catch {
						// Keep original URL if decode fails
					}
				}
				const title = stripTags(lm[2] ?? "");
				if (url && title) {
					results.push({ title, url, snippet: snippets[idx] ?? "" });
				}
				idx++;
			}
			return { results };
		}
	}
}

function buildProviderCandidateList(
	requested: SearchProviderId | undefined,
	settings: SearchSettings,
): SearchProviderId[] {
	const primary = requested ?? settings.provider ?? "tavily";
	const ordered: SearchProviderId[] = [primary];

	for (const meta of SEARCH_PROVIDERS) {
		if (meta.id === primary) continue;
		if (meta.requiresKey && resolveSearchApiKey(meta.id, settings)) {
			ordered.push(meta.id);
		}
	}
	if (!ordered.includes("jina")) ordered.push("jina");
	if (!ordered.includes("duckduckgo")) ordered.push("duckduckgo");
	return ordered;
}

export function createWebSearchToolDefinition(
	options?: WebSearchToolOptions,
): ToolDefinition<typeof WebSearchSchema, WebSearchToolDetails> {
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the web for up-to-date information, docs, packages, and references. Uses configured search provider (Tavily by default) with automatic fallback across configured providers.",
		parameters: WebSearchSchema,
		async execute(_toolCallId, rawParams, signal) {
			const params = rawParams as WebSearchInput;
			const settings = options?.getSettings?.() ?? {};
			if (settings.enabled === false) {
				throw new Error("Web search is disabled in settings.");
			}

			const requestedProvider =
				params.provider && SEARCH_PROVIDERS.some((p) => p.id === params.provider)
					? (params.provider as SearchProviderId)
					: undefined;
			const candidates = buildProviderCandidateList(requestedProvider, settings);
			const errors: string[] = [];

			for (let i = 0; i < candidates.length; i++) {
				const provider = candidates[i]!;
				try {
					const response = await runProviderSearch(provider, params, settings, signal);
					if (response.results.length === 0 && !response.answer && i < candidates.length - 1) {
						errors.push(`${provider}: empty results`);
						continue;
					}
					const lines: string[] = [`Provider: ${provider}`, `Query: ${params.query}`, ""];
					if (response.answer) {
						lines.push("Summary:", response.answer.trim(), "");
					}
					if (response.results.length === 0) {
						lines.push("No results found.");
					} else {
						for (let j = 0; j < response.results.length; j++) {
							const item = response.results[j]!;
							lines.push(`${j + 1}. ${item.title}`);
							lines.push(`   ${item.url}`);
							if (item.snippet) lines.push(`   ${item.snippet}`);
						}
					}
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: {
							provider,
							query: params.query,
							resultCount: response.results.length,
							fallbackUsed: i > 0,
						},
					};
				} catch (error) {
					if (signal?.aborted) throw error;
					const msg = error instanceof Error ? error.message : String(error);
					errors.push(`${provider}: ${msg}`);
				}
			}

			throw new Error(`All search providers failed (${errors.join("; ")})`);
		},
	};
}
