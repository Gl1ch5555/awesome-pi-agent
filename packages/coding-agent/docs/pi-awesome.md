# pi-awesome (awesome-pi-agent)

- **Repository:** https://github.com/Gl1ch5555/awesome-pi-agent
- **Creator / Maintainer:** [Gl1ch5555](https://github.com/Gl1ch5555)
- **Base:** Customized fork of [Pi](https://github.com/earendil-works/pi)
- **Config directory:** `~/.pi-awesome/agent/` (isolated from upstream `~/.pi/agent/`)
- **Changelog:** `CHANGELOG.md` in the package root (also shown via `/changelog` and after `/update`)

## Why pi-awesome exists

`pi-awesome` turns `pi` into a fast, zero-bloat, cross-platform terminal & browser coding agent tailored for real-world daily workflows (Linux, macOS, Windows, Termux/proot, and mobile PWA):

1. **Zero-clutter Graphite UI + UI Packs:** Default `graphite` theme with zero emojis, compact `<model> • <thinkingLevel>` footer, switchable `tuiStyle` presets (`native`, `rounded`, `compact`, `opentui`, `sageveil`, `claude-code`, `codex-cli`, `opencode`, `kiro-cli`, `gemini-cli`), independent `themeAccent`, and one-click `UI pack` bundles in `/settings`.
2. **Experimental Code Mode (`codemode`):** Runs LLM-written JavaScript in an isolated QuickJS WASM sandbox (`tools.*`, `store()`/`load()`, `models.*`, `searchTools()`, `describeTool()`, `exit()`) to batch and parallelize reads, searches, and shell calls in a single turn. Toggleable in `/settings` (`Experimental Code Mode`) or `PI_EXPERIMENTAL_CODE_MODE=1`.
3. **Zero-Token Code Map (`/map` + `outline()`):** Local zero-dependency symbol extractor (`src/core/code-outline.ts`) for TS/JS, Python, Go, Rust, C/C++, Java/C#, Ruby, PHP, and Markdown.
   - `/map [path]` displays file/directory outlines with line numbers directly in the TUI using **0 LLM tokens**.
   - `await outline(path?, { maxFiles?, maxDepth?, maxSymbolsPerFile? })` inside `codemode` lets the agent inspect large files before reading specific line ranges, cutting read token usage by 60–85%.
4. **Recent 6 Models Quick-Switch (`/model`, `Alt+1..6`, `/swap` / `Alt+L`):** Tracks the last 6 used models (`settings.recentModels`) and pins them at the top of `/model` (`Ctrl+L`) and Web UI. Supports instant `Alt+1..6` quick-pick, `/model 1..6`, and one-key `Alt+L` / `/swap` toggling between the current and previous model.
5. **Question Test Mode (`ask_questions`):** Lets the agent ask 1–40 compact test-style multiple-choice questions at once in both TUI (`QuizDialogComponent`) and Web UI, returning compact answers without echoing options back into LLM context.
6. **Parallel Local Web UI (`--web` / `/web`):** Built-in responsive browser/PWA workspace synced in real time with the TUI session (`AgentSessionRuntime` + SSE), featuring collapsible project/session sidebar, `/` commands, `@` project files, skills, image/file drag-and-drop, voice input, context ring, and full 4-tab `SettingsModal`.
7. **Encrypted Cloud Sync (`/sync`):** Syncs settings, API keys, custom providers, models, memory, skills, prompts, themes, and plugins via `https://grzxk.ru/pi-sync/` (with automatic fallback mirror).
8. **Scoped Proxy (`/settings` -> `Proxy`):** HTTP/HTTPS/SOCKS5/SOCKS5h proxy with independent toggles for AI, Voice, Sync, and Web traffic.
9. **Hold-Space Live Voice Input:** Chunked transcription via Groq Whisper (`whisper-large-v3` with automatic `whisper-large-v3-turbo` fallback and 429 rate-limit protection).
10. **Hermes-Style Memory & Skills (`/memory`, `skill_manage`):** Three isolated stores (`project`, `memory`, `user`), frozen at session start to preserve 100% LLM prompt cache, plus periodic background memory/skill review.
11. **Custom Providers (`/providers`) & Gemini 4 Support:** Stepwise OpenAI-compatible provider setup with `/v1/models` discovery, `maxTokens` family inference, `google.thinking_config`, `<think>` filtering, and `thought_signature` preservation.
12. **Self-Update (`/update`) with Changelog Preview:** Parallel 4-stream prebuilt binary updates from GitHub Releases (`latest`), side-by-side Windows updates in `versions/`, and automatic changelog display.
