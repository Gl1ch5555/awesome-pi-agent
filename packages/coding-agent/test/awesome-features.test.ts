import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyRemoteSyncBundle,
	collectLocalSyncBundle,
	readSyncState,
	writeSyncState,
} from "../src/core/cloud-sync.ts";
import {
	deleteCustomProvider,
	fetchProviderModelsCatalog,
	inferModelMetadata,
	listCustomProviders,
	upsertCustomProvider,
} from "../src/core/custom-providers.ts";
import { checkGithubUpdate } from "../src/core/github-updater.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createWebSearchToolDefinition, SEARCH_PROVIDERS } from "../src/core/tools/web-search.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import {
	extractMultipleImagePathsFromText,
	resolvePromptImages,
	tryResolveImagePath,
} from "../src/utils/image-attachments.ts";

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

describe("awesome-pi-agent customizations", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "awesome-pi-test-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers graphite theme as a built-in theme", () => {
		initTheme("graphite");
		expect(theme.name).toBe("graphite");
		expect(theme.appearance).toBe("dark");
	});

	it("binds app.clipboard.pasteImage strictly to ctrl+v on all platforms", () => {
		const kb = new KeybindingsManager();
		expect(kb.getKeys("app.clipboard.pasteImage")).toEqual(["ctrl+v"]);
	});

	it("detects pasted image paths and resolves (image) markers into ImageContent", async () => {
		const imgPath = join(tempDir, "shot.png");
		writeFileSync(imgPath, TINY_PNG);

		expect(tryResolveImagePath(`"${imgPath}"`, tempDir)).toBe(imgPath);
		expect(extractMultipleImagePathsFromText(imgPath, tempDir)).toEqual([imgPath]);

		const res1 = await resolvePromptImages("look at (image)", [{ path: imgPath }], {
			cwd: tempDir,
			autoResizeImages: false,
			blockImages: false,
		});
		expect(res1.text).toBe("look at (image)");
		expect(res1.images).toHaveLength(1);
		expect(res1.images[0]?.mimeType).toBe("image/png");

		const res2 = await resolvePromptImages(`check "${imgPath}" please`, [], {
			cwd: tempDir,
			autoResizeImages: false,
			blockImages: false,
		});
		expect(res2.text).toBe("check (image) please");
		expect(res2.images).toHaveLength(1);
	});

	it("manages custom providers in models.json and parses /v1/models", async () => {
		const modelsPath = join(tempDir, "models.json");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					data: [
						{ id: "deepseek-r1", context_length: 64000 },
						{ id: "gpt-4o", context_length: 128000 },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const models = await fetchProviderModelsCatalog("https://example.com/v1", "sk-test");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(models.map((m) => m.id)).toEqual(["deepseek-r1", "gpt-4o"]);

		upsertCustomProvider(
			{
				id: "my-proxy",
				baseUrl: "https://example.com/v1",
				apiKey: "sk-test",
				models,
			},
			modelsPath,
		);

		const list = listCustomProviders(modelsPath);
		expect(list).toHaveLength(1);
		expect(list[0]?.id).toBe("my-proxy");
		expect(list[0]?.models).toHaveLength(2);

		deleteCustomProvider("my-proxy", modelsPath);
		expect(listCustomProviders(modelsPath)).toHaveLength(0);
	});

	it("provides Tavily plus 11 other web search providers and executes web_search", async () => {
		expect(SEARCH_PROVIDERS.length).toBeGreaterThanOrEqual(11);
		expect(SEARCH_PROVIDERS.map((p) => p.id)).toContain("tavily");
		expect(SEARCH_PROVIDERS.map((p) => p.id)).toContain("duckduckgo");

		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					answer: "Pi coding agent",
					results: [{ title: "Pi", url: "https://pi.dev", content: "Minimal agent harness" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const tool = createWebSearchToolDefinition({
			getSettings: () => ({
				enabled: true,
				provider: "tavily",
				apiKeys: { tavily: "tvly-test" },
			}),
		});
		const out = await tool.execute("call-1", { query: "pi coding agent" }, undefined, undefined, {} as never);
		expect(out.details?.provider).toBe("tavily");
		expect(out.details?.resultCount).toBe(1);
		expect((out.content[0] as { text: string }).text).toContain("https://pi.dev");
	});

	it("collects and restores cloud sync bundle including settings, keys, models, skills, and plugins/extensions", () => {
		const srcAgentDir = join(tempDir, "src-agent");
		const dstAgentDir = join(tempDir, "dst-agent");
		const skillDir = join(srcAgentDir, "skills", "my-skill");
		const extDir = join(srcAgentDir, "extensions", "my-plugin");
		const themeDir = join(srcAgentDir, "themes");
		mkdirSync(skillDir, { recursive: true });
		mkdirSync(extDir, { recursive: true });
		mkdirSync(themeDir, { recursive: true });
		writeFileSync(
			join(srcAgentDir, "settings.json"),
			JSON.stringify({ theme: "graphite", packages: ["npm:my-pkg"] }),
		);
		writeFileSync(join(srcAgentDir, "models.json"), JSON.stringify({ providers: { test: { baseUrl: "http://x" } } }));
		writeFileSync(join(srcAgentDir, "auth.json"), JSON.stringify({ groq: { key: "gsk_test" } }));
		writeFileSync(join(skillDir, "SKILL.md"), "# My Skill\nhello");
		writeFileSync(join(extDir, "index.ts"), "export default function () {}");
		writeFileSync(join(themeDir, "custom.json"), "{}");

		const bundle = collectLocalSyncBundle(srcAgentDir);
		expect(bundle.settings?.theme).toBe("graphite");
		expect(bundle.skills?.["my-skill/SKILL.md"]?.content).toContain("My Skill");
		expect(bundle.extensions?.["my-plugin/index.ts"]?.content).toContain("export default");

		const applied = applyRemoteSyncBundle(bundle, dstAgentDir);
		expect(applied.skillFiles).toBe(1);
		expect(applied.extensionFiles).toBe(2);
		expect(readFileSync(join(dstAgentDir, "skills", "my-skill", "SKILL.md"), "utf8")).toContain("My Skill");
		expect(readFileSync(join(dstAgentDir, "extensions", "my-plugin", "index.ts"), "utf8")).toContain(
			"export default",
		);
		expect(readFileSync(join(dstAgentDir, "themes", "custom.json"), "utf8")).toBe("{}");
		expect(readFileSync(join(dstAgentDir, "auth.json"), "utf8")).toContain("gsk_test");

		writeSyncState(
			{
				serverUrl: "https://grzxk.ru/pi-sync",
				user: "pavel",
				token: "a".repeat(64),
				lastSyncUpdated: 123,
				autoSync: true,
			},
			dstAgentDir,
		);
		expect(readSyncState(dstAgentDir)?.user).toBe("pavel");
	});

	it("checks GitHub update commit SHA and version", async () => {
		vi.stubEnv("PI_INSTALL_DIR", tempDir);
		writeFileSync(join(tempDir, "version.json"), JSON.stringify({ sha: "1111111111111111111111111111111111111111" }));
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					sha: "2222222222222222222222222222222222222222",
					version: "1.5.2",
				}),
				{ status: 200 },
			),
		);

		const info = await checkGithubUpdate("1.5.2");
		expect(info?.hasUpdate).toBe(true);
		expect(info?.shortSha).toBe("2222222");
	});

	it("persists and reloads the last selected defaultProvider, defaultModel, and thinking level", async () => {
		const { SettingsManager } = await import("../src/core/settings-manager.js");
		const agentDir = join(tempDir, "agent-persist");
		mkdirSync(agentDir, { recursive: true });
		const sm1 = SettingsManager.create(tempDir, agentDir);
		sm1.setDefaultModelAndProvider("custom-openai", "gpt-5.4");
		sm1.setDefaultThinkingLevel("high");
		sm1.setModelThinkingLevel("custom-openai", "gpt-5.4", "xhigh");
		await sm1.flush();

		const sm2 = SettingsManager.create(tempDir, agentDir);
		expect(sm2.getDefaultProvider()).toBe("custom-openai");
		expect(sm2.getDefaultModel()).toBe("gpt-5.4");
		expect(sm2.getDefaultThinkingLevel()).toBe("high");
		expect(sm2.getModelThinkingLevel("custom-openai", "gpt-5.4")).toBe("xhigh");
	});

	it("auto-detects context window and thinking levels for modern models", () => {
		const gemini4 = inferModelMetadata({ id: "gemini-4-hydrogen" });
		expect(gemini4.reasoning).toBe(true);
		expect(gemini4.contextWindow).toBe(1048576);
		expect(gemini4.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
		});
		expect(gemini4.input).toContain("image");

		const geminiFlash = inferModelMetadata({ id: "gemini-3-flash-preview" });
		expect(geminiFlash.thinkingLevelMap).toEqual({
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
		});

		const gpt5 = inferModelMetadata({ id: "gpt-5.4" });
		expect(gpt5.reasoning).toBe(true);
		expect(gpt5.contextWindow).toBe(400000);
		expect(gpt5.thinkingLevelMap?.high).toBe("high");
		expect(gpt5.thinkingLevelMap?.off).toBeUndefined();
	});

	it("upgrades legacy models.json gemini-4 entries so thinking levels are available without re-saving", async () => {
		const { ModelConfig } = await import("../src/core/model-config.js");
		const { composeModelProvider } = await import("../src/core/provider-composer.js");
		const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
		const modelsPath = join(tempDir, "legacy-models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					carbon: {
						baseUrl: "http://35.255.116.33:8000/v1",
						apiKey: "sk-test",
						api: "openai-completions",
						models: [{ id: "gemini-4-hydrogen", reasoning: false, contextWindow: 1048576, maxTokens: 65536 }],
					},
				},
			}),
		);
		const config = await ModelConfig.load(modelsPath);
		const provider = composeModelProvider("carbon", undefined, config, undefined);
		const model = provider.getModels()[0]!;
		expect(model.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high"]);
	});

	it("tails live lines while streaming write tool calls and shows line numbers", async () => {
		const { writeRenderers } = await import("../src/core/tools/renderers/write.js");
		const { ToolExecutionComponent } = await import("../src/modes/interactive/components/tool-execution.js");
		initTheme("graphite");
		const tui = { requestRender: () => {} } as any;
		const lines = Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");
		const comp = new ToolExecutionComponent(
			"write",
			"w1",
			{ path: "app.ts", content: lines },
			{},
			writeRenderers,
			tui,
			"/tmp",
		);
		const streamingOut = comp
			.render(100)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(streamingOut).toContain("writing 20 lines...");
		expect(streamingOut).toContain("earlier lines, 20 total");
		expect(streamingOut).toContain("20 │");
		expect(streamingOut).not.toMatch(/^\s*1 │/m);

		comp.setArgsComplete();
		comp.updateResult({ content: [{ type: "text", text: "Successfully wrote to app.ts" }], isError: false }, false);
		const doneOut = comp
			.render(100)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(doneOut).toContain("20 lines");
		expect(doneOut).toContain("1 │");
		expect(doneOut).toContain("more lines, 20 total");
	});

	it("starts and stops hold-space voice dictation reliably on repeated space without Kitty release events", async () => {
		const { CustomEditor } = await import("../src/modes/interactive/components/custom-editor.js");
		const tui = { requestRender: () => {} } as any;
		const kb = new KeybindingsManager();
		const editor = new CustomEditor(tui, { borderColor: (s: string) => s, selectList: {} as any }, kb);
		editor.setVoiceHoldEnabled(true);
		let started = 0;
		let stopped = 0;
		editor.onVoiceHoldStart = () => {
			started++;
		};
		editor.onVoiceHoldStop = () => {
			stopped++;
		};

		vi.useFakeTimers();
		try {
			editor.handleInput(" ");
			expect(editor.getText()).toBe(" ");
			vi.advanceTimersByTime(500);
			editor.handleInput(" "); // OS key repeat
			expect(started).toBe(1);
			expect(editor.getText()).toBe("");
			vi.advanceTimersByTime(950);
			expect(stopped).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries Groq Whisper transcription on 429 when retryOnRateLimit is enabled", async () => {
		const { transcribeAudioWithGroq } = await import("../src/core/voice/groq-whisper.js");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { message: "Rate limit reached. Please try again in 0.01s." } }), {
					status: 429,
					headers: { "Retry-After": "1" },
				}),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ text: "hello world" }), { status: 200 }));

		vi.useFakeTimers();
		try {
			const promise = transcribeAudioWithGroq({
				wavBuffer: Buffer.from("RIFF"),
				apiKey: "gsk_test",
				retryOnRateLimit: true,
			});
			await vi.advanceTimersByTimeAsync(1500);
			const text = await promise;
			expect(text).toBe("hello world");
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stores per-project self-reflection lessons and global memory atomically and syncs them", async () => {
		const { applyMemoryOperations, clearMemoryTarget, formatMemoryPromptSection, readMemorySnapshot } = await import(
			"../src/core/memory-store.js"
		);
		const { createMemoryToolDefinition } = await import("../src/core/tools/memory.js");

		const agentDir = join(tempDir, "agent");
		const projA = join(tempDir, "repo-a");
		const projASub = join(projA, "packages", "web");
		const projB = join(tempDir, "repo-b");
		mkdirSync(join(projA, ".git"), { recursive: true });
		mkdirSync(projASub, { recursive: true });
		mkdirSync(projB, { recursive: true });

		const tool = createMemoryToolDefinition(projASub, { getAgentDir: () => agentDir });
		const r1 = await tool.execute(
			"m1",
			{
				target: "project",
				operations: [
					{ action: "add", content: "Run npm run generate:schemas after editing settings-schema.ts" },
					{ action: "add", content: "Never import server code in client bundle" },
				],
			},
			undefined,
			undefined,
			{ cwd: projASub } as never,
		);
		expect(r1.isError).toBeFalsy();

		// Subdir of repo-a shares project memory with repo-a root, repo-b is isolated
		const snapA = readMemorySnapshot({ cwd: projA, agentDir });
		const snapB = readMemorySnapshot({ cwd: projB, agentDir });
		expect(snapA.project).toHaveLength(2);
		expect(snapB.project).toHaveLength(0);

		const patched = applyMemoryOperations(
			"project",
			[
				{
					action: "patch",
					old_text: "Never import server code in client bundle",
					content: "Keep server-only deps out of client bundle — Vite fails on node:fs",
				},
			],
			{ cwd: projA, agentDir },
		);
		expect(patched.ok).toBe(true);
		expect(patched.entries[1]).toContain("Vite fails");

		applyMemoryOperations("user", [{ action: "add", content: "Prefers Russian replies" }], {
			cwd: projA,
			agentDir,
		});
		const prompt = formatMemoryPromptSection({ cwd: projA, agentDir });
		expect(prompt).toContain("PROJECT LESSONS");
		expect(prompt).toContain("USER PREFERENCES");
		expect(prompt).toContain("generate:schemas");

		// Cloud sync includes memory.json and projects/*/lessons.json
		const bundle = collectLocalSyncBundle(agentDir);
		expect(bundle.memory).toBeDefined();
		expect(Object.keys(bundle.projectMemories ?? {}).length).toBeGreaterThanOrEqual(1);

		const restoredDir = join(tempDir, "restored-agent");
		applyRemoteSyncBundle(bundle, restoredDir);
		const restoredSnap = readMemorySnapshot({ cwd: projA, agentDir: restoredDir });
		expect(restoredSnap.project).toHaveLength(2);
		expect(restoredSnap.user).toEqual(["Prefers Russian replies"]);

		clearMemoryTarget("project", { cwd: projA, agentDir });
		expect(readMemorySnapshot({ cwd: projA, agentDir }).project).toHaveLength(0);
	});

	it("renders footer without provider prefix even with multiple providers", () => {
		initTheme("graphite");
		const session = {
			state: {
				model: { id: "gemini-4-hydrogen", provider: "google", reasoning: true, contextWindow: 1048576 },
				thinkingLevel: "high",
			},
			routedModel: undefined,
			model: { id: "gemini-4-hydrogen", provider: "google", reasoning: true, contextWindow: 1048576 },
			modelRuntime: { isUsingSubscription: () => false },
			sessionManager: {
				getCwd: () => "/tmp",
				getEntryCount: () => 0,
				getSessionId: () => "s1",
				getLeafId: () => null,
				getEntries: () => [],
				getSessionName: () => undefined,
			},
			getContextUsage: () => ({ percent: 17.9, tokens: 187_000, contextWindow: 1048576 }),
		} as any;
		const footerData = {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 5,
		} as any;

		const footer = new FooterComponent(session, footerData);
		const lines = footer.render(100);
		const plain = lines[1]!.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("gemini-4-hydrogen • high");
		expect(plain).not.toContain("(google)");
	});
});
