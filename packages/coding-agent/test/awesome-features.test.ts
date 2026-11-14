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
	listCustomProviders,
	upsertCustomProvider,
} from "../src/core/custom-providers.ts";
import { checkGithubUpdate } from "../src/core/github-updater.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createWebSearchToolDefinition, SEARCH_PROVIDERS } from "../src/core/tools/web-search.ts";
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
		writeFileSync(join(srcAgentDir, "settings.json"), JSON.stringify({ theme: "graphite", packages: ["npm:my-pkg"] }));
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
		expect(readFileSync(join(dstAgentDir, "extensions", "my-plugin", "index.ts"), "utf8")).toContain("export default");
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

	it("persists and reloads the last selected defaultProvider and defaultModel", async () => {
		const { SettingsManager } = await import("../src/core/settings-manager.js");
		const agentDir = join(tempDir, "agent-persist");
		mkdirSync(agentDir, { recursive: true });
		const sm1 = SettingsManager.create(tempDir, agentDir);
		sm1.setDefaultModelAndProvider("custom-openai", "gpt-5.4");
		await sm1.flush();

		const sm2 = SettingsManager.create(tempDir, agentDir);
		expect(sm2.getDefaultProvider()).toBe("custom-openai");
		expect(sm2.getDefaultModel()).toBe("gpt-5.4");
	});
});
