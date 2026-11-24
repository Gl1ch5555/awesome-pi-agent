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

	it("registers claude-code theme as a built-in theme", () => {
		initTheme("claude-code");
		expect(theme.name).toBe("claude-code");
		expect(theme.appearance).toBe("dark");
	});

	it("registers codex-cli, opencode, kiro-cli, and gemini-cli built-in themes", () => {
		for (const name of ["codex-cli", "opencode", "kiro-cli", "gemini-cli"]) {
			initTheme(name);
			expect(theme.name).toBe(name);
			expect(theme.appearance).toBe("dark");
		}
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
			xhigh: "xhigh",
		});
		expect(gemini4.input).toContain("image");

		const geminiCarbon = inferModelMetadata({ id: "gemini-4-carbon" });
		expect(geminiCarbon.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
		});

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
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh"]);
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
		expect(streamingOut).toContain("… (streaming)");
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

	it("formats working indicator elapsed time and retry countdowns in minutes when >= 60s", async () => {
		const { WorkingStatusIndicator, RetryStatusIndicator } = await import(
			"../src/modes/interactive/components/status-indicator.js"
		);
		initTheme("graphite");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
		const tui = { requestRender: () => {}, terminal: { rows: 10 } } as any;
		const working = new WorkingStatusIndicator(tui, "Working...");
		const retry = new RetryStatusIndicator(tui, 1, 3, 95_000);
		try {
			expect(retry.render(120)[1]!.replace(/\x1b\[[0-9;]*m/g, "")).toContain("Retrying (1/3) in 1m 35s...");
			vi.advanceTimersByTime(125_100);
			expect(working.render(120)[1]!.replace(/\x1b\[[0-9;]*m/g, "")).toContain("Working... · 2m 5s");
		} finally {
			working.dispose();
			retry.dispose();
			vi.useRealTimers();
		}
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

	it("freezes system prompt memory snapshot mid-session to preserve LLM prompt caching", async () => {
		const { createAgentSession } = await import("../src/core/sdk.js");
		const { SettingsManager } = await import("../src/core/settings-manager.js");
		const { SessionManager } = await import("../src/core/session-manager.js");
		const { DefaultResourceLoader } = await import("../src/core/resource-loader.js");
		const { applyMemoryOperations } = await import("../src/core/memory-store.js");

		const projDir = join(tempDir, "cached-proj");
		const agentDir = join(tempDir, "cached-agent");
		mkdirSync(join(projDir, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		applyMemoryOperations("project", [{ action: "add", content: "Initial rule: use pnpm" }], {
			cwd: projDir,
			agentDir,
		});

		const createTestSession = async () => {
			const settingsManager = SettingsManager.create(projDir, agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd: projDir,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();
			return createAgentSession({
				cwd: projDir,
				agentDir,
				settingsManager,
				sessionManager: SessionManager.inMemory(projDir),
				resourceLoader,
			});
		};

		const { session: s1 } = await createTestSession();
		const promptBefore = s1.systemPrompt;
		expect(promptBefore).toContain("Initial rule: use pnpm");
		expect(promptBefore).not.toContain("<self_reflection>");

		const prep = s1 as unknown as {
			_baseSystemPromptOptions: unknown;
			_preparePromptAndToolLoadout: (opts: unknown, messages?: unknown[]) => unknown;
		};
		const initialSysMsg = prep._preparePromptAndToolLoadout(prep._baseSystemPromptOptions, []);
		expect(initialSysMsg).toBeDefined();

		// Simulate mid-session memory write (as if the `memory` tool ran mid-turn)
		applyMemoryOperations("project", [{ action: "add", content: "New rule added mid-session" }], {
			cwd: projDir,
			agentDir,
		});

		// Simulate next-turn loadout preparation in the same session: prefix must stay identical!
		const turn2Diff = prep._preparePromptAndToolLoadout(prep._baseSystemPromptOptions, [initialSysMsg]);
		expect(turn2Diff).toBeUndefined();
		expect(s1.systemPrompt).toBe(promptBefore);

		// A fresh session picks up the updated rule at index 0
		const { session: s2 } = await createTestSession();
		expect(s2.systemPrompt).toContain("New rule added mid-session");
		s1.dispose();
		s2.dispose();
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

	it("runs Hermes-style background memory review every N turns with cache-parity prefix and memory-only whitelist", async () => {
		const { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, getCurrentTools } = await import(
			"@earendil-works/pi-ai"
		);
		const { Agent } = await import("@earendil-works/pi-agent-core");
		const { AgentSession } = await import("../src/core/agent-session.js");
		const { DefaultResourceLoader } = await import("../src/core/resource-loader.js");
		const { SessionManager } = await import("../src/core/session-manager.js");
		const { SettingsManager } = await import("../src/core/settings-manager.js");
		const { readMemorySnapshot } = await import("../src/core/memory-store.js");
		const { buildDigestMessages } = await import("../src/core/memory-review.js");

		const projDir = join(tempDir, "review-proj");
		const agentDir = join(tempDir, "review-agent");
		mkdirSync(join(projDir, ".git"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });

		const model = {
			id: "faux-review-1",
			name: "faux-review-1",
			api: "openai-completions",
			provider: "faux-mem-review",
			baseUrl: "https://example.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		} as any;

		{
			const settingsManager = SettingsManager.create(projDir, agentDir);
			settingsManager.setMemorySettings({ reviewEnabled: true, nudgeInterval: 2, reviewMode: "auto" });

			const resourceLoader = new DefaultResourceLoader({
				cwd: projDir,
				agentDir,
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const seenContexts: Array<{
				systemText: string;
				toolNames: string[];
				messageRoles: string[];
				lastUser: string;
			}> = [];
			let reviewRound = 0;

			const streamFn = (model: any, context: any) => {
				const sysMsg = context.messages.find((m: any) => m.role === "system");
				const lastUserMsg = [...context.messages].reverse().find((m: any) => m.role === "user");
				const lastUserText =
					typeof lastUserMsg?.content === "string"
						? lastUserMsg.content
						: (lastUserMsg?.content ?? []).map((b: any) => b.text ?? "").join("\n");
				seenContexts.push({
					systemText: typeof sysMsg?.content === "string" ? sysMsg.content : "",
					toolNames: getCurrentTools(context.messages).map((t: any) => t.name),
					messageRoles: context.messages.map((m: any) => m.role),
					lastUser: lastUserText,
				});

				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					let response;
					if (lastUserText.includes("Review the conversation above")) {
						reviewRound += 1;
						if (reviewRound === 1) {
							// Attempt a forbidden tool alongside memory to verify dispatch-side whitelist
							response = fauxAssistantMessage([
								fauxToolCall("bash", { command: "rm -rf /" }),
								fauxToolCall("memory", {
									target: "user",
									operations: [{ action: "add", content: "User prefers concise Russian responses" }],
								}),
							]);
						} else {
							response = fauxAssistantMessage("Saved user preference.");
						}
					} else {
						response = fauxAssistantMessage("Foreground reply.");
					}
					stream.push({
						type: "done",
						reason: "stop",
						message: { ...response, model: model.id, provider: model.provider },
					});
				});
				return stream;
			};

			const sessionManager = SessionManager.inMemory(projDir);
			const agent = new Agent({
				initialState: {
					systemPrompt: "",
					model,
					thinkingLevel: "off",
					tools: [],
					messages: [],
				},
				streamFn,
			});
			const session = new AgentSession({
				agent,
				sessionManager,
				settingsManager,
				cwd: projDir,
				resourceLoader,
				modelRuntime: {
					getModel: () => model,
					getPhysicalModel: () => model,
					getAvailableSnapshot: () => [model],
					hasConfiguredAuth: () => true,
					checkAuth: async () => ({}),
					getAuth: async () => ({ auth: { apiKey: "faux-key" }, env: {} }),
					isUsingOAuth: () => false,
				} as any,
			});

			const reviewEvents: Array<{ saved: boolean; background: boolean; changes: string[] }> = [];
			session.subscribe((ev) => {
				if (ev.type === "memory_review_end") {
					reviewEvents.push({ saved: ev.saved, background: ev.background, changes: ev.changes });
				}
			});

			// Turn 1: nudgeInterval is 2 -> no review yet
			await session.prompt("Always reply in Russian concisely");
			await new Promise((r) => setTimeout(r, 30));
			expect(reviewEvents).toHaveLength(0);

			// Turn 2: triggers background review asynchronously after turn completes
			await session.prompt("Ok thanks");
			await vi.waitFor(() => expect(reviewEvents).toHaveLength(1), { timeout: 2000 });
			expect(reviewEvents[0]!.saved).toBe(true);
			expect(reviewEvents[0]!.background).toBe(true);

			// Verify cache-parity prefix: review request #1 kept identical tools[] & system prompt
			const fgCtx = seenContexts[1]!;
			const bgCtx = seenContexts[2]!;
			expect(bgCtx.systemText).toBe(fgCtx.systemText);
			expect(bgCtx.toolNames).toEqual(fgCtx.toolNames);
			expect(bgCtx.toolNames).toContain("bash");

			// Verify bash was denied on dispatch, while memory saved the preference
			const snap = readMemorySnapshot({ cwd: projDir, agentDir });
			expect(snap.user).toEqual(["User prefers concise Russian responses"]);

			// Verify digest mode collapses older history without breaking toolCall/toolResult pairs
			const digest = buildDigestMessages(
				[
					{ role: "system", content: "sys", timestamp: 0 },
					{ role: "user", content: "old question", timestamp: 1 },
					fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })]),
					{
						role: "toolResult",
						toolCallId: "tc1",
						toolName: "read",
						content: [{ type: "text", text: "file content" }],
						isError: false,
						timestamp: 2,
					},
					{ role: "user", content: "recent question", timestamp: 3 },
					fauxAssistantMessage("recent answer"),
				],
				2,
			);
			expect(digest[0]!.role).toBe("user");
			expect((digest[0]!.content[0] as { text: string }).text).toContain("Earlier conversation digest");
			expect((digest[0]!.content[0] as { text: string }).text).toContain("ASSISTANT[tools: read]");
			expect(digest.slice(1).map((m) => m.role)).toEqual(["user", "assistant"]);

			session.dispose();
		}
	});

	it("preserves remote model deletions and prevents stale local settings from overwriting remote models on sync merge", async () => {
		const { computeSectionHashes, mergeSyncBundles, collectLocalSyncBundle, applyRemoteSyncBundle } = await import(
			"../src/core/cloud-sync.js"
		);

		const baseBundle = {
			version: 1 as const,
			syncedAt: 1000,
			settings: { theme: "graphite", defaultProvider: "omni", defaultModel: "old-model" },
			models: {
				providers: {
					omni: { baseUrl: "http://example/v1", models: [{ id: "old-model" }] },
					staleProvider: { baseUrl: "http://127.0.0.1:8080/v1", models: [{ id: "test" }] },
				},
			},
		};
		const prevHashes = computeSectionHashes(baseBundle);

		// PC deleted staleProvider and updated omni models + defaultModel
		const remoteBundle = {
			version: 1 as const,
			syncedAt: 2000,
			settings: { theme: "graphite", defaultProvider: "omni", defaultModel: "new-model" },
			models: {
				providers: {
					omni: { baseUrl: "http://example/v1", models: [{ id: "new-model" }] },
				},
			},
		};

		// Laptop still has old models.json, and only touched theme in settings.json
		const localBundle = {
			version: 1 as const,
			syncedAt: 1500,
			settings: { theme: "dracula", defaultProvider: "omni", defaultModel: "old-model", deviceId: "laptop-1" },
			models: baseBundle.models,
		};

		const merged = mergeSyncBundles(remoteBundle, localBundle, {
			previousSectionHashes: prevHashes,
			remoteUpdated: 2000,
		});

		// Models section was untouched on laptop -> remote models win completely (staleProvider stays deleted!)
		expect(Object.keys((merged.models as any).providers)).toEqual(["omni"]);
		expect((merged.models as any).providers.omni.models.map((m: any) => m.id)).toEqual(["new-model"]);
		// Ephemeral deviceId is stripped from synced settings
		expect((merged.settings as any).deviceId).toBeUndefined();

		// Local deviceId/lastChangelogVersion are preserved on disk when applying remote settings
		const dir = join(tempDir, "sync-preserve");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "settings.json"),
			JSON.stringify({ deviceId: "laptop-1", lastChangelogVersion: "1.5.2", theme: "dark" }),
		);
		applyRemoteSyncBundle(remoteBundle, dir);
		const onDisk = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
		expect(onDisk.deviceId).toBe("laptop-1");
		expect(onDisk.lastChangelogVersion).toBe("1.5.2");
		expect(onDisk.defaultModel).toBe("new-model");
		const collected = collectLocalSyncBundle(dir);
		expect((collected.settings as any).deviceId).toBeUndefined();
	});

	it("normalizes PowerShell drag-and-drop image paths and reports missing attachment errors", async () => {
		const { normalizePastedFilePathCandidate, resolvePromptImages } = await import("../src/utils/image-attachments.js");
		const normalized = normalizePastedFilePathCandidate("& '/tmp/photo shot.png'", "/tmp");
		expect(normalized).toBe("/tmp/photo shot.png");

		const res = await resolvePromptImages("check (image)", [{ path: "/nonexistent/missing.png" }], {
			cwd: "/tmp",
			autoResizeImages: true,
			blockImages: false,
		});
		expect(res.images).toHaveLength(0);
		expect(res.errors).toHaveLength(1);
		expect(res.errors[0]).toContain("missing.png");
	});
});
