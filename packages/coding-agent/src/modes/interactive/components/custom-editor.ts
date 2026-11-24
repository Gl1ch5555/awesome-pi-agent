import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { TuiStyle } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export interface EditorBorderMetadata {
	rightTop?: string;
	leftBottom?: string;
	rightBottom?: string;
}

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
	tuiStyle?: TuiStyle;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	public readonly embedWorkingStatus: boolean;
	private tuiStyle: TuiStyle;
	private borderMetaProvider?: () => EditorBorderMetadata;
	private lastRenderedBottomBorder = "";
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	// Hold-Space voice dictation state
	public voiceHoldEnabled = false;
	public onVoiceHoldStart?: () => void;
	public onVoiceHoldStop?: () => void;
	public onVoiceHoldCancel?: () => void;
	private voiceState: "idle" | "arming" | "recording" = "idle";
	private voiceArmingTimer: ReturnType<typeof setTimeout> | undefined;
	private voiceReleaseWatchdog: ReturnType<typeof setTimeout> | undefined;
	private voiceArmingInsertedSpace = false;
	private seenKittyKeyRelease = false;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
		this.tuiStyle = options?.tuiStyle ?? "native";
		this.wantsKeyRelease = true;
	}

	setTuiStyle(style: TuiStyle): void {
		this.tuiStyle = style;
	}

	setBorderMetadataProvider(provider: (() => EditorBorderMetadata) | undefined): void {
		this.borderMetaProvider = provider;
	}

	setVoiceHoldEnabled(enabled: boolean): void {
		this.voiceHoldEnabled = enabled;
		if (!enabled) {
			this.resetVoiceState();
		}
	}

	private clearVoiceTimers(): void {
		if (this.voiceArmingTimer) {
			clearTimeout(this.voiceArmingTimer);
			this.voiceArmingTimer = undefined;
		}
		if (this.voiceReleaseWatchdog) {
			clearTimeout(this.voiceReleaseWatchdog);
			this.voiceReleaseWatchdog = undefined;
		}
	}

	resetVoiceState(): void {
		this.clearVoiceTimers();
		this.voiceState = "idle";
		this.voiceArmingInsertedSpace = false;
	}

	private removeArmingSpaceIfPresent(): void {
		if (!this.voiceArmingInsertedSpace) return;
		this.voiceArmingInsertedSpace = false;
		const cursor = this.getCursor();
		const lines = this.getLines();
		const line = lines[cursor.line] ?? "";
		if (cursor.col > 0 && line[cursor.col - 1] === " ") {
			super.handleInput("\x7f"); // Backspace
		}
	}

	private needsReleaseWatchdog(): boolean {
		return !isKittyProtocolActive() || !this.seenKittyKeyRelease;
	}

	private startVoiceRecording(): void {
		this.clearVoiceTimers();
		this.removeArmingSpaceIfPresent();
		this.voiceState = "recording";
		this.onVoiceHoldStart?.();
		if (this.voiceState === "recording" && this.needsReleaseWatchdog()) {
			this.bumpVoiceReleaseWatchdog();
		}
	}

	private bumpVoiceReleaseWatchdog(): void {
		if (this.voiceReleaseWatchdog) {
			clearTimeout(this.voiceReleaseWatchdog);
		}
		this.voiceReleaseWatchdog = setTimeout(() => {
			if (this.voiceState === "recording") {
				this.resetVoiceState();
				this.onVoiceHoldStop?.();
			}
		}, 900);
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	private buildLabeledBorder(
		width: number,
		leftCorner: string,
		rightCorner: string,
		leftLabel?: string,
		rightLabel?: string,
	): string {
		const cornerW = visibleWidth(leftCorner) + visibleWidth(rightCorner);
		const innerWidth = Math.max(0, width - cornerW);
		if (innerWidth === 0) {
			return this.borderColor(truncateToWidth(`${leftCorner}${rightCorner}`, width, ""));
		}

		const leftPart = leftLabel ? ` ${leftLabel} ` : "";
		const rightPart = rightLabel ? ` ${rightLabel} ` : "";
		let leftW = visibleWidth(leftPart);
		let rightW = visibleWidth(rightPart);

		let effLeft = leftPart;
		let effRight = rightPart;
		if (leftW + rightW > innerWidth) {
			if (leftW > 0 && rightW > 0) {
				const maxLeft = Math.max(0, Math.floor(innerWidth * 0.55));
				effLeft = truncateToWidth(effLeft, maxLeft, "");
				leftW = visibleWidth(effLeft);
				effRight = truncateToWidth(effRight, Math.max(0, innerWidth - leftW), "");
				rightW = visibleWidth(effRight);
			} else if (leftW > 0) {
				effLeft = truncateToWidth(effLeft, innerWidth, "");
				leftW = visibleWidth(effLeft);
			} else {
				effRight = truncateToWidth(effRight, innerWidth, "");
				rightW = visibleWidth(effRight);
			}
		}

		const fill = "─".repeat(Math.max(0, innerWidth - leftW - rightW));
		return `${this.borderColor(leftCorner)}${effLeft}${this.borderColor(fill)}${effRight}${this.borderColor(rightCorner)}`;
	}

	private isHorizontalRuleStyle(): boolean {
		return (
			this.tuiStyle === "compact" ||
			this.tuiStyle === "claude-code" ||
			this.tuiStyle === "codex-cli" ||
			this.tuiStyle === "kiro-cli" ||
			this.tuiStyle === "gemini-cli"
		);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		if (this.isHorizontalRuleStyle() && width >= 20 && !this.workingStatusIndicator) {
			const meta = this.borderMetaProvider?.();
			const left = hiddenLineCount > 0 ? this.borderColor(`↑ ${hiddenLineCount} more`) : undefined;
			return this.buildLabeledBorder(width, "──", "──", left, meta?.rightTop);
		}
		if (!this.embedWorkingStatus || !this.workingStatusIndicator || width <= 0) {
			return super.renderTopBorder(width, hiddenLineCount);
		}

		let status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 5));
		let statusWidth = visibleWidth(status);
		if (statusWidth === 0) return super.renderTopBorder(width, hiddenLineCount);

		const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
		const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
		const overflowStart = Math.floor((width - overflowLabelWidth) / 2);
		const canFitOverflow = () =>
			overflowLabel !== undefined && overflowLabelWidth + 2 <= width && overflowStart - (3 + statusWidth + 1) >= 1;

		if (overflowLabel && !canFitOverflow()) {
			status = this.workingStatusIndicator.renderSpinnerInBorder(width);
			statusWidth = visibleWidth(status);
		}

		if (canFitOverflow()) {
			const leftBlockWidth = 3 + statusWidth + 1;
			return (
				this.borderColor("── ") +
				status +
				this.borderColor(
					` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(width - overflowStart - overflowLabelWidth)}`,
				)
			);
		}

		if (width >= statusWidth + 5) {
			return this.borderColor("── ") + status + this.borderColor(` ${"─".repeat(width - statusWidth - 4)}`);
		}

		status = this.workingStatusIndicator.renderSpinnerInBorder(width);
		statusWidth = visibleWidth(status);
		const prefixWidth = Math.min(3, Math.max(0, width - statusWidth));
		return (
			this.borderColor("─".repeat(prefixWidth)) +
			status +
			this.borderColor("─".repeat(Math.max(0, width - prefixWidth - statusWidth)))
		);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		let border: string;
		if (this.isHorizontalRuleStyle() && width >= 20) {
			const meta = this.borderMetaProvider?.();
			const right =
				hiddenLineCount > 0 ? this.borderColor(`↓ ${hiddenLineCount} more`) : meta?.rightBottom;
			border = this.buildLabeledBorder(width, "──", "──", meta?.leftBottom, right);
		} else {
			border = super.renderBottomBorder(width, hiddenLineCount);
		}
		this.lastRenderedBottomBorder = border;
		return border;
	}

	override render(width: number): string[] {
		if (this.tuiStyle === "codex-cli" && width >= 20) {
			const innerWidth = Math.max(1, width - 4);
			const lines = super.render(innerWidth);
			if (lines.length < 2) return lines;
			const foundBottom = this.lastRenderedBottomBorder ? lines.indexOf(this.lastRenderedBottomBorder, 1) : -1;
			const bodyStart = 1;
			const bodyEnd = foundBottom !== -1 ? foundBottom : lines.length - 1;
			const bgLine = (content: string, len: number) =>
				theme.bg("userMessageBg", `${content}${" ".repeat(Math.max(0, width - len))}`);
			const result: string[] = [];
			if (this.embedWorkingStatus && this.workingStatusIndicator) {
				const status = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 4));
				result.push(bgLine(`  ${status}`, 2 + visibleWidth(status)));
			} else {
				result.push(theme.bg("userMessageBg", " ".repeat(width)));
			}
			for (let i = bodyStart; i < bodyEnd; i++) {
				const line = lines[i] ?? "";
				const prefix = i === bodyStart ? theme.fg("accent", "› ") : "  ";
				result.push(bgLine(`  ${prefix}${line}`, 4 + visibleWidth(line)));
			}
			result.push(theme.bg("userMessageBg", " ".repeat(width)));
			for (let i = bodyEnd + 1; i < lines.length; i++) {
				result.push(`  ${lines[i] ?? ""}`);
			}
			return result;
		}

		if (this.tuiStyle === "opencode" && width >= 20) {
			const innerWidth = Math.max(1, width - 3);
			const lines = super.render(innerWidth);
			if (lines.length < 2) return lines;
			const meta = this.borderMetaProvider?.();
			const foundBottom = this.lastRenderedBottomBorder ? lines.indexOf(this.lastRenderedBottomBorder, 1) : -1;
			const bodyStart = 1;
			const bodyEnd = foundBottom !== -1 ? foundBottom : lines.length - 1;
			const bar = theme.fg("accent", "┃");
			const panelLine = (content: string, contentWidth: number) =>
				`${bar}${theme.bg("userMessageBg", `${content}${" ".repeat(Math.max(0, width - 1 - contentWidth))}`)}`;
			const result: string[] = [panelLine("", 0)];
			for (let i = bodyStart; i < bodyEnd; i++) {
				const line = lines[i] ?? "";
				result.push(panelLine(`  ${line}`, 2 + visibleWidth(line)));
			}
			const badgeLeft = `${theme.fg("accent", "Build")} ${theme.fg("dim", "·")} ${meta?.rightTop ?? ""}`;
			result.push(panelLine(`  ${badgeLeft}`, 2 + visibleWidth(badgeLeft)));
			result.push(`${theme.fg("accent", "╹")}${theme.fg("borderMuted", "▀".repeat(width - 1))}`);
			for (let i = bodyEnd + 1; i < lines.length; i++) {
				result.push(`  ${lines[i] ?? ""}`);
			}
			return result;
		}

		if (this.tuiStyle === "kiro-cli" && width >= 20) {
			const innerWidth = Math.max(1, width - 2);
			const lines = super.render(innerWidth);
			if (lines.length < 2) return lines;
			const meta = this.borderMetaProvider?.();
			const foundBottom = this.lastRenderedBottomBorder ? lines.indexOf(this.lastRenderedBottomBorder, 1) : -1;
			const bodyStart = 1;
			const bodyEnd = foundBottom !== -1 ? foundBottom : lines.length - 1;
			const result: string[] = [this.borderColor("─".repeat(width))];
			const statusLeft = `${theme.fg("accent", "Kiro")} ${theme.fg("dim", "·")} ${meta?.rightTop ?? ""}`;
			const statusRight = meta?.leftBottom ?? "";
			const gap = Math.max(1, width - visibleWidth(statusLeft) - visibleWidth(statusRight));
			result.push(`${statusLeft}${" ".repeat(gap)}${theme.fg("accent", statusRight)}`);
			for (let i = bodyStart; i < bodyEnd; i++) {
				const line = lines[i] ?? "";
				const prefix = i === bodyStart ? theme.fg("accent", "▎ ") : "  ";
				const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
				result.push(`${prefix}${line}${pad}`);
			}
			for (let i = bodyEnd + 1; i < lines.length; i++) {
				result.push(`  ${lines[i] ?? ""}`);
			}
			return result;
		}

		if (this.tuiStyle === "gemini-cli" && width >= 20) {
			const innerWidth = Math.max(1, width - 6);
			const lines = super.render(innerWidth);
			if (lines.length < 2) return lines;
			const meta = this.borderMetaProvider?.();
			let topLeftLabel: string | undefined;
			if (this.embedWorkingStatus && this.workingStatusIndicator) {
				topLeftLabel = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 8));
			}
			const topBorder = this.buildLabeledBorder(width, "╭─", "─╮", topLeftLabel, meta?.rightTop);
			const bottomBorder = this.buildLabeledBorder(width, "╰─", "─╯", meta?.leftBottom, meta?.rightBottom);
			const foundBottom = this.lastRenderedBottomBorder ? lines.indexOf(this.lastRenderedBottomBorder, 1) : -1;
			const bodyStart = 1;
			const bodyEnd = foundBottom !== -1 ? foundBottom : lines.length - 1;
			const result: string[] = [topBorder];
			const leftWall = this.borderColor("│ ");
			const rightWall = this.borderColor(" │");
			for (let i = bodyStart; i < bodyEnd; i++) {
				const line = lines[i] ?? "";
				const prefix = i === bodyStart ? theme.fg("accent", "> ") : "  ";
				const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
				result.push(`${leftWall}${prefix}${line}${pad}${rightWall}`);
			}
			result.push(bottomBorder);
			for (let i = bodyEnd + 1; i < lines.length; i++) {
				result.push(`  ${lines[i] ?? ""}`);
			}
			return result;
		}

		if (this.tuiStyle === "claude-code" && width >= 20) {
			const innerWidth = Math.max(1, width - 2);
			const lines = super.render(innerWidth);
			if (lines.length < 2) {
				return lines;
			}
			const meta = this.borderMetaProvider?.();
			let topLeftLabel: string | undefined;
			if (this.embedWorkingStatus && this.workingStatusIndicator) {
				topLeftLabel = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 6));
			}

			const foundBottom = this.lastRenderedBottomBorder ? lines.indexOf(this.lastRenderedBottomBorder, 1) : -1;
			const bodyStart = 1;
			const bodyEnd = foundBottom !== -1 ? foundBottom : lines.length - 1;

			const topBorder = this.buildLabeledBorder(width, "──", "──", topLeftLabel, meta?.rightTop);
			const bottomBorder = this.buildLabeledBorder(width, "──", "──", meta?.leftBottom, meta?.rightBottom);
			const result: string[] = [topBorder];
			const promptPrefix = theme.fg("accent", "❯ ");
			for (let i = bodyStart; i < bodyEnd; i++) {
				const line = lines[i] ?? "";
				const prefix = i === bodyStart ? promptPrefix : "  ";
				const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
				result.push(`${prefix}${line}${pad}`);
			}
			result.push(bottomBorder);

			for (let i = bodyEnd + 1; i < lines.length; i++) {
				result.push(`  ${lines[i] ?? ""}`);
			}
			return result;
		}

		if ((this.tuiStyle !== "rounded" && this.tuiStyle !== "opentui") || width < 20) {
			return super.render(width);
		}

		const innerWidth = Math.max(1, width - 4);
		const lines = super.render(innerWidth);
		if (lines.length < 2) {
			return lines;
		}

		const meta = this.borderMetaProvider?.();
		let topLeftLabel: string | undefined;
		if (this.embedWorkingStatus && this.workingStatusIndicator) {
			topLeftLabel = this.workingStatusIndicator.renderInBorder(Math.max(1, width - 8));
		}
		const topBorder = this.buildLabeledBorder(width, "╭─", "─╮", topLeftLabel, meta?.rightTop);
		const bottomBorder = this.buildLabeledBorder(width, "╰─", "─╯", meta?.leftBottom, meta?.rightBottom);

		const foundBottom = this.lastRenderedBottomBorder ? lines.indexOf(this.lastRenderedBottomBorder, 1) : -1;
		const bodyStart = 1;
		const bodyEnd = foundBottom !== -1 ? foundBottom : lines.length - 1;

		const result: string[] = [topBorder];
		const leftWall = this.borderColor("│ ");
		const rightWall = this.borderColor(" │");
		for (let i = bodyStart; i < bodyEnd; i++) {
			const line = lines[i] ?? "";
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
			result.push(`${leftWall}${line}${pad}${rightWall}`);
		}
		result.push(bottomBorder);

		// Preserve autocomplete lines below bottom border
		for (let i = bodyEnd + 1; i < lines.length; i++) {
			result.push(`  ${lines[i] ?? ""}`);
		}
		return result;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Always consume key release events cleanly; stop voice recording if Space was released.
		if (isKeyRelease(data)) {
			this.seenKittyKeyRelease = true;
			if (matchesKey(data, "space")) {
				if (this.voiceState === "arming") {
					this.resetVoiceState();
				} else if (this.voiceState === "recording") {
					this.resetVoiceState();
					this.onVoiceHoldStop?.();
				}
			}
			return;
		}

		const isSpaceInput = data === " " || matchesKey(data, "space");
		const isSpaceRepeat = isSpaceInput && isKeyRepeat(data);

		if (this.voiceState === "recording") {
			if (isSpaceInput || isSpaceRepeat) {
				if (this.needsReleaseWatchdog()) {
					this.bumpVoiceReleaseWatchdog();
				}
				return;
			}
			if (this.keybindings.matches(data, "app.interrupt")) {
				this.resetVoiceState();
				this.onVoiceHoldCancel?.();
				return;
			}
		}

		if (this.voiceHoldEnabled && !this.isShowingAutocomplete()) {
			if (isSpaceInput) {
				if (this.voiceState === "arming") {
					this.startVoiceRecording();
					return;
				}
				if (this.voiceState === "idle" && !isSpaceRepeat) {
					this.voiceState = "arming";
					this.voiceArmingInsertedSpace = true;
					super.handleInput(data);
					const delay = isKittyProtocolActive() ? 300 : 1100;
					this.voiceArmingTimer = setTimeout(() => {
						if (this.voiceState !== "arming") return;
						if (isKittyProtocolActive()) {
							this.startVoiceRecording();
						} else {
							this.voiceState = "idle";
							this.voiceArmingInsertedSpace = false;
						}
					}, delay);
					return;
				}
			} else if (this.voiceState === "arming") {
				this.resetVoiceState();
			}
		}

		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Selection page keys move an open autocomplete menu before app actions run.
		// This lets users bind Ctrl+V even though it pastes images by default.
		if (
			this.isShowingAutocomplete() &&
			(this.keybindings.matches(data, "tui.select.pageUp") || this.keybindings.matches(data, "tui.select.pageDown"))
		) {
			super.handleInput(data);
			return;
		}

		// Check for clipboard paste keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Explicit history bindings take precedence over app actions while the editor is focused.
		// This lets users bind Ctrl+P even though it cycles models by default.
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
