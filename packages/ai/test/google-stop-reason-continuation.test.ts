import { FinishReason } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { streamSimple as streamGoogleGenerativeAI } from "../src/api/google-generative-ai.ts";
import { mapStopReason } from "../src/api/google-shared.ts";
import { streamSimple as streamGoogleVertex } from "../src/api/google-vertex.ts";
import type { Api, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

function createModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test-provider",
		baseUrl: "https://upstream.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	};
}

describe("Google CONTINUATION finish reason", () => {
	// #12097: @google/genai 2.32.0, needed for httpOptions.fetch, adds FinishReason.CONTINUATION.
	it("maps CONTINUATION to length, like MAX_TOKENS", () => {
		expect(mapStopReason(FinishReason.CONTINUATION)).toBe("length");
	});

	// #12097: the SDK continues automatically by default; the adapters turn that off.
	it("ends the turn as length instead of letting the SDK send a continuation request", async () => {
		const chunk = {
			candidates: [
				{
					content: { role: "model", parts: [{ text: "partial" }] },
					finishReason: "CONTINUATION",
					continuationToken: "token-1",
				},
			],
		};
		const fetch = vi.fn<FetchFunction>(
			async () =>
				new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
		);

		const google = await streamGoogleGenerativeAI(createModel("google-generative-ai"), context, {
			apiKey: "test-key",
			fetch,
		}).result();
		const vertex = await streamGoogleVertex(createModel("google-vertex"), context, {
			apiKey: "test-key",
			fetch,
		}).result();

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(google.stopReason).toBe("length");
		expect(vertex.stopReason).toBe("length");
	});

	it("streams function call partialArgs incrementally on Vertex Gemini 4", async () => {
		const { Type } = await import("typebox");
		const vertexToolModel = {
			...createModel("google-vertex"),
			id: "gemini-4-hydrogen",
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		} satisfies Model<"google-vertex">;
		const toolCtx = normalizeContext({
			tools: [
				{
					name: "write",
					description: "Write a file",
					parameters: Type.Object({ path: Type.String(), content: Type.String() }),
				},
			],
			messages: [{ role: "user", content: "write a.py", timestamp: 1 }],
		});

		const chunks = [
			{
				candidates: [
					{
						content: {
							role: "model",
							parts: [
								{
									functionCall: {
										id: "call_v4_1",
										name: "write",
										partialArgs: [{ jsonPath: "$.path", stringValue: "a.py" }],
										willContinue: true,
									},
									thoughtSignature: "VGVzdFNpZw==",
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							role: "model",
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.content", stringValue: "print(1)\n", willContinue: true }],
										willContinue: true,
									},
								},
							],
						},
					},
				],
			},
			{
				candidates: [
					{
						content: {
							role: "model",
							parts: [
								{
									functionCall: {
										partialArgs: [{ jsonPath: "$.content", stringValue: "print(2)\n" }],
										willContinue: false,
									},
								},
							],
						},
						finishReason: "STOP",
					},
				],
			},
		];

		let sentPayload: any;
		const fetch = vi.fn<FetchFunction>(async (_url, init) => {
			if (typeof init?.body === "string") {
				sentPayload = JSON.parse(init.body);
			}
			const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
			return new Response(sse, { headers: { "content-type": "text/event-stream" } });
		});

		const eventStream = streamGoogleVertex(vertexToolModel, toolCtx, {
			apiKey: "test-key",
			reasoning: "xhigh",
			fetch,
		});
		const deltaSnapshots: string[] = [];
		for await (const ev of eventStream) {
			if (ev.type === "toolcall_delta") {
				const tc = ev.partial.content[ev.contentIndex] as { arguments?: { content?: string } };
				deltaSnapshots.push(tc.arguments?.content ?? "");
			}
		}
		const finalMsg = await eventStream.result();

		expect(sentPayload.toolConfig?.functionCallingConfig?.streamFunctionCallArguments).toBe(true);
		expect(sentPayload.generationConfig?.thinkingConfig?.thinkingLevel).toBe("XHIGH");
		expect(deltaSnapshots).toEqual(["", "print(1)\n", "print(1)\nprint(2)\n"]);
		expect(finalMsg.stopReason).toBe("toolUse");
		expect(finalMsg.content[0]).toMatchObject({
			type: "toolCall",
			id: "call_v4_1",
			name: "write",
			thoughtSignature: "VGVzdFNpZw==",
			arguments: { path: "a.py", content: "print(1)\nprint(2)\n" },
		});
	});
});
