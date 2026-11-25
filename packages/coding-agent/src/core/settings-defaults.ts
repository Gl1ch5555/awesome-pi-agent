import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS } from "@earendil-works/pi-ai/utils/retry";

/** Runtime defaults shared by settings accessors and the published JSON Schema. */
export const SETTINGS_DEFAULTS = {
	transport: "auto",
	sessionShareDestination: "auto",
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	compaction: {
		enabled: true,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
	},
	branchSummary: {
		reserveTokens: 16384,
		skipPrompt: false,
	},
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxAgentDelayMs: DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
		provider: {
			maxRetryDelayMs: 60000,
		},
	},
	hideThinkingBlock: false,
	showCacheMissNotices: false,
	quietStartup: false,
	defaultProjectTrust: "ask",
	collapseChangelog: false,
	enableInstallTelemetry: true,
	enableAnalytics: false,
	enableSkillCommands: true,
	terminal: {
		showImages: true,
		imageWidthCells: 60,
		clearOnShrink: false,
		showTerminalProgress: false,
	},
	images: {
		autoResize: true,
		blockImages: false,
	},
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	markdown: {
		codeBlockIndent: "  ",
		mermaid: "streaming",
	},
	warnings: {
		anthropicExtraUsage: true,
	},
	codemode: {
		enabled: false,
		mode: "on",
		inlineBudget: 3000,
	},
	questions: {
		enabled: true,
	},
	cacheWarming: "idle",
	tuiMode: "fullscreen",
	tuiStyle: "native",
	themeAccent: "default",
	fullscreenExitOutput: "transcript",
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	fullscreenWheelScrollLines: "auto",
	voice: {
		enabled: true,
		model: "whisper-large-v3",
		language: "auto",
		holdSpaceToTalk: true,
		chunkIntervalMs: 5000,
	},
	search: {
		enabled: true,
		provider: "tavily",
	},
	memory: {
		reviewEnabled: true,
		nudgeInterval: 10,
		skillReviewMinToolCalls: 3,
		reviewMode: "auto",
	},
	webUi: {
		enabled: true,
		port: 30141,
		host: "127.0.0.1",
	},
	proxy: {
		enabled: false,
		forAi: true,
		forVoice: true,
		forSync: false,
		forWeb: false,
	},
	autoUpdate: "auto",
	onboardingCompleted: false,
} as const;
