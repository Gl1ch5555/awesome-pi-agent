import { describe, expect, it } from "vitest";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import { DEFAULT_TOOL_NAMES, SettingsManager } from "../src/core/settings-manager.ts";
import {
	createAskQuestionsToolDefinition,
	formatCompactAnswers,
	MAX_ASK_QUESTIONS,
	normalizeAskQuestionsRequest,
} from "../src/core/tools/ask-questions.ts";
import { QuizDialogComponent } from "../src/modes/interactive/components/quiz-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("ask_questions quiz mode", () => {
	it("is enabled by default in settings and default tools", () => {
		expect(SETTINGS_DEFAULTS.questions.enabled).toBe(true);
		expect(DEFAULT_TOOL_NAMES).toContain("ask_questions");
		const sm = SettingsManager.inMemory();
		expect(sm.getQuestionsEnabled()).toBe(true);
		sm.setQuestionsEnabled(false);
		expect(sm.getQuestionsEnabled()).toBe(false);
	});

	it("normalizes up to 40 questions and caps overflow at 40", () => {
		const raw = Array.from({ length: 45 }, (_, i) => ({
			q: `Question ${i + 1}`,
			options: ["Yes", "No"],
		}));
		const req = normalizeAskQuestionsRequest({ title: "Setup", questions: raw });
		expect(req.title).toBe("Setup");
		expect(req.questions).toHaveLength(MAX_ASK_QUESTIONS);
		expect(req.questions[0]).toEqual({
			q: "Question 1",
			options: ["Yes", "No"],
			multi: false,
			other: true,
		});
	});

	it("formats compact token-economical answers without echoing questions or options", () => {
		const req = normalizeAskQuestionsRequest({
			questions: [
				{ q: "DB?", options: ["Postgres", "SQLite"] },
				{ q: "Features?", options: ["Auth", "Sync", "Search"], multi: true },
				{ q: "Name?", options: ["Alpha", "Beta"] },
				{ q: "Extra?", options: ["One", "Two"] },
			],
		});
		const formatted = formatCompactAnswers(req, {
			cancelled: false,
			answers: [
				{ index: 0, selected: ["Postgres"] },
				{ index: 1, selected: ["Auth", "Sync"] },
				{ index: 2, selected: [], custom: "Gamma" },
				{ index: 3, selected: [], skipped: true },
			],
		});
		expect(formatted.answeredCount).toBe(3);
		expect(formatted.text).toBe(
			"Answers (3/4):\n1. Postgres\n2. Auth; Sync\n3. [custom] Gamma\n4. [skipped]",
		);
		expect(formatted.text).not.toContain("DB?");
		expect(formatted.text).not.toContain("SQLite");
	});

	it("executes tool and handles missing UI gracefully", async () => {
		const noUiTool = createAskQuestionsToolDefinition();
		const errRes = await noUiTool.execute(
			"c1",
			{
				questions: [{ q: "Pick one", options: ["A", "B"] }],
			} as any,
			undefined,
			undefined,
			{} as any,
		);
		expect(errRes.isError).toBe(true);

		const tool = createAskQuestionsToolDefinition({
			requestQuestions: async (req) => ({
				cancelled: false,
				answers: req.questions.map((_, i) => ({ index: i, selected: ["A"] })),
			}),
		});
		const okRes = await tool.execute(
			"c2",
			{
				questions: [{ q: "Pick one", options: ["A", "B"] }],
			} as any,
			undefined,
			undefined,
			{} as any,
		);
		expect(okRes.isError).toBeUndefined();
		expect(okRes.content[0]).toEqual({ type: "text", text: "Answers (1/1):\n1. A" });
	});

	it("renders and navigates 40-question QuizDialogComponent cleanly", () => {
		initTheme("dark", false);
		const req = normalizeAskQuestionsRequest({
			title: "Architecture",
			questions: Array.from({ length: 40 }, (_, i) => ({
				q: `Choice ${i + 1}?`,
				options: ["Opt A", "Opt B"],
			})),
		});
		let finalRes: any;
		const fakeTui = { requestRender: () => {} } as any;
		const dialog = new QuizDialogComponent(fakeTui, req, (res) => {
			finalRes = res;
		});

		const lines80 = dialog.render(80);
		expect(lines80.length).toBeGreaterThan(5);
		const lines40 = dialog.render(40);
		expect(lines40.length).toBeGreaterThan(5);

		// Quick-pick option 1 on Q1 -> advances to Q2
		dialog.handleInput("1");
		expect(finalRes).toBeUndefined();

		// Press 's' to jump to submit screen, then Enter to submit
		dialog.handleInput("s");
		dialog.handleInput("\r");
		expect(finalRes).toBeDefined();
		expect(finalRes.cancelled).toBe(false);
		expect(finalRes.answers[0].selected).toEqual(["Opt A"]);
		expect(finalRes.answers[1].skipped).toBe(true);
	});
});
