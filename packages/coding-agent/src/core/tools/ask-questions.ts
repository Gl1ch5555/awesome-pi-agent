import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { askQuestionsRenderers } from "./renderers/ask-questions.ts";

export const MAX_ASK_QUESTIONS = 40;

const questionItemSchema = Type.Object({
	q: Type.String({ description: "Short question text." }),
	options: Type.Array(Type.String(), {
		minItems: 2,
		maxItems: 8,
		description: "2-8 concise answer choices.",
	}),
	multi: Type.Optional(Type.Boolean({ description: "Allow multiple selections (default false)." })),
	other: Type.Optional(Type.Boolean({ description: "Allow custom text input (default true)." })),
});

const askQuestionsSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Optional short quiz title." })),
	questions: Type.Array(questionItemSchema, {
		minItems: 1,
		maxItems: MAX_ASK_QUESTIONS,
		description: "1-40 test-style questions to ask at once.",
	}),
});

export interface AskQuestionItem {
	q: string;
	options: string[];
	multi: boolean;
	other: boolean;
}

export interface AskQuestionsRequest {
	title?: string;
	questions: AskQuestionItem[];
}

export interface AskQuestionAnswer {
	index: number;
	selected: string[];
	custom?: string;
	skipped?: boolean;
}

export interface AskQuestionsResponse {
	answers: AskQuestionAnswer[];
	cancelled: boolean;
	error?: string;
}

export interface AskQuestionsToolDetails {
	title?: string;
	total: number;
	answered: number;
	cancelled: boolean;
	summaryLines: string[];
}

export type AskQuestionsHandler = (
	request: AskQuestionsRequest,
	signal?: AbortSignal,
) => Promise<AskQuestionsResponse>;

export interface AskQuestionsToolOptions {
	requestQuestions?: AskQuestionsHandler;
}

function normalizeQuestionItem(raw: unknown): AskQuestionItem | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const qRaw =
		typeof obj.q === "string"
			? obj.q
			: typeof obj.question === "string"
				? obj.question
				: typeof obj.prompt === "string"
					? obj.prompt
					: "";
	const q = qRaw.trim();
	if (!q) return undefined;

	const rawOpts = Array.isArray(obj.options) ? obj.options : [];
	const options: string[] = [];
	for (const opt of rawOpts) {
		if (typeof opt === "string") {
			const trimmed = opt.trim();
			if (trimmed) options.push(trimmed);
		} else if (opt && typeof opt === "object") {
			const optObj = opt as Record<string, unknown>;
			const label =
				typeof optObj.label === "string"
					? optObj.label
					: typeof optObj.value === "string"
						? optObj.value
						: "";
			const trimmed = label.trim();
			if (trimmed) options.push(trimmed);
		}
		if (options.length >= 8) break;
	}
	if (options.length < 2) return undefined;

	return {
		q,
		options,
		multi: obj.multi === true || obj.multiSelect === true,
		other: obj.other !== false && obj.allowOther !== false,
	};
}

export function normalizeAskQuestionsRequest(params: unknown): AskQuestionsRequest {
	const obj = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
	const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : undefined;
	const rawQuestions = Array.isArray(obj.questions) ? obj.questions.slice(0, MAX_ASK_QUESTIONS) : [];
	const questions: AskQuestionItem[] = [];
	for (const item of rawQuestions) {
		const normalized = normalizeQuestionItem(item);
		if (normalized) questions.push(normalized);
	}
	return { title, questions };
}

export function formatCompactAnswers(
	request: AskQuestionsRequest,
	response: AskQuestionsResponse,
): { text: string; summaryLines: string[]; answeredCount: number } {
	const total = request.questions.length;
	if (response.cancelled) {
		return {
			text: "Quiz cancelled by user.",
			summaryLines: ["Cancelled"],
			answeredCount: 0,
		};
	}

	const byIndex = new Map<number, AskQuestionAnswer>();
	for (const ans of response.answers) {
		if (ans && typeof ans.index === "number") {
			byIndex.set(ans.index, ans);
		}
	}

	const lines: string[] = [];
	let answeredCount = 0;

	for (let i = 0; i < total; i++) {
		const ans = byIndex.get(i);
		const num = i + 1;
		if (!ans || ans.skipped) {
			lines.push(`${num}. [skipped]`);
			continue;
		}
		const custom = typeof ans.custom === "string" ? ans.custom.trim() : "";
		const selected = Array.isArray(ans.selected) ? ans.selected.map((s) => s.trim()).filter(Boolean) : [];
		if (custom && selected.length > 0) {
			answeredCount++;
			lines.push(`${num}. ${selected.join("; ")}; [custom] ${custom}`);
		} else if (custom) {
			answeredCount++;
			lines.push(`${num}. [custom] ${custom}`);
		} else if (selected.length > 0) {
			answeredCount++;
			lines.push(`${num}. ${selected.join("; ")}`);
		} else {
			lines.push(`${num}. [skipped]`);
		}
	}

	const header = `Answers (${answeredCount}/${total}):`;
	return {
		text: `${header}\n${lines.join("\n")}`,
		summaryLines: lines,
		answeredCount,
	};
}

export function createAskQuestionsToolDefinition(
	options?: AskQuestionsToolOptions,
): ToolDefinition<typeof askQuestionsSchema, AskQuestionsToolDetails> {
	return {
		name: "ask_questions",
		label: "ask_questions",
		description:
			"Present 1-40 test-style multiple-choice questions to the user in an interactive quiz UI and return compact numbered answers.",
		promptSnippet: "Ask 1-40 test-style multiple-choice questions at once to clarify requirements or preferences",
		promptGuidelines: [
			"Use ask_questions proactively whenever requirements, architecture, UX, edge cases, or preferences are ambiguous — present a concise test (1-40 questions in one call) instead of guessing or writing a wall of text questions.",
			"Keep each question and option string short to conserve context tokens; set multi: true when multiple choices apply.",
		],
		parameters: askQuestionsSchema,
		async execute(_toolCallId, params, signal) {
			const request = normalizeAskQuestionsRequest(params);
			if (request.questions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: Provide 1-40 valid questions, each with 2-8 options." }],
					isError: true,
					details: {
						title: request.title,
						total: 0,
						answered: 0,
						cancelled: true,
						summaryLines: [],
					},
				};
			}

			if (!options?.requestQuestions) {
				return {
					content: [
						{
							type: "text",
							text: "Error: Interactive quiz UI is unavailable in this mode; ask concise questions in plain text.",
						},
					],
					isError: true,
					details: {
						title: request.title,
						total: request.questions.length,
						answered: 0,
						cancelled: true,
						summaryLines: [],
					},
				};
			}

			const response = await options.requestQuestions(request, signal);
			if (response.error) {
				return {
					content: [{ type: "text", text: `Error: ${response.error}` }],
					isError: true,
					details: {
						title: request.title,
						total: request.questions.length,
						answered: 0,
						cancelled: true,
						summaryLines: [],
					},
				};
			}

			const formatted = formatCompactAnswers(request, response);
			return {
				content: [{ type: "text", text: formatted.text }],
				details: {
					title: request.title,
					total: request.questions.length,
					answered: formatted.answeredCount,
					cancelled: response.cancelled,
					summaryLines: formatted.summaryLines,
				},
			};
		},
		...askQuestionsRenderers,
	};
}
