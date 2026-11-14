import { type ChildProcess, execFileSync, spawn } from "node:child_process";

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export interface VoiceRecorderEvents {
	onAudioData?: (pcmChunk: Buffer, totalBytes: number, rmsLevel: number) => void;
	onError?: (error: Error) => void;
}

export interface RecorderBackend {
	name: string;
	command: string;
	args: string[];
}

function commandExists(cmd: string): boolean {
	try {
		const checkCmd = process.platform === "win32" ? "where" : "which";
		execFileSync(checkCmd, [cmd], { stdio: "ignore", timeout: 1500 });
		return true;
	} catch {
		return false;
	}
}

function findWindowsDirectShowAudioDevice(): string | undefined {
	try {
		const res = execFileSync("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
			encoding: "utf8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return parseDirectShowAudioDevice(res);
	} catch (error: unknown) {
		const stderr =
			error && typeof error === "object" && "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
		return parseDirectShowAudioDevice(stderr);
	}
}

function parseDirectShowAudioDevice(output: string): string | undefined {
	const lines = output.split(/\r?\n/);
	let inAudioSection = false;
	for (const line of lines) {
		if (line.includes("DirectShow audio devices")) {
			inAudioSection = true;
			continue;
		}
		if (line.includes("(audio)")) {
			const match = line.match(/"([^"]+)"/);
			if (match?.[1]) return match[1];
		}
		if (inAudioSection) {
			const match = line.match(/"([^"]+)"/);
			if (match?.[1] && !line.includes("Alternative name")) return match[1];
		}
	}
	return undefined;
}

function buildWindowsPowerShellRecorderScript(): string {
	// Native Win32 winmm.dll waveIn capture -> 16kHz 16-bit mono PCM written raw to stdout.
	// Stops cleanly when stdin closes or process is terminated.
	return [
		"$ErrorActionPreference = 'Stop'",
		"$code = @'",
		"using System;",
		"using System.IO;",
		"using System.Runtime.InteropServices;",
		"using System.Threading;",
		"public static class PiWaveRecorder {",
		"  [StructLayout(LayoutKind.Sequential)]",
		"  public struct WAVEFORMATEX {",
		"    public ushort wFormatTag; public ushort nChannels; public uint nSamplesPerSec;",
		"    public uint nAvgBytesPerSec; public ushort nBlockAlign; public ushort wBitsPerSample; public ushort cbSize;",
		"  }",
		"  [StructLayout(LayoutKind.Sequential)]",
		"  public struct WAVEHDR {",
		"    public IntPtr lpData; public uint dwBufferLength; public uint dwBytesRecorded;",
		"    public IntPtr dwUser; public uint dwFlags; public uint dwLoops; public IntPtr lpNext; public IntPtr reserved;",
		"  }",
		"  public delegate void WaveInProc(IntPtr hwi, uint uMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);",
		'  [DllImport("winmm.dll")] public static extern int waveInOpen(out IntPtr phwi, int uDeviceID, ref WAVEFORMATEX pwfx, WaveInProc dwCallback, IntPtr dwInstance, uint fdwOpen);',
		'  [DllImport("winmm.dll")] public static extern int waveInPrepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);',
		'  [DllImport("winmm.dll")] public static extern int waveInUnprepareHeader(IntPtr hwi, IntPtr pwh, int cbwh);',
		'  [DllImport("winmm.dll")] public static extern int waveInAddBuffer(IntPtr hwi, IntPtr pwh, int cbwh);',
		'  [DllImport("winmm.dll")] public static extern int waveInStart(IntPtr hwi);',
		'  [DllImport("winmm.dll")] public static extern int waveInStop(IntPtr hwi);',
		'  [DllImport("winmm.dll")] public static extern int waveInReset(IntPtr hwi);',
		'  [DllImport("winmm.dll")] public static extern int waveInClose(IntPtr hwi);',
		"  private const uint CALLBACK_FUNCTION = 0x00030000;",
		"  private const uint WIM_DATA = 0x3C0;",
		"  public static void Run() {",
		"    var fmt = new WAVEFORMATEX { wFormatTag = 1, nChannels = 1, nSamplesPerSec = 16000, wBitsPerSample = 16, nBlockAlign = 2, nAvgBytesPerSec = 32000, cbSize = 0 };",
		"    var stdout = Console.OpenStandardOutput();",
		"    bool running = true;",
		"    IntPtr hwi = IntPtr.Zero;",
		"    var gate = new object();",
		"    WaveInProc cb = (h, msg, inst, p1, p2) => {",
		"      if (msg == WIM_DATA && running && p1 != IntPtr.Zero) {",
		"        var hdr = Marshal.PtrToStructure<WAVEHDR>(p1);",
		"        if (hdr.dwBytesRecorded > 0) {",
		"          byte[] buf = new byte[hdr.dwBytesRecorded];",
		"          Marshal.Copy(hdr.lpData, buf, 0, (int)hdr.dwBytesRecorded);",
		"          lock (gate) { try { stdout.Write(buf, 0, buf.Length); stdout.Flush(); } catch { running = false; } }",
		"        }",
		"        if (running) waveInAddBuffer(h, p1, Marshal.SizeOf<WAVEHDR>());",
		"      }",
		"    };",
		"    int rc = waveInOpen(out hwi, -1, ref fmt, cb, IntPtr.Zero, CALLBACK_FUNCTION);",
		'    if (rc != 0) throw new Exception("waveInOpen failed: " + rc);',
		"    int hdrSize = Marshal.SizeOf<WAVEHDR>();",
		"    int bufSize = 3200;",
		"    var hdrPtrs = new IntPtr[4];",
		"    var dataPtrs = new IntPtr[4];",
		"    for (int i = 0; i < 4; i++) {",
		"      dataPtrs[i] = Marshal.AllocHGlobal(bufSize);",
		"      var hdr = new WAVEHDR { lpData = dataPtrs[i], dwBufferLength = (uint)bufSize };",
		"      hdrPtrs[i] = Marshal.AllocHGlobal(hdrSize);",
		"      Marshal.StructureToPtr(hdr, hdrPtrs[i], false);",
		"      waveInPrepareHeader(hwi, hdrPtrs[i], hdrSize);",
		"      waveInAddBuffer(hwi, hdrPtrs[i], hdrSize);",
		"    }",
		"    waveInStart(hwi);",
		"    var stdin = Console.In;",
		"    while (running && stdin.Read() != -1) { Thread.Sleep(20); }",
		"    running = false;",
		"    waveInStop(hwi);",
		"    waveInReset(hwi);",
		"    lock (gate) { try { stdout.Flush(); } catch {} }",
		"    for (int i = 0; i < 4; i++) {",
		"      waveInUnprepareHeader(hwi, hdrPtrs[i], hdrSize);",
		"      Marshal.FreeHGlobal(hdrPtrs[i]);",
		"      Marshal.FreeHGlobal(dataPtrs[i]);",
		"    }",
		"    waveInClose(hwi);",
		"    GC.KeepAlive(cb);",
		"  }",
		"}",
		"'@",
		"Add-Type -TypeDefinition $code",
		"[PiWaveRecorder]::Run()",
	].join("\n");
}

function findLinuxFfmpegInput(): { format: string; input: string } | undefined {
	try {
		const out = execFileSync("ffmpeg", ["-hide_banner", "-devices"], {
			encoding: "utf8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (/\bpulse\b/.test(out)) return { format: "pulse", input: "default" };
		if (/\balsa\b/.test(out)) return { format: "alsa", input: "default" };
		if (/\boss\b/.test(out)) return { format: "oss", input: "/dev/dsp" };
	} catch {
		// ignore and try -formats
	}
	try {
		const out = execFileSync("ffmpeg", ["-hide_banner", "-formats"], {
			encoding: "utf8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (/\bpulse\b/.test(out)) return { format: "pulse", input: "default" };
		if (/\balsa\b/.test(out)) return { format: "alsa", input: "default" };
		if (/\boss\b/.test(out)) return { format: "oss", input: "/dev/dsp" };
	} catch {
		// ignore
	}
	return undefined;
}

let cachedRecorderBackend: { platform: string; backend: RecorderBackend | undefined } | undefined;

export function resetRecorderBackendCache(): void {
	cachedRecorderBackend = undefined;
}

export function warmupRecorderBackend(): RecorderBackend | undefined {
	if (cachedRecorderBackend && cachedRecorderBackend.platform === process.platform) {
		return cachedRecorderBackend.backend;
	}
	const backend = detectRecorderBackendUncached();
	cachedRecorderBackend = { platform: process.platform, backend };
	return backend;
}

export function detectRecorderBackend(): RecorderBackend | undefined {
	return warmupRecorderBackend();
}

function detectRecorderBackendUncached(): RecorderBackend | undefined {
	const p = process.platform;
	if (p === "linux") {
		if (commandExists("parecord")) {
			return {
				name: "parecord",
				command: "parecord",
				args: ["--format=s16le", "--rate=16000", "--channels=1", "--raw", "--latency-msec=50"],
			};
		}
		if (commandExists("arecord")) {
			return {
				name: "arecord",
				command: "arecord",
				args: ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", "-t", "raw"],
			};
		}
		if (commandExists("ffmpeg")) {
			const linuxInput = findLinuxFfmpegInput();
			if (linuxInput) {
				return {
					name: `ffmpeg-${linuxInput.format}`,
					command: "ffmpeg",
					args: [
						"-loglevel",
						"error",
						"-f",
						linuxInput.format,
						"-i",
						linuxInput.input,
						"-ar",
						"16000",
						"-ac",
						"1",
						"-f",
						"s16le",
						"pipe:1",
					],
				};
			}
		}
		if (commandExists("sox")) {
			return {
				name: "sox",
				command: "sox",
				args: ["-q", "-d", "-t", "raw", "-r", "16000", "-e", "signed", "-b", "16", "-c", "1", "-"],
			};
		}
		return undefined;
	}

	if (p === "darwin") {
		if (commandExists("sox")) {
			return {
				name: "sox",
				command: "sox",
				args: ["-q", "-d", "-t", "raw", "-r", "16000", "-e", "signed", "-b", "16", "-c", "1", "-"],
			};
		}
		if (commandExists("ffmpeg")) {
			return {
				name: "ffmpeg",
				command: "ffmpeg",
				args: [
					"-loglevel",
					"error",
					"-f",
					"avfoundation",
					"-i",
					":0",
					"-ar",
					"16000",
					"-ac",
					"1",
					"-f",
					"s16le",
					"pipe:1",
				],
			};
		}
		return undefined;
	}

	if (p === "win32") {
		if (commandExists("ffmpeg")) {
			const audioDevice = findWindowsDirectShowAudioDevice();
			if (audioDevice) {
				return {
					name: "ffmpeg-dshow",
					command: "ffmpeg",
					args: [
						"-loglevel",
						"error",
						"-f",
						"dshow",
						"-i",
						`audio=${audioDevice}`,
						"-ar",
						"16000",
						"-ac",
						"1",
						"-f",
						"s16le",
						"pipe:1",
					],
				};
			}
		}
		const psCmd = commandExists("pwsh") ? "pwsh" : commandExists("powershell.exe") ? "powershell.exe" : undefined;
		if (psCmd) {
			const encoded = Buffer.from(buildWindowsPowerShellRecorderScript(), "utf16le").toString("base64");
			return {
				name: "powershell-winmm",
				command: psCmd,
				args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
			};
		}
		return undefined;
	}

	return undefined;
}

export function pcmToWav(pcmBuffer: Buffer): Buffer {
	const header = Buffer.alloc(44);
	const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
	const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcmBuffer.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(BITS_PER_SAMPLE, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcmBuffer.length, 40);

	return Buffer.concat([header, pcmBuffer]);
}

export function computePcmRmsLevel(chunk: Buffer): number {
	const sampleCount = Math.floor(chunk.length / 2);
	if (sampleCount === 0) return 0;
	let sumSq = 0;
	for (let i = 0; i < sampleCount * 2; i += 2) {
		const sample = chunk.readInt16LE(i) / 32768;
		sumSq += sample * sample;
	}
	const rms = Math.sqrt(sumSq / sampleCount);
	// Scale voice energy into a responsive 0..1 range
	return Math.min(1, rms * 4.5);
}

export class VoiceRecorder {
	private proc: ChildProcess | undefined;
	private backendName: string | undefined;
	private chunks: Buffer[] = [];
	private totalBytes = 0;
	private stderrText = "";
	private stopped = false;

	start(events: VoiceRecorderEvents = {}): RecorderBackend {
		const backend = detectRecorderBackend();
		if (!backend) {
			const isTermux = Boolean(process.env.TERMUX_VERSION) || process.env.PREFIX?.includes("com.termux");
			throw new Error(
				isTermux
					? "No audio input backend found on Termux (ffmpeg lacks pulse/alsa). Run: pkg install pulseaudio && pulseaudio --start --load='module-sles-source'"
					: process.platform === "linux"
						? "No microphone recorder found (install pulseaudio-utils `parecord`, alsa-utils `arecord`, `sox`, or `ffmpeg` with pulse/alsa)"
						: "No microphone recorder available on this system",
			);
		}

		this.chunks = [];
		this.totalBytes = 0;
		this.stderrText = "";
		this.stopped = false;
		this.backendName = backend.name;

		const useStdinPipe = backend.name === "powershell-winmm" || backend.name === "ffmpeg-dshow";
		this.proc = spawn(backend.command, backend.args, {
			stdio: [useStdinPipe ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		this.proc.stdout?.on("data", (data: Buffer) => {
			if (this.stopped) return;
			this.chunks.push(data);
			this.totalBytes += data.length;
			const rms = computePcmRmsLevel(data);
			events.onAudioData?.(data, this.totalBytes, rms);
		});

		this.proc.stderr?.on("data", (data: Buffer) => {
			if (this.stderrText.length < 1000) {
				this.stderrText += data.toString("utf8");
			}
		});

		this.proc.on("error", (err) => {
			if (!this.stopped) {
				events.onError?.(err);
			}
		});

		this.proc.on("close", (code) => {
			if (!this.stopped && code && code !== 0) {
				events.onError?.(
					new Error(
						`Audio recorder (${backend.name}) exited with code ${code}${this.stderrText.trim() ? `: ${this.stderrText.trim()}` : ""}`,
					),
				);
			}
		});

		return backend;
	}

	getPcmBuffer(): Buffer {
		return this.chunks.length > 0 ? Buffer.concat(this.chunks, this.totalBytes) : Buffer.alloc(0);
	}

	getDurationMs(): number {
		return Math.round((this.totalBytes / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8))) * 1000);
	}

	async stop(): Promise<Buffer> {
		this.stopped = true;
		const proc = this.proc;
		const backendName = this.backendName;
		this.proc = undefined;
		this.backendName = undefined;
		if (proc && proc.exitCode === null) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						// ignore
					}
					resolve();
				}, 700);
				proc.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
				try {
					if (backendName === "ffmpeg-dshow") {
						proc.stdin?.write("q\n");
					}
					proc.stdin?.end();
					// On Windows, SIGTERM invokes TerminateProcess immediately before stdout flushes;
					// let powershell-winmm / ffmpeg-dshow exit cleanly via stdin EOF / 'q' first.
					if (process.platform !== "win32") {
						proc.kill("SIGTERM");
					}
				} catch {
					clearTimeout(timer);
					resolve();
				}
			});
		}
		return this.getPcmBuffer();
	}
}
