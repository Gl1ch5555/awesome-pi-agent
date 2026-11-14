import type { VoiceModel } from "../settings-schema.ts";
import { pcmToWav, VoiceRecorder } from "./voice-recorder.ts";

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const PCM_BYTES_PER_SECOND = 16_000 * 2; // 16kHz * 16-bit mono
const MAX_PREVIEW_WINDOW_BYTES = 25 * PCM_BYTES_PER_SECOND;
const MAX_FINAL_CHUNK_BYTES = 240 * PCM_BYTES_PER_SECOND; // ~7.6 MB per WAV chunk

/** Shared across voice sessions so hitting Groq RPM pauses live previews across back-to-back dictations. */
let globalPreviewCooldownUntil = 0;

export interface GroqTranscribeOptions {
	wavBuffer: Buffer;
	apiKey: string;
	model?: VoiceModel;
	language?: string;
	prompt?: string;
	signal?: AbortSignal;
	retryOnRateLimit?: boolean;
}

class GroqRateLimitError extends Error {
	readonly retryAfterMs: number;
	constructor(message: string, retryAfterMs: number) {
		super(message);
		this.retryAfterMs = retryAfterMs;
	}
}

function parseGroqRetryAfterMs(res: Response, errText: string): number {
	const header = res.headers.get("retry-after");
	if (header) {
		const sec = Number(header);
		if (Number.isFinite(sec) && sec > 0) {
			return Math.min(12_000, Math.max(1_000, Math.ceil(sec * 1000)));
		}
	}
	const match = errText.match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|s|m)/i);
	if (match) {
		const num = Number(match[1]);
		const unit = match[2]!.toLowerCase();
		if (Number.isFinite(num) && num > 0) {
			const ms = unit === "ms" ? num : unit === "m" ? num * 60_000 : num * 1000;
			return Math.min(12_000, Math.max(1_000, Math.ceil(ms + 250)));
		}
	}
	return 3_500;
}

export async function transcribeAudioWithGroq(options: GroqTranscribeOptions): Promise<string> {
	const primaryModel: VoiceModel = options.model ?? "whisper-large-v3";
	const modelsToTry: VoiceModel[] =
		options.retryOnRateLimit && primaryModel !== "whisper-large-v3-turbo"
			? [primaryModel, "whisper-large-v3-turbo"]
			: [primaryModel];
	const maxAttemptsPerModel = options.retryOnRateLimit ? 3 : 1;

	let lastRateLimitError: GroqRateLimitError | undefined;

	for (const model of modelsToTry) {
		for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
			const form = new FormData();
			const blob = new Blob([new Uint8Array(options.wavBuffer)], { type: "audio/wav" });
			form.append("file", blob, "voice.wav");
			form.append("model", model);
			form.append("response_format", "json");
			if (options.language && options.language !== "auto") {
				form.append("language", options.language);
			}
			if (options.prompt && options.prompt.trim().length > 0) {
				form.append("prompt", options.prompt.trim().slice(-200));
			}

			const timeoutSignal = AbortSignal.timeout(25_000);
			const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

			const res = await fetch(GROQ_TRANSCRIPTION_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.apiKey}`,
				},
				body: form,
				signal,
			});

			if (res.ok) {
				const data = (await res.json()) as { text?: string };
				return (data.text ?? "").trim();
			}

			const errText = await res.text().catch(() => "");
			if (res.status === 429) {
				const retryAfterMs = parseGroqRetryAfterMs(res, errText);
				globalPreviewCooldownUntil = Math.max(
					globalPreviewCooldownUntil,
					Date.now() + Math.max(25_000, retryAfterMs),
				);
				lastRateLimitError = new GroqRateLimitError(
					`Groq Whisper error (${res.status}): ${errText.slice(0, 240) || res.statusText}`,
					retryAfterMs,
				);
				if (attempt < maxAttemptsPerModel && !options.signal?.aborted) {
					await new Promise((r) => setTimeout(r, retryAfterMs));
					continue;
				}
				break;
			}
			throw new Error(`Groq Whisper error (${res.status}): ${errText.slice(0, 240) || res.statusText}`);
		}
	}

	if (lastRateLimitError) throw lastRateLimitError;
	return "";
}

export interface LiveVoiceSessionCallbacks {
	onUpdate: (state: LiveVoiceState) => void;
	onError: (error: Error) => void;
}

export interface LiveVoiceState {
	status: "recording" | "finalizing";
	elapsedMs: number;
	level: number;
	partialText: string;
}

export interface LiveVoiceSessionOptions {
	apiKey: string;
	model?: VoiceModel;
	language?: string;
	chunkIntervalMs?: number;
}

export class LiveVoiceSession {
	private recorder = new VoiceRecorder();
	private readonly options: LiveVoiceSessionOptions;
	private readonly callbacks: LiveVoiceSessionCallbacks;
	private startedAt = 0;
	private currentLevel = 0;
	private partialText = "";
	private lastPreviewBytes = 0;
	private previewInFlight = false;
	private previewRateLimitedUntil = 0;
	private previewAbort: AbortController | undefined;
	private previewTimer: ReturnType<typeof setInterval> | undefined;
	private uiTimer: ReturnType<typeof setInterval> | undefined;
	private finished = false;
	private prefixCommittedText = "";

	constructor(options: LiveVoiceSessionOptions, callbacks: LiveVoiceSessionCallbacks) {
		this.options = options;
		this.callbacks = callbacks;
	}

	start(): void {
		this.startedAt = Date.now();
		this.finished = false;
		this.partialText = "";
		this.prefixCommittedText = "";
		this.lastPreviewBytes = 0;
		this.previewRateLimitedUntil = 0;

		this.recorder.start({
			onAudioData: (_chunk, _total, rms) => {
				// Smooth decay + quick rise for clean level visualization
				this.currentLevel = rms > this.currentLevel ? rms : this.currentLevel * 0.65 + rms * 0.35;
			},
			onError: (err) => {
				if (!this.finished) {
					this.callbacks.onError(err);
				}
			},
		});

		this.uiTimer = setInterval(() => {
			if (this.finished) return;
			this.currentLevel *= 0.85;
			this.emitState("recording");
		}, 90);

		const intervalMs = Math.max(4000, this.options.chunkIntervalMs ?? 5000);
		this.previewTimer = setInterval(() => {
			void this.runPreviewChunk();
		}, intervalMs);

		this.emitState("recording");
	}

	private emitState(status: "recording" | "finalizing"): void {
		this.callbacks.onUpdate({
			status,
			elapsedMs: Date.now() - this.startedAt,
			level: this.currentLevel,
			partialText: this.partialText,
		});
	}

	private async runPreviewChunk(): Promise<void> {
		if (this.finished || this.previewInFlight) return;
		const now = Date.now();
		if (now < this.previewRateLimitedUntil || now < globalPreviewCooldownUntil) return;
		const pcm = this.recorder.getPcmBuffer();
		// Wait until at least 1.5s of audio has arrived and at least 1.5s since last preview
		if (pcm.length < PCM_BYTES_PER_SECOND * 1.5) return;
		if (pcm.length - this.lastPreviewBytes < PCM_BYTES_PER_SECOND * 1.5) return;

		this.previewInFlight = true;
		const controller = new AbortController();
		this.previewAbort = controller;
		const snapshotBytes = pcm.length;

		try {
			const windowPcm =
				pcm.length > MAX_PREVIEW_WINDOW_BYTES ? pcm.subarray(pcm.length - MAX_PREVIEW_WINDOW_BYTES) : pcm;
			const wav = pcmToWav(windowPcm);
			const text = await transcribeAudioWithGroq({
				wavBuffer: wav,
				apiKey: this.options.apiKey,
				model: this.options.model,
				language: this.options.language,
				prompt: this.prefixCommittedText,
				signal: controller.signal,
				retryOnRateLimit: false,
			});
			if (!this.finished && text) {
				this.lastPreviewBytes = snapshotBytes;
				this.partialText = text;
				this.emitState("recording");
			}
		} catch (err) {
			// Pause live previews on 429 so we preserve RPM budget for the final transcription
			if (err instanceof GroqRateLimitError) {
				this.previewRateLimitedUntil = Date.now() + Math.max(10_000, err.retryAfterMs);
			}
		} finally {
			if (this.previewAbort === controller) {
				this.previewAbort = undefined;
			}
			this.previewInFlight = false;
		}
	}

	async stop(): Promise<string> {
		this.finished = true;
		if (this.previewTimer) {
			clearInterval(this.previewTimer);
			this.previewTimer = undefined;
		}
		if (this.uiTimer) {
			clearInterval(this.uiTimer);
			this.uiTimer = undefined;
		}
		this.previewAbort?.abort();
		this.previewAbort = undefined;

		this.emitState("finalizing");
		const pcm = await this.recorder.stop();

		// Ignore accidental ultra-short clicks (< 0.25s)
		if (pcm.length < PCM_BYTES_PER_SECOND * 0.25) {
			return "";
		}

		// Transcribe complete recording (split into sequential chunks only if > ~4 minutes)
		const segments: string[] = [];
		let promptHint = "";
		try {
			for (let offset = 0; offset < pcm.length; offset += MAX_FINAL_CHUNK_BYTES) {
				const slice = pcm.subarray(offset, Math.min(pcm.length, offset + MAX_FINAL_CHUNK_BYTES));
				if (slice.length < PCM_BYTES_PER_SECOND * 0.2) continue;
				const text = await transcribeAudioWithGroq({
					wavBuffer: pcmToWav(slice),
					apiKey: this.options.apiKey,
					model: this.options.model,
					language: this.options.language,
					prompt: promptHint,
					retryOnRateLimit: true,
				});
				if (text) {
					segments.push(text);
					promptHint = text;
				}
			}
		} catch (err) {
			if (segments.length > 0) return segments.join(" ").trim();
			if (this.partialText.trim()) return this.partialText.trim();
			throw err;
		}

		return segments.join(" ").trim();
	}

	async cancel(): Promise<void> {
		this.finished = true;
		if (this.previewTimer) {
			clearInterval(this.previewTimer);
			this.previewTimer = undefined;
		}
		if (this.uiTimer) {
			clearInterval(this.uiTimer);
			this.uiTimer = undefined;
		}
		this.previewAbort?.abort();
		this.previewAbort = undefined;
		await this.recorder.stop();
	}
}
