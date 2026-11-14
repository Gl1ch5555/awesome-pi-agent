import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	matchesKey,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import type { StatusIndicator } from "./status-indicator.ts";

export type CustomEditorOptions = EditorOptions & {
	/** Render working, compaction, summarization, and retry status in the editor's top border. */
	embedWorkingStatus?: boolean;
};

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private workingStatusIndicator: StatusIndicator | undefined;
	public readonly embedWorkingStatus: boolean;
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

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, options);
		this.keybindings = keybindings;
		this.embedWorkingStatus = options?.embedWorkingStatus ?? false;
		this.wantsKeyRelease = true;
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

	private startVoiceRecording(): void {
		this.clearVoiceTimers();
		this.removeArmingSpaceIfPresent();
		this.voiceState = "recording";
		if (!isKittyProtocolActive()) {
			this.bumpVoiceReleaseWatchdog();
		}
		this.onVoiceHoldStart?.();
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
		}, 450);
	}

	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void {
		this.workingStatusIndicator = indicator;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
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

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Always consume key release events cleanly; stop voice recording if Space was released.
		if (isKeyRelease(data)) {
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
				if (!isKittyProtocolActive()) {
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
					const delay = isKittyProtocolActive() ? 300 : 650;
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
