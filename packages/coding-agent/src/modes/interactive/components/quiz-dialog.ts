import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
	AskQuestionAnswer,
	AskQuestionItem,
	AskQuestionsRequest,
	AskQuestionsResponse,
} from "../../../core/tools/ask-questions.ts";
import { theme } from "../theme/theme.ts";

interface QuestionState {
	selected: Set<string>;
	custom: string;
	skipped: boolean;
}

export class QuizDialogComponent implements Component, Focusable {
	private readonly tui: TUI;
	private readonly request: AskQuestionsRequest;
	private readonly onComplete: (response: AskQuestionsResponse) => void;
	private readonly states: QuestionState[];
	private readonly input: Input;

	private currentIndex = 0; // 0..questions.length-1, or questions.length for Submit screen
	private optionCursor = 0;
	private editingCustom = false;
	private submitCursor = 0; // 0 = Submit, 1 = Review first unanswered, 2 = Cancel
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.editingCustom;
	}

	constructor(tui: TUI, request: AskQuestionsRequest, onComplete: (response: AskQuestionsResponse) => void) {
		this.tui = tui;
		this.request = request;
		this.onComplete = onComplete;
		this.states = request.questions.map(() => ({
			selected: new Set<string>(),
			custom: "",
			skipped: false,
		}));
		this.input = new Input();
		this.input.onSubmit = (val) => {
			const trimmed = val.trim();
			const qIdx = this.currentIndex;
			const state = this.states[qIdx];
			if (state) {
				state.custom = trimmed;
				state.skipped = false;
				if (!this.currentQuestion()?.multi && trimmed) {
					state.selected.clear();
				}
			}
			this.editingCustom = false;
			this.input.focused = false;
			this.advanceAfterAnswer();
		};
		this.input.onEscape = () => {
			this.editingCustom = false;
			this.input.focused = false;
			this.invalidate();
			this.tui.requestRender();
		};
	}

	dispose(): void {
		// Nothing to clean up
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private get total(): number {
		return this.request.questions.length;
	}

	private isSubmitScreen(): boolean {
		return this.total > 1 && this.currentIndex >= this.total;
	}

	private currentQuestion(): AskQuestionItem | undefined {
		return this.request.questions[this.currentIndex];
	}

	private isAnswered(index: number): boolean {
		const st = this.states[index];
		if (!st) return false;
		return st.selected.size > 0 || st.custom.trim().length > 0;
	}

	private answeredCount(): number {
		let count = 0;
		for (let i = 0; i < this.total; i++) {
			if (this.isAnswered(i)) count++;
		}
		return count;
	}

	private findFirstUnanswered(afterIndex = -1): number {
		for (let i = afterIndex + 1; i < this.total; i++) {
			if (!this.isAnswered(i) && !this.states[i]?.skipped) return i;
		}
		for (let i = 0; i <= afterIndex && i < this.total; i++) {
			if (!this.isAnswered(i) && !this.states[i]?.skipped) return i;
		}
		return -1;
	}

	private buildResponse(cancelled: boolean): AskQuestionsResponse {
		if (cancelled) {
			return { answers: [], cancelled: true };
		}
		const answers: AskQuestionAnswer[] = this.states.map((st, index) => {
			const selected = Array.from(st.selected);
			const custom = st.custom.trim();
			const hasAnswer = selected.length > 0 || custom.length > 0;
			return {
				index,
				selected,
				...(custom ? { custom } : {}),
				...(!hasAnswer ? { skipped: true } : {}),
			};
		});
		return { answers, cancelled: false };
	}

	private submit(cancelled: boolean): void {
		this.onComplete(this.buildResponse(cancelled));
	}

	private advanceAfterAnswer(): void {
		if (this.total === 1) {
			this.submit(false);
			return;
		}
		if (this.currentIndex < this.total - 1) {
			this.currentIndex++;
			this.optionCursor = 0;
		} else {
			this.currentIndex = this.total; // Submit screen
			this.submitCursor = 0;
		}
		this.invalidate();
		this.tui.requestRender();
	}

	private optionCountFor(q: AskQuestionItem): number {
		// options + (Other if enabled) + (Skip if multi-question)
		return q.options.length + (q.other ? 1 : 0) + (this.total > 1 ? 1 : 0);
	}

	private selectOptionAt(index: number, advanceSingle: boolean): void {
		const q = this.currentQuestion();
		const st = this.states[this.currentIndex];
		if (!q || !st) return;

		if (index < q.options.length) {
			const opt = q.options[index]!;
			st.skipped = false;
			if (q.multi) {
				if (st.selected.has(opt)) {
					st.selected.delete(opt);
				} else {
					st.selected.add(opt);
				}
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			st.selected.clear();
			st.selected.add(opt);
			st.custom = "";
			if (advanceSingle) {
				this.advanceAfterAnswer();
			} else {
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		const otherIndex = q.other ? q.options.length : -1;
		const skipIndex = this.total > 1 ? q.options.length + (q.other ? 1 : 0) : -1;

		if (index === otherIndex) {
			this.editingCustom = true;
			this.input.setValue(st.custom);
			this.input.focused = this._focused;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (index === skipIndex) {
			st.selected.clear();
			st.custom = "";
			st.skipped = true;
			this.advanceAfterAnswer();
		}
	}

	handleInput(data: string): void {
		if (this.editingCustom) {
			this.input.handleInput(data);
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.submit(true);
			return;
		}

		if (this.isSubmitScreen()) {
			const hasUnanswered = this.findFirstUnanswered(-1) !== -1;
			const maxRow = hasUnanswered ? 2 : 1;
			if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
				this.submitCursor = (this.submitCursor - 1 + (maxRow + 1)) % (maxRow + 1);
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
				this.submitCursor = (this.submitCursor + 1) % (maxRow + 1);
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.left) || matchesKey(data, "[")) {
				this.currentIndex = Math.max(0, this.total - 1);
				this.optionCursor = 0;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter) || data === "s" || data === "S") {
				if (data === "s" || data === "S" || this.submitCursor === 0) {
					this.submit(false);
					return;
				}
				if (hasUnanswered && this.submitCursor === 1) {
					const idx = this.findFirstUnanswered(-1);
					if (idx !== -1) {
						this.currentIndex = idx;
						this.optionCursor = 0;
						this.invalidate();
						this.tui.requestRender();
					}
					return;
				}
				this.submit(true);
				return;
			}
			return;
		}

		const q = this.currentQuestion();
		if (!q) return;
		const optCount = this.optionCountFor(q);

		// Quick number selection 1..8
		if (data.length === 1 && data >= "1" && data <= "8") {
			const num = Number(data) - 1;
			if (num < q.options.length) {
				this.optionCursor = num;
				this.selectOptionAt(num, !q.multi);
				return;
			}
		}

		if (this.total > 1 && (data === "s" || data === "S")) {
			this.currentIndex = this.total;
			this.submitCursor = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.optionCursor = (this.optionCursor - 1 + optCount) % optCount;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.optionCursor = (this.optionCursor + 1) % optCount;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (this.total > 1 && (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")) || data === "[")) {
			this.currentIndex = Math.max(0, this.currentIndex - 1);
			this.optionCursor = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (this.total > 1 && (matchesKey(data, Key.right) || matchesKey(data, Key.tab) || data === "]")) {
			this.currentIndex = Math.min(this.total, this.currentIndex + 1);
			this.optionCursor = 0;
			this.submitCursor = 0;
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (data === " " && q.multi && this.optionCursor < q.options.length) {
			this.selectOptionAt(this.optionCursor, false);
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (q.multi && this.optionCursor < q.options.length) {
				// If nothing selected yet, toggle current; otherwise advance
				const st = this.states[this.currentIndex]!;
				if (st.selected.size === 0 && !st.custom.trim()) {
					this.selectOptionAt(this.optionCursor, false);
				} else {
					this.advanceAfterAnswer();
				}
				return;
			}
			this.selectOptionAt(this.optionCursor, true);
		}
	}

	private renderIndexStrip(width: number): string {
		if (this.total <= 1) return "";
		const maxCols = Math.max(20, width - 2);
		const tokens: string[] = [];
		for (let i = 0; i < this.total; i++) {
			const active = i === this.currentIndex;
			const answered = this.isAnswered(i);
			const skipped = this.states[i]?.skipped;
			const mark = answered ? "+" : skipped ? "-" : "";
			const raw = active ? `[${i + 1}${mark}]` : `${i + 1}${mark}`;
			const styled = active
				? theme.fg("accent", theme.bold(raw))
				: answered
					? theme.fg("success", raw)
					: theme.fg("dim", raw);
			tokens.push(styled);
		}
		const submitActive = this.isSubmitScreen();
		tokens.push(submitActive ? theme.fg("accent", theme.bold("[Done]")) : theme.fg("muted", "Done"));

		// Window tokens around currentIndex so up to 40 questions fit on one line
		const focusIdx = Math.min(this.currentIndex, tokens.length - 1);
		let start = focusIdx;
		let end = focusIdx;
		let used = visibleWidth(tokens[focusIdx]!);

		while (start > 0 || end < tokens.length - 1) {
			let grew = false;
			if (start > 0) {
				const w = visibleWidth(tokens[start - 1]!) + 1;
				if (used + w <= maxCols - 4) {
					start--;
					used += w;
					grew = true;
				}
			}
			if (end < tokens.length - 1) {
				const w = visibleWidth(tokens[end + 1]!) + 1;
				if (used + w <= maxCols - 4) {
					end++;
					used += w;
					grew = true;
				}
			}
			if (!grew) break;
		}

		const slice = tokens.slice(start, end + 1);
		if (start > 0) slice.unshift(theme.fg("dim", ".."));
		if (end < tokens.length - 1) slice.push(theme.fg("dim", ".."));
		return ` ${slice.join(" ")}`;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const innerWidth = Math.max(10, width - 4);
		const answered = this.answeredCount();
		const titlePart = this.request.title ? `${this.request.title} · ` : "Quiz · ";
		const statusPart = this.isSubmitScreen()
			? `${titlePart}Review (${answered}/${this.total} answered)`
			: `${titlePart}${this.currentIndex + 1}/${this.total} (${answered}/${this.total} answered)`;

		lines.push(border);
		lines.push(truncateToWidth(` ${theme.fg("accent", theme.bold(statusPart))}`, width));

		if (this.total > 1) {
			lines.push(truncateToWidth(this.renderIndexStrip(width), width));
		}
		lines.push("");

		if (this.isSubmitScreen()) {
			lines.push(truncateToWidth(` ${theme.fg("text", theme.bold("Finish and send answers?"))}`, width));
			lines.push("");
			const unanswered = this.total - answered;
			if (unanswered > 0) {
				lines.push(
					truncateToWidth(
						` ${theme.fg("warning", `${unanswered} unanswered question(s) will be marked skipped.`)}`,
						width,
					),
				);
				lines.push("");
			}
			const actions: string[] = [`Submit (${answered}/${this.total})`];
			if (this.findFirstUnanswered(-1) !== -1) {
				actions.push("Review unanswered");
			}
			actions.push("Cancel");
			actions.forEach((label, idx) => {
				const selected = idx === this.submitCursor;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const styled = selected ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label);
				lines.push(truncateToWidth(` ${prefix}${styled}`, width));
			});
			lines.push("");
			lines.push(
				truncateToWidth(
					` ${theme.fg("dim", "↑↓ select · enter confirm · ← back · esc cancel")}`,
					width,
				),
			);
			lines.push(border);
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		const q = this.currentQuestion()!;
		const st = this.states[this.currentIndex]!;
		const qTitle = `${this.currentIndex + 1}. ${q.q}${q.multi ? " (multi)" : ""}`;
		for (const line of wrapTextWithAnsi(theme.fg("text", theme.bold(qTitle)), innerWidth)) {
			lines.push(` ${line}`);
		}
		lines.push("");

		q.options.forEach((opt, idx) => {
			const focused = !this.editingCustom && idx === this.optionCursor;
			const checked = st.selected.has(opt);
			const marker = q.multi ? (checked ? "[x]" : "[ ]") : checked ? "(●)" : "( )";
			const prefix = focused ? theme.fg("accent", "> ") : "  ";
			const num = theme.fg("dim", `${idx + 1}.`);
			const markStyled = checked ? theme.fg("success", marker) : theme.fg("muted", marker);
			const optStyled = focused
				? theme.fg("accent", opt)
				: checked
					? theme.fg("text", opt)
					: theme.fg("text", opt);
			const wrapped = wrapTextWithAnsi(`${prefix}${markStyled} ${num} ${optStyled}`, innerWidth);
			for (const w of wrapped) {
				lines.push(` ${w}`);
			}
		});

		if (q.other) {
			const otherIdx = q.options.length;
			const focused = !this.editingCustom && otherIdx === this.optionCursor;
			const hasCustom = st.custom.trim().length > 0;
			const prefix = focused ? theme.fg("accent", "> ") : "  ";
			const marker = hasCustom ? (q.multi ? "[x]" : "(●)") : q.multi ? "[ ]" : "( )";
			const markStyled = hasCustom ? theme.fg("success", marker) : theme.fg("muted", marker);
			const label = hasCustom ? `Other: ${st.custom.trim()}` : "Other...";
			const styled = focused ? theme.fg("accent", label) : theme.fg("muted", label);
			lines.push(truncateToWidth(` ${prefix}${markStyled} ${styled}`, width));
		}

		if (this.total > 1) {
			const skipIdx = q.options.length + (q.other ? 1 : 0);
			const focused = !this.editingCustom && skipIdx === this.optionCursor;
			const prefix = focused ? theme.fg("accent", "> ") : "  ";
			const styled = focused ? theme.fg("accent", "Skip question") : theme.fg("dim", "Skip question");
			lines.push(truncateToWidth(` ${prefix}${styled}`, width));
		}

		if (this.editingCustom) {
			lines.push("");
			lines.push(truncateToWidth(` ${theme.fg("accent", "Custom answer:")}`, width));
			for (const inpLine of this.input.render(Math.max(10, width - 2))) {
				lines.push(` ${inpLine}`);
			}
			lines.push(truncateToWidth(` ${theme.fg("dim", "enter save · esc cancel")}`, width));
		} else {
			lines.push("");
			const hint = q.multi
				? "↑↓ move · space/1-8 toggle · enter next · ←→ prev/next · s submit · esc cancel"
				: "↑↓ move · 1-8/enter select · ←→ prev/next · s submit · esc cancel";
			lines.push(truncateToWidth(` ${theme.fg("dim", hint)}`, width));
		}

		lines.push(border);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
