import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { scopedFetch } from "../http-dispatcher.ts";
import type { SearchSettings } from "../settings-schema.ts";
import { TOOL_LABEL_DESCRIPTION } from "./render-utils.ts";
import { resolveSearchApiKey } from "./web-search.ts";

export interface WebFetchToolDetails {
	url: string;
	provider: "tavily" | "jina" | "direct";
	truncated: boolean;
}

export interface WebFetchToolOptions {
	getSettings?: () => SearchSettings;
}

const WebFetchSchema = Type.Object({
	label: Type.Optional(Type.String({ description: TOOL_LABEL_DESCRIPTION })),
	url: Type.String({ minLength: 1, description: "HTTP or HTTPS URL to fetch." }),
	max_chars: Type.Optional(
		Type.Number({ minimum: 500, maximum: 80000, description: "Maximum characters to return (default 18000)." }),
	),
});

function htmlToReadableText(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

export function createWebFetchToolDefinition(
	options?: WebFetchToolOptions,
): ToolDefinition<typeof WebFetchSchema, WebFetchToolDetails> {
	return {
		name: "web_fetch",
		label: "web_fetch",
		description: "Fetch and extract readable text/markdown from a web URL.",
		parameters: WebFetchSchema,
		async execute(_toolCallId, rawParams, signal) {
			const params = rawParams as { url: string; max_chars?: number };
			const settings = options?.getSettings?.() ?? {};
			if (settings.enabled === false) {
				throw new Error("Web tools are disabled in settings.");
			}

			const url = params.url.trim();
			if (!/^https?:\/\//i.test(url)) {
				throw new Error("URL must start with http:// or https://");
			}
			const maxChars = Math.max(500, Math.min(80000, Math.floor(params.max_chars ?? 18000)));
			const timeoutSignal = AbortSignal.timeout(25_000);
			const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

			let extracted = "";
			let usedProvider: "tavily" | "jina" | "direct" = "direct";

			const tavilyKey = resolveSearchApiKey("tavily", settings);
			if (tavilyKey) {
				try {
					const res = await scopedFetch("web", "https://api.tavily.com/extract", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ api_key: tavilyKey, urls: [url] }),
						signal: mergedSignal,
					});
					if (res.ok) {
						const data = (await res.json()) as { results?: Array<{ raw_content?: string; content?: string }> };
						const content = data.results?.[0]?.raw_content ?? data.results?.[0]?.content;
						if (content && content.trim().length > 0) {
							extracted = content.trim();
							usedProvider = "tavily";
						}
					}
				} catch (error) {
					if (signal?.aborted) throw error;
				}
			}

			if (!extracted) {
				try {
					const jinaKey = resolveSearchApiKey("jina", settings);
					const headers: Record<string, string> = { Accept: "text/plain" };
					if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;
					const res = await scopedFetch("web", `https://r.jina.ai/${url}`, { headers, signal: mergedSignal });
					if (res.ok) {
						const text = await res.text();
						if (text.trim().length > 0) {
							extracted = text.trim();
							usedProvider = "jina";
						}
					}
				} catch (error) {
					if (signal?.aborted) throw error;
				}
			}

			if (!extracted) {
				const res = await scopedFetch("web", url, {
					headers: {
						"User-Agent": "Mozilla/5.0 (compatible; pi-coding-agent/1.5)",
						Accept: "text/html,application/xhtml+xml,text/plain,application/json",
					},
					signal: mergedSignal,
				});
				if (!res.ok) {
					throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
				}
				const contentType = res.headers.get("content-type") ?? "";
				const raw = await res.text();
				extracted = contentType.includes("html") ? htmlToReadableText(raw) : raw.trim();
				usedProvider = "direct";
			}

			const truncated = extracted.length > maxChars;
			const finalContent = truncated
				? `${extracted.slice(0, maxChars)}\n\n[Truncated to ${maxChars} of ${extracted.length} characters]`
				: extracted;

			return {
				content: [{ type: "text", text: finalContent || "(empty response)" }],
				details: { url, provider: usedProvider, truncated },
			};
		},
	};
}
