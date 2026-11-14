import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { LiveVoiceState } from "../../../core/voice/groq-whisper.ts";
import { theme } from "../theme/theme.ts";

const WAVE_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export class VoiceIndicatorComponent implements Component {
	private state: LiveVoiceState = {
		status: "recording",
		elapsedMs: 0,
		level: 0,
		partialText: "",
	};
	private levelHistory: number[] = [0.08, 0.12, 0.1, 0.14, 0.1, 0.08, 0.12, 0.09];
	private spinnerIdx = 0;

	updateState(next: LiveVoiceState): void {
		this.state = next;
		this.levelHistory.shift();
		this.levelHistory.push(Math.max(0.05, Math.min(1, next.level)));
		this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
	}

	invalidate(): void {
		// Rendered dynamically from latest state
	}

	private formatDuration(ms: number): string {
		const totalSec = Math.max(0, Math.floor(ms / 1000));
		const min = Math.floor(totalSec / 60);
		const sec = totalSec % 60;
		return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	}

	private renderWaveform(): string {
		return this.levelHistory
			.map((val) => {
				const idx = Math.min(WAVE_BARS.length - 1, Math.max(0, Math.floor(val * (WAVE_BARS.length - 1))));
				return WAVE_BARS[idx]!;
			})
			.join("");
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const lines: string[] = [];

		if (this.state.status === "finalizing") {
			const spinner = SPINNER_FRAMES[this.spinnerIdx]!;
			const line = ` ${theme.fg("accent", spinner)} ${theme.fg("muted", "finalizing transcript...")}`;
			lines.push(truncateToWidth(line, width, ""));
		} else {
			const dot = this.spinnerIdx % 4 < 2 ? theme.fg("error", "●") : theme.fg("dim", "○");
			const timer = theme.fg("text", this.formatDuration(this.state.elapsedMs));
			const wave = theme.fg("accent", this.renderWaveform());
			const hint = theme.fg("dim", "release Space to stop · Esc to cancel");
			const header = ` ${dot} ${theme.fg("text", "voice")} ${timer}  ${wave}  ${hint}`;
			lines.push(truncateToWidth(header, width, ""));
		}

		const preview = this.state.partialText.trim();
		if (preview) {
			const prefix = theme.fg("dim", " › ");
			const maxPreviewWidth = Math.max(10, width - 4);
			const clipped = preview.length > maxPreviewWidth ? `...${preview.slice(-(maxPreviewWidth - 3))}` : preview;
			lines.push(truncateToWidth(`${prefix}${theme.fg("muted", clipped)}`, width, ""));
		}

		return lines;
	}
}
