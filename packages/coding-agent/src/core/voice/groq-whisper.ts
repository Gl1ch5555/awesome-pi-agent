import type { VoiceModel } from "../settings-schema.ts";
import { pcmToWav, VoiceRecorder } from "./voice-recorder.ts";

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const PCM_BYTES_PER_SECOND = 16_000 * 2; // 16kHz * 16-bit mono
const MAX_PREVIEW_WINDOW_BYTES = 25 * PCM_BYTES_PER_SECOND;
const MAX_FINAL_CHUNK_BYTES = 240 * PCM_BYTES_PER_SECOND; // ~7.6 MB per WAV chunk

export interface GroqTranscribeOptions {
	wavBuffer: Buffer;
	apiKey: string;
	model?: VoiceModel;
	language?: string;
	prompt?: string;
	signal?: AbortSignal;
}

export async function transcribeAudioWithGroq(options: GroqTranscribeOptions): Promise<string> {
	const form = new FormData();
	const blob = new Blob([new Uint8Array(options.wavBuffer)], { type: "audio/wav" });
	form.append("file", blob, "voice.wav");
	form.append("model", options.model ?? "whisper-large-v3");
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

	if (!res.ok) {
		const errText = await res.text().catch(() => "");
		throw new Error(`Groq Whisper error (${res.status}): ${errText.slice(0, 240) || res.statusText}`);
	}

	const data = (await res.json()) as { text?: string };
	return (data.text ?? "").trim();
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

		const intervalMs = Math.max(700, this.options.chunkIntervalMs ?? 1500);
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
		const pcm = this.recorder.getPcmBuffer();
		// Wait until at least 0.5s of new audio has arrived since last preview
		if (pcm.length < PCM_BYTES_PER_SECOND * 0.5) return;
		if (pcm.length - this.lastPreviewBytes < PCM_BYTES_PER_SECOND * 0.45) return;

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
			});
			if (!this.finished && text) {
				this.lastPreviewBytes = snapshotBytes;
				this.partialText = text;
				this.emitState("recording");
			}
		} catch {
			// Preview chunk errors shouldn't break recording; final pass will run cleanly
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
		for (let offset = 0; offset < pcm.length; offset += MAX_FINAL_CHUNK_BYTES) {
			const slice = pcm.subarray(offset, Math.min(pcm.length, offset + MAX_FINAL_CHUNK_BYTES));
			if (slice.length < PCM_BYTES_PER_SECOND * 0.2) continue;
			const text = await transcribeAudioWithGroq({
				wavBuffer: pcmToWav(slice),
				apiKey: this.options.apiKey,
				model: this.options.model,
				language: this.options.language,
				prompt: promptHint,
			});
			if (text) {
				segments.push(text);
				promptHint = text;
			}
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
