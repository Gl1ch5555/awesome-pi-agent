export const PI_WEB_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#d1c1ff"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="30" fill="#09090b"/>
  <rect x="4" y="4" width="120" height="120" rx="26" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <path d="M32 42h64M48 42v46M78 42v36c0 7 4 10 10 10h6" fill="none" stroke="url(#g)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const PI_WEB_MANIFEST = JSON.stringify(
	{
		name: "pi-awesome",
		short_name: "pi",
		description: "Local Web UI & PWA for pi-awesome coding agent",
		start_url: "/",
		display: "standalone",
		background_color: "#09090b",
		theme_color: "#09090b",
		icons: [
			{
				src: "/icon.svg",
				sizes: "any",
				type: "image/svg+xml",
				purpose: "any maskable",
			},
		],
	},
	null,
	2,
);

export const PI_WEB_SW_JS = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
`;

export function renderWebUiHtml(): string {
	return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#09090b">
<title>pi-awesome</title>
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="manifest" href="/manifest.webmanifest">
<style>
  :root, [data-theme="dark"] {
    --bg: #09090b;
    --surface: #111114;
    --surface2: #18181b;
    --composer: #2a2a2c;
    --context-bar: rgba(39, 39, 42, 0.72);
    --border: rgba(255, 255, 255, 0.08);
    --border-strong: rgba(255, 255, 255, 0.14);
    --text: #f4f4f5;
    --muted: #a1a1aa;
    --dim: #71717a;
    --accent: #d1c1ff;
    --accent-solid: #8b5cf6;
    --accent-soft: rgba(139, 92, 246, 0.16);
    --user-bubble: #27272a;
    --user-text: #f4f4f5;
    --send-bg: #f4f4f5;
    --send-fg: #09090b;
    --green: #4ade80;
    --red: #f87171;
    --amber: #fbbf24;
    --shadow: 0 16px 42px -16px rgba(0, 0, 0, 0.85);
    --mono: "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  [data-theme="light"] {
    --bg: #fafafa;
    --surface: #ffffff;
    --surface2: #f4f4f5;
    --composer: #ffffff;
    --context-bar: #f4f4f5;
    --border: rgba(24, 24, 27, 0.09);
    --border-strong: rgba(24, 24, 27, 0.16);
    --text: #18181b;
    --muted: #52525b;
    --dim: #71717a;
    --accent: #7c3aed;
    --accent-solid: #7c3aed;
    --accent-soft: rgba(124, 58, 237, 0.10);
    --user-bubble: #f4f4f5;
    --user-text: #18181b;
    --send-bg: #18181b;
    --send-fg: #fafafa;
    --green: #16a34a;
    --red: #dc2626;
    --amber: #d97706;
    --shadow: 0 12px 32px -14px rgba(24, 24, 27, 0.22);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14.5px; overflow: hidden; }
  button, input, textarea { font-family: inherit; color: inherit; }

  .app { display: flex; height: 100dvh; width: 100%; position: relative; }

  .sidebar {
    width: 288px; min-width: 288px; background: var(--surface); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; height: 100%; z-index: 40; transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), width 0.2s;
  }
  .sidebar.collapsed { width: 0; min-width: 0; overflow: hidden; border-right: none; }
  .sidebar-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 35; backdrop-filter: blur(2px); }
  .sidebar-backdrop.open { display: block; }

  .sidebar-top {
    padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; align-items: center; gap: 9px; font-weight: 650; font-size: 14px; letter-spacing: -0.01em; }
  .brand img { width: 22px; height: 22px; border-radius: 6px; }

  .icon-btn {
    width: 32px; height: 32px; border-radius: 9px; border: 1px solid transparent; background: transparent;
    color: var(--muted); display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .icon-btn:hover { background: var(--surface2); color: var(--text); }
  .pill-btn {
    height: 30px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface2);
    color: var(--text); font-size: 12.5px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .pill-btn:hover { border-color: var(--border-strong); }

  .seg-tabs {
    margin: 10px 12px 6px; padding: 3px; background: var(--surface2); border-radius: 10px; display: flex; gap: 2px;
    border: 1px solid var(--border);
  }
  .seg-tab {
    flex: 1; padding: 6px 8px; border-radius: 7px; text-align: center; font-size: 12.5px; font-weight: 500;
    color: var(--muted); cursor: pointer; transition: background 0.15s, color 0.15s;
  }
  .seg-tab.active { background: var(--surface); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,0.2); }

  .search-wrap { padding: 4px 12px 8px; }
  .search-input {
    width: 100%; height: 32px; border-radius: 9px; border: 1px solid var(--border); background: var(--bg);
    padding: 0 10px; font-size: 12.5px; color: var(--text); outline: none;
  }
  .search-input:focus { border-color: var(--accent-solid); }

  .sidebar-body { flex: 1; overflow-y: auto; padding: 4px 10px 14px; }
  .group-label {
    font-size: 11px; font-weight: 600; color: var(--dim); text-transform: uppercase; letter-spacing: 0.04em;
    padding: 10px 8px 4px;
  }
  .list-item {
    padding: 8px 10px; border-radius: 9px; cursor: pointer; display: flex; align-items: center; gap: 8px;
    font-size: 13px; color: var(--muted); margin-bottom: 2px; transition: background 0.12s, color 0.12s;
  }
  .list-item:hover { background: var(--surface2); color: var(--text); }
  .list-item.active { background: var(--accent-soft); color: var(--text); font-weight: 500; }
  .list-item .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list-item .meta { font-size: 11px; color: var(--dim); font-family: var(--mono); }

  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100%; position: relative; }

  .thread-header {
    height: 52px; padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--bg);
    display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0;
  }
  .header-left, .header-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .breadcrumb { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); min-width: 0; }
  .breadcrumb .proj {
    font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px;
  }
  .shimmer-status {
    font-size: 12.5px; font-weight: 500; display: none; align-items: center; gap: 6px;
    background: linear-gradient(90deg, var(--dim) 0%, var(--accent) 50%, var(--dim) 100%);
    background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
    animation: shimmer 1.6s infinite linear;
  }
  .shimmer-status.active { display: inline-flex; }
  @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  .ctx-wrap { position: relative; }
  .ctx-pill {
    height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
    display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; font-family: var(--mono); color: var(--muted);
    cursor: pointer;
  }
  .ctx-bar-mini { width: 28px; height: 5px; border-radius: 999px; background: var(--surface2); overflow: hidden; }
  .ctx-bar-fill { height: 100%; background: var(--accent-solid); width: 0%; transition: width 0.25s; }
  .ctx-popover {
    position: absolute; right: 0; top: 36px; width: 240px; padding: 12px; border-radius: 14px;
    background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow); z-index: 45; display: none;
  }
  .ctx-popover.open { display: block; }
  .ctx-row { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-top: 6px; }

  .chat-scroll { flex: 1; overflow-y: auto; padding: 20px 16px 16px; scroll-behavior: smooth; }
  .chat-inner { max-width: 780px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; min-height: 100%; }

  .empty-state {
    margin: auto 0; padding: 32px 12px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 18px;
  }
  .empty-badge {
    width: 46px; height: 46px; border-radius: 14px; background: var(--surface2); border: 1px solid var(--border);
    display: grid; place-items: center;
  }
  .empty-title { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  .empty-sub { font-size: 13.5px; color: var(--muted); max-width: 420px; line-height: 1.5; }
  .chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; max-width: 620px; }
  .chip {
    padding: 8px 14px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
    font-size: 13px; color: var(--muted); cursor: pointer; transition: border-color 0.15s, color 0.15s, background 0.15s;
  }
  .chip:hover { border-color: var(--accent-solid); color: var(--text); background: var(--surface2); }

  .msg-row { display: flex; flex-direction: column; gap: 6px; }
  .msg-user-wrap { display: flex; justify-content: flex-end; }
  .msg-user {
    max-width: 82%; background: var(--user-bubble); color: var(--user-text); border-radius: 20px; border-bottom-right-radius: 6px;
    padding: 10px 15px; font-size: 14.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
    border: 1px solid var(--border);
  }
  .msg-assistant { display: flex; flex-direction: column; gap: 10px; line-height: 1.65; word-break: break-word; }
  .msg-assistant p { margin-bottom: 8px; }
  .msg-assistant p:last-child { margin-bottom: 0; }
  .msg-assistant ul, .msg-assistant ol { padding-left: 20px; margin: 6px 0; }
  .msg-assistant code {
    font-family: var(--mono); background: var(--surface2); padding: 2px 5px; border-radius: 5px; font-size: 12.5px;
    border: 1px solid var(--border);
  }
  .code-block {
    background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin: 8px 0;
  }
  .code-head {
    display: flex; align-items: center; justify-content: space-between; padding: 6px 12px;
    background: var(--surface2); border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 11.5px; color: var(--muted);
  }
  .code-copy { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 11.5px; }
  .code-copy:hover { color: var(--text); }
  .code-block pre { padding: 12px; overflow-x: auto; font-family: var(--mono); font-size: 12.5px; line-height: 1.5; }
  .code-block pre code { background: none; border: none; padding: 0; }

  .reasoning-box {
    border: 1px solid var(--border); background: var(--surface); border-radius: 12px; overflow: hidden;
  }
  .reasoning-box summary {
    padding: 8px 12px; cursor: pointer; font-size: 12.5px; font-weight: 500; color: var(--muted);
    display: flex; align-items: center; gap: 8px; user-select: none; list-style: none;
  }
  .reasoning-content {
    padding: 8px 12px 10px; font-size: 13px; color: var(--muted); white-space: pre-wrap; line-height: 1.5;
    border-top: 1px solid var(--border); max-height: 280px; overflow-y: auto;
  }

  .tool-step {
    border: 1px solid var(--border); background: var(--surface); border-radius: 12px; overflow: hidden;
  }
  .tool-step-head {
    padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    cursor: pointer; font-size: 12.5px;
  }
  .tool-step-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .step-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
  .step-dot.running { background: var(--amber); animation: pulse 1s infinite; }
  .step-dot.err { background: var(--red); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
  .tool-label { font-family: var(--mono); font-weight: 600; color: var(--text); }
  .tool-arg { font-family: var(--mono); color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tool-step-body {
    padding: 10px 12px; border-top: 1px solid var(--border); font-family: var(--mono); font-size: 12px;
    color: var(--muted); white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow-y: auto;
    background: var(--bg);
  }

  .msg-actions { display: flex; align-items: center; gap: 4px; margin-top: 2px; }
  .act-btn {
    height: 26px; padding: 0 8px; border-radius: 7px; border: 1px solid transparent; background: transparent;
    color: var(--dim); font-size: 12px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
  }
  .act-btn:hover { background: var(--surface2); color: var(--text); }

  .msg-error {
    padding: 10px 14px; border-radius: 12px; border: 1px solid rgba(248,113,113,0.35);
    background: rgba(248,113,113,0.08); color: var(--red); font-size: 13px;
  }

  .composer-outer {
    padding: 6px 16px max(14px, env(safe-area-inset-bottom)); background: linear-gradient(to top, var(--bg) 75%, transparent);
    flex-shrink: 0;
  }
  .composer-container { max-width: 780px; margin: 0 auto; position: relative; }

  .tucked-bar {
    margin: 0 12px; border-radius: 18px 18px 0 0; border: 1px solid var(--border); border-bottom: none;
    background: var(--context-bar); padding: 6px 10px 18px; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .tucked-pills { display: flex; align-items: center; gap: 4px; }
  .tucked-pill {
    height: 28px; padding: 0 10px; border-radius: 8px; border: none; background: transparent;
    color: var(--muted); font-size: 12.5px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  }
  .tucked-pill.active { background: rgba(255,255,255,0.08); color: var(--text); }
  [data-theme="light"] .tucked-pill.active { background: #ffffff; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }

  .composer-card {
    position: relative; margin-top: -12px; border-radius: 22px; border: 1px solid var(--border);
    background: var(--composer); padding: 10px 10px 8px; box-shadow: var(--shadow);
    transition: border-color 0.15s;
  }
  .composer-card:focus-within { border-color: var(--border-strong); }
  .composer-card textarea {
    width: 100%; min-height: 40px; max-height: 200px; resize: none; border: none; outline: none;
    background: transparent; padding: 2px 10px; font-size: 15px; line-height: 1.5; color: var(--text);
  }
  .composer-card textarea::placeholder { color: var(--dim); }

  .composer-toolbar { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .tb-circle {
    width: 34px; height: 34px; border-radius: 999px; border: none; background: transparent; color: var(--muted);
    display: grid; place-items: center; cursor: pointer; transition: background 0.15s, color 0.15s;
  }
  .tb-circle:hover { background: rgba(255,255,255,0.07); color: var(--text); }
  [data-theme="light"] .tb-circle:hover { background: rgba(0,0,0,0.06); }

  .picker-trigger {
    height: 34px; padding: 0 11px; border-radius: 999px; border: none; background: transparent;
    display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer;
    transition: background 0.15s;
  }
  .picker-trigger:hover { background: rgba(255,255,255,0.07); }
  [data-theme="light"] .picker-trigger:hover { background: rgba(0,0,0,0.05); }
  .picker-model { font-weight: 550; color: var(--text); max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .picker-effort { color: var(--muted); font-size: 12.5px; }

  .send-btn {
    width: 34px; height: 34px; border-radius: 999px; border: none; background: var(--send-bg); color: var(--send-fg);
    display: grid; place-items: center; cursor: pointer; transition: opacity 0.15s, transform 0.1s; flex-shrink: 0;
  }
  .send-btn:disabled { opacity: 0.3; cursor: default; }
  .send-btn:active:not(:disabled) { transform: scale(0.94); }
  .send-btn.stop { background: var(--surface2); color: var(--text); border: 1px solid var(--border-strong); }

  .floating-menu {
    position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); max-height: 260px; overflow-y: auto;
    border-radius: 16px; border: 1px solid var(--border-strong); background: var(--surface); box-shadow: var(--shadow);
    padding: 6px; z-index: 60; display: none;
  }
  .floating-menu.open { display: block; }
  .menu-item {
    padding: 8px 11px; border-radius: 10px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
    cursor: pointer; font-size: 13px;
  }
  .menu-item:hover, .menu-item.active { background: var(--surface2); }
  .menu-cmd { font-family: var(--mono); font-weight: 600; color: var(--accent); }
  .menu-desc { color: var(--dim); font-size: 12px; }

  .effort-popover {
    position: absolute; right: 0; bottom: calc(100% + 10px); width: 310px; max-width: calc(100vw - 32px);
    border-radius: 18px; border: 1px solid var(--border-strong); background: var(--surface); box-shadow: var(--shadow);
    padding: 14px; z-index: 65; display: none;
  }
  .effort-popover.open { display: block; }
  .ep-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .ep-title { font-size: 13px; font-weight: 600; }
  .ep-level { font-size: 12.5px; font-weight: 600; color: var(--accent); }
  .slider-track {
    position: relative; height: 40px; border-radius: 999px; background: var(--surface2); border: 1px solid var(--border);
    cursor: pointer; user-select: none; touch-action: none; overflow: hidden; margin-bottom: 10px;
  }
  .slider-fill {
    position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px;
    background: linear-gradient(90deg, #4f46e5, #8b5cf6); transition: width 0.12s ease-out;
  }
  .slider-fill.ultra { background: linear-gradient(90deg, #7c3aed, #c084fc); }
  .slider-knob {
    position: absolute; top: 4px; width: 30px; height: 30px; border-radius: 999px; background: #ffffff;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35); transition: left 0.12s ease-out;
  }
  .ep-stops { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--dim); padding: 0 4px 10px; }
  .ep-model-row {
    width: 100%; padding: 9px 10px; border-radius: 11px; border: 1px solid var(--border); background: var(--surface2);
    display: flex; align-items: center; justify-content: space-between; cursor: pointer; font-size: 13px;
  }
  .ep-model-list { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
  .ep-model-opt {
    padding: 8px 10px; border-radius: 10px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; font-size: 13px;
  }
  .ep-model-opt:hover { background: var(--surface2); }

  .panel-dock {
    width: 420px; min-width: 340px; border-left: 1px solid var(--border); background: var(--surface);
    display: none; flex-direction: column; height: 100%; z-index: 45;
  }
  .panel-dock.open { display: flex; }
  .dock-head {
    height: 52px; padding: 0 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font-family: var(--mono); font-size: 12.5px;
  }
  .dock-pre { flex: 1; padding: 14px; overflow: auto; font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre; }

  @media (max-width: 860px) {
    .sidebar { position: fixed; left: 0; top: 0; bottom: 0; transform: translateX(-100%); width: 84vw; max-width: 320px; }
    .sidebar.collapsed { width: 84vw; min-width: 84vw; }
    .sidebar.open { transform: translateX(0); }
    .panel-dock.open { position: fixed; inset: 0; width: 100%; min-width: 0; z-index: 70; }
    .breadcrumb .proj { max-width: 140px; }
    .tucked-bar { margin: 0 8px; }
    .composer-outer { padding: 4px 10px max(10px, env(safe-area-inset-bottom)); }
  }
</style>
</head>
<body>
<div class="app">
  <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-top">
      <div class="brand"><img src="/icon.svg" alt="pi"><span>pi-awesome</span></div>
      <button class="pill-btn" id="newSessionBtn" title="New session">+ New</button>
    </div>
    <div class="seg-tabs">
      <div class="seg-tab active" data-tab="sessions">Sessions</div>
      <div class="seg-tab" data-tab="files">Files</div>
    </div>
    <div class="search-wrap" id="searchWrap">
      <input class="search-input" id="sidebarSearch" type="search" placeholder="Search sessions...">
    </div>
    <div class="sidebar-body" id="sidebarBody"></div>
  </aside>

  <main class="main">
    <header class="thread-header">
      <div class="header-left">
        <button class="icon-btn" id="menuBtn" aria-label="Toggle sidebar" title="Sidebar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        </button>
        <div class="breadcrumb">
          <span class="proj" id="cwdBar">loading...</span>
          <span class="shimmer-status" id="shimmerStatus">Thinking...</span>
        </div>
      </div>
      <div class="header-right">
        <div class="ctx-wrap">
          <button class="ctx-pill" id="ctxPill" title="Context usage">
            <span class="ctx-bar-mini"><span class="ctx-bar-fill" id="ctxFill"></span></span>
            <span id="statsPill">0%</span>
          </button>
          <div class="ctx-popover" id="ctxPopover">
            <div style="font-weight:600;font-size:12.5px">Context Window</div>
            <div class="ctx-row"><span>Used</span><span id="ctxTokens">0</span></div>
            <div class="ctx-row"><span>Limit</span><span id="ctxWindow">0</span></div>
          </div>
        </div>
        <button class="icon-btn" id="themeBtn" aria-label="Toggle theme" title="Toggle light/dark">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
        </button>
      </div>
    </header>

    <div class="chat-scroll" id="chatScroll">
      <div class="chat-inner" id="chat"></div>
    </div>

    <div class="composer-outer">
      <div class="composer-container">
        <div class="floating-menu" id="slashMenu"></div>
        <div class="floating-menu" id="mentionMenu"></div>
        <div class="effort-popover" id="effortPopover"></div>

        <div class="tucked-bar">
          <div class="tucked-pills">
            <button type="button" class="tucked-pill active" id="targetProjectBtn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
              <span id="targetProjectLabel">Project</span>
            </button>
            <button type="button" class="tucked-pill" id="filesQuickBtn" title="Browse files">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span>Files</span>
            </button>
          </div>
          <span style="font-size:11.5px;color:var(--dim)" id="liveSyncHint">Synced with TUI</span>
        </div>

        <div class="composer-card">
          <textarea id="promptInput" rows="1" placeholder="Ask anything... (/ for commands, @ for files)"></textarea>
          <div class="composer-toolbar">
            <button type="button" class="tb-circle" id="mentionTriggerBtn" title="Mention file (@)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
            </button>
            <button type="button" class="picker-trigger" id="pickerTrigger">
              <span class="picker-model" id="pickerModelName">model</span>
              <span class="picker-effort" id="pickerEffortName">low</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--dim)"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <div style="margin-left:auto;display:flex;align-items:center;gap:6px">
              <button type="button" class="send-btn" id="sendBtn" aria-label="Send">
                <svg id="sendIcon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </main>

  <aside class="panel-dock" id="panelDock">
    <div class="dock-head">
      <span id="dockTitle" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      <div style="display:flex;gap:6px">
        <button class="pill-btn" id="dockCopy">Copy</button>
        <button class="pill-btn" id="dockClose">Close</button>
      </div>
    </div>
    <pre class="dock-pre" id="dockPre"></pre>
  </aside>
</div>

<script>
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

const chatScroll = document.getElementById("chatScroll");
const chatEl = document.getElementById("chat");
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");
const cwdBar = document.getElementById("cwdBar");
const shimmerStatus = document.getElementById("shimmerStatus");
const statsPill = document.getElementById("statsPill");
const ctxFill = document.getElementById("ctxFill");
const ctxPill = document.getElementById("ctxPill");
const ctxPopover = document.getElementById("ctxPopover");
const ctxTokens = document.getElementById("ctxTokens");
const ctxWindow = document.getElementById("ctxWindow");
const sidebar = document.getElementById("sidebar");
const sidebarBackdrop = document.getElementById("sidebarBackdrop");
const sidebarBody = document.getElementById("sidebarBody");
const sidebarSearch = document.getElementById("sidebarSearch");
const searchWrap = document.getElementById("searchWrap");
const panelDock = document.getElementById("panelDock");
const dockTitle = document.getElementById("dockTitle");
const dockPre = document.getElementById("dockPre");
const pickerTrigger = document.getElementById("pickerTrigger");
const pickerModelName = document.getElementById("pickerModelName");
const pickerEffortName = document.getElementById("pickerEffortName");
const effortPopover = document.getElementById("effortPopover");
const slashMenu = document.getElementById("slashMenu");
const mentionMenu = document.getElementById("mentionMenu");
const targetProjectLabel = document.getElementById("targetProjectLabel");

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];
const EFFORT_LABELS = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Ultra" };
const SLASH_COMMANDS = [
  { cmd: "/new", desc: "Start a new session" },
  { cmd: "/compact", desc: "Compact conversation context" },
  { cmd: "/status", desc: "Show session status" },
  { cmd: "/help", desc: "Show available commands" },
];
const SUGGESTIONS = [
  "Explain this project architecture",
  "Check git status and recent changes",
  "Find potential bugs in the codebase",
  "Write unit tests for recent changes",
];

let appState = { messages: [], isStreaming: false, sessions: [], cwd: "", currentDir: ".", models: [], availableThinkingLevels: [] };
let activeTab = "sessions";
let liveAssistant = null;
let pickerView = "closed";
let cachedFiles = [];

const savedTheme = localStorage.getItem("pi-web-theme") || "dark";
document.documentElement.setAttribute("data-theme", savedTheme);

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderMarkdown(text) {
  let out = esc(text || "");
  out = out.replace(/\`\`\`([\\w-]*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) =>
    \`<div class="code-block"><div class="code-head"><span>\${lang || "code"}</span><button class="code-copy" data-copy-code>Copy</button></div><pre><code>\${code}</code></pre></div>\`
  );
  out = out.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
  return out.split(/\\n\\n+/).map((p) => (p.startsWith("<div class=\\"code-block") ? p : \`<p>\${p.replace(/\\n/g, "<br>")}</p>\`)).join("");
}

function renderToolStep(tc, resultMap) {
  const res = resultMap.get(tc.id);
  const dotCls = res ? (res.isError ? "step-dot err" : "step-dot") : "step-dot running";
  const statusText = res ? (res.isError ? "error" : "done") : "running...";
  const argsPreview = tc.arguments && typeof tc.arguments === "object"
    ? (tc.arguments.path || tc.arguments.command || tc.arguments.action || JSON.stringify(tc.arguments).slice(0, 100))
    : "";
  let body = "";
  if (tc.name === "write" && tc.arguments?.content) {
    body = tc.arguments.content.split("\\n").slice(-16).join("\\n");
  } else if (tc.name === "edit" && (tc.arguments?.newText || tc.arguments?.edits)) {
    body = tc.arguments.newText || JSON.stringify(tc.arguments.edits, null, 2);
  } else if (res?.text) {
    body = res.text;
  } else if (tc.arguments) {
    body = JSON.stringify(tc.arguments, null, 2);
  }
  const open = !res || tc.name === "write" || tc.name === "edit";
  return \`<div class="tool-step">
    <div class="tool-step-head" data-toggle-tool>
      <div class="tool-step-left">
        <span class="\${dotCls}"></span>
        <span class="tool-label">\${esc(tc.name)}</span>
        <span class="tool-arg">\${esc(argsPreview)}</span>
      </div>
      <span style="font-size:11.5px;color:var(--dim)">\${statusText}</span>
    </div>
    <div class="tool-step-body" style="display:\${open ? "block" : "none"}">\${esc(body.slice(0, 4000))}</div>
  </div>\`;
}

function renderMessages() {
  const msgs = [...(appState.messages || [])];
  if (liveAssistant) msgs.push(liveAssistant);
  const resultMap = new Map();
  for (const m of msgs) {
    if (m.role === "toolResult") {
      const txt = Array.isArray(m.content) ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("\\n") : "";
      resultMap.set(m.toolCallId, { text: txt, isError: Boolean(m.isError) });
    }
  }

  const visibleMsgs = msgs.filter((m) => m.role === "user" || m.role === "assistant");
  if (visibleMsgs.length === 0) {
    chatEl.innerHTML = \`<div class="empty-state">
      <div class="empty-badge"><img src="/icon.svg" width="28" height="28" alt="pi"></div>
      <div class="empty-title">What are we building?</div>
      <div class="empty-sub">Connected to your live terminal workspace. Send a prompt here or in the terminal — both stay in sync.</div>
      <div class="chips">\${SUGGESTIONS.map((s) => \`<button class="chip" data-suggest="\${esc(s)}">\${esc(s)}</button>\`).join("")}</div>
    </div>\`;
    return;
  }

  const html = [];
  let lastUserText = "";
  for (const m of msgs) {
    if (m.role === "user") {
      const txt = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("\\n") : "");
      if (txt) {
        lastUserText = txt;
        html.push(\`<div class="msg-row"><div class="msg-user-wrap"><div class="msg-user">\${esc(txt)}</div></div></div>\`);
      }
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      const parts = [];
      let plainText = "";
      for (const b of m.content) {
        if (b.type === "thinking" && b.thinking) {
          parts.push(\`<details class="reasoning-box"><summary>Reasoning</summary><div class="reasoning-content">\${esc(b.thinking)}</div></details>\`);
        } else if (b.type === "toolCall") {
          parts.push(renderToolStep(b, resultMap));
        } else if (b.type === "text" && b.text) {
          plainText += (plainText ? "\\n\\n" : "") + b.text;
          parts.push(renderMarkdown(b.text));
        }
      }
      if (m.errorMessage) {
        parts.push(\`<div class="msg-error">\${esc(m.errorMessage)}</div>\`);
      }
      if (parts.length) {
        const actions = !appState.isStreaming && plainText
          ? \`<div class="msg-actions">
              <button class="act-btn" data-copy-msg="\${esc(plainText)}">Copy</button>
              \${lastUserText ? \`<button class="act-btn" data-regen="\${esc(lastUserText)}">Regenerate</button>\` : ""}
            </div>\`
          : "";
        html.push(\`<div class="msg-row"><div class="msg-assistant">\${parts.join("")}\${actions}</div></div>\`);
      }
    }
  }
  const atBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 140;
  chatEl.innerHTML = html.join("");
  if (atBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
}

function dateBucket(ts) {
  if (!ts) return "Sessions";
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return "Older";
}

function renderSidebar() {
  searchWrap.style.display = activeTab === "sessions" ? "block" : "none";
  if (activeTab === "sessions") {
    const q = (sidebarSearch.value || "").trim().toLowerCase();
    const list = (appState.sessions || []).filter((s) => {
      if (!q) return true;
      return (s.name || s.firstMessage || "").toLowerCase().includes(q);
    });
    if (list.length === 0) {
      sidebarBody.innerHTML = '<div style="padding:14px;color:var(--dim);font-size:12.5px">No matching sessions.</div>';
      return;
    }
    const groups = new Map();
    for (const s of list) {
      const g = dateBucket(s.modified);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    let out = "";
    for (const [label, items] of groups.entries()) {
      out += \`<div class="group-label">\${esc(label)}</div>\`;
      out += items.map((s) =>
        \`<div class="list-item \${s.active ? "active" : ""}" data-session-path="\${esc(s.path)}">
          <span class="title">\${esc(s.name || s.firstMessage || "Untitled")}</span>
          <span class="meta">\${esc(s.messageCount || 0)}</span>
        </div>\`
      ).join("");
    }
    sidebarBody.innerHTML = out;
  } else {
    void loadFiles(appState.currentDir || ".");
  }
}

async function loadFiles(dir) {
  const res = await fetch("/api/files?dir=" + encodeURIComponent(dir));
  const data = await res.json();
  appState.currentDir = data.dir;
  cachedFiles = data.entries || [];
  const rows = [];
  if (data.dir !== ".") {
    const up = data.dir.includes("/") ? data.dir.split("/").slice(0, -1).join("/") || "." : ".";
    rows.push(\`<div class="list-item" data-dir-path="\${esc(up)}"><span class="title">..</span></div>\`);
  }
  for (const e of cachedFiles) {
    if (e.isDir) {
      rows.push(\`<div class="list-item" data-dir-path="\${esc(e.path)}"><span class="title">[dir] \${esc(e.name)}</span></div>\`);
    } else {
      rows.push(\`<div class="list-item" data-file-path="\${esc(e.path)}"><span class="title">\${esc(e.name)}</span></div>\`);
    }
  }
  sidebarBody.innerHTML = rows.join("");
}

async function previewFile(path) {
  const res = await fetch("/api/file?path=" + encodeURIComponent(path));
  const data = await res.json();
  dockTitle.textContent = path;
  dockPre.textContent = data.content || data.error || "";
  panelDock.classList.add("open");
}

async function switchSession(path) {
  try {
    cwdBar.textContent = "Switching session...";
    const res = await fetch("/api/switch-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    liveAssistant = null;
    await refreshState();
    closeMobileSidebar();
  } catch (err) {
    cwdBar.textContent = "Switch failed: " + (err?.message || err);
  }
}

function renderEffortPopover() {
  if (pickerView === "closed") {
    effortPopover.classList.remove("open");
    return;
  }
  effortPopover.classList.add("open");
  const levels = (appState.availableThinkingLevels && appState.availableThinkingLevels.length)
    ? appState.availableThinkingLevels
    : EFFORT_LEVELS;
  const curLvl = appState.thinkingLevel || "low";
  const idx = Math.max(0, levels.indexOf(curLvl));
  const pct = levels.length > 1 ? (idx / (levels.length - 1)) * 100 : 0;

  if (pickerView === "effort") {
    const isUltra = curLvl === "xhigh";
    effortPopover.innerHTML = \`
      <div class="ep-head">
        <span class="ep-title">Reasoning effort</span>
        <span class="ep-level">\${esc(EFFORT_LABELS[curLvl] || curLvl)}</span>
      </div>
      <div class="slider-track" id="effortTrack">
        <div class="slider-fill \${isUltra ? "ultra" : ""}" style="width:calc(\${pct}% + \${34 - pct * 0.3}px)"></div>
        <div class="slider-knob" style="left:calc(\${pct}% - \${pct * 0.34}px + 4px)"></div>
      </div>
      <div class="ep-stops">\${levels.map((l) => \`<span>\${esc(EFFORT_LABELS[l] || l)}</span>\`).join("")}</div>
      <button type="button" class="ep-model-row" id="openModelsBtn">
        <span>Model: <strong>\${esc(appState.model?.id || "default")}</strong></span>
        <span>›</span>
      </button>\`;

    const track = document.getElementById("effortTrack");
    const pickAt = (clientX) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const chosen = levels[Math.round(ratio * (levels.length - 1))];
      if (chosen && chosen !== appState.thinkingLevel) {
        appState.thinkingLevel = chosen;
        renderEffortPopover();
        updateToolbarMeta();
        void fetch("/api/thinking", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level: chosen }) });
      }
    };
    track.onpointerdown = (e) => {
      pickAt(e.clientX);
      const move = (ev) => pickAt(ev.clientX);
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    document.getElementById("openModelsBtn").onclick = () => { pickerView = "models"; renderEffortPopover(); };
  } else {
    effortPopover.innerHTML = \`
      <div class="ep-head">
        <button type="button" class="pill-btn" id="backToEffortBtn">‹ Back</button>
        <span class="ep-title">Choose model</span>
      </div>
      <div class="ep-model-list">\${(appState.models || []).map((m) => {
        const active = appState.model && appState.model.provider === m.provider && appState.model.id === m.id;
        return \`<div class="ep-model-opt" data-pick-model="\${esc(m.provider)}/\${esc(m.id)}">
          <span>\${esc(m.id)}</span>
          <span style="color:var(--accent)">\${active ? "✓" : ""}</span>
        </div>\`;
      }).join("")}</div>\`;
    document.getElementById("backToEffortBtn").onclick = () => { pickerView = "effort"; renderEffortPopover(); };
  }
}

function updateToolbarMeta() {
  const modelId = appState.model?.id || "no model";
  const lvl = appState.thinkingLevel || "low";
  pickerModelName.textContent = modelId;
  pickerEffortName.textContent = EFFORT_LABELS[lvl] || lvl;
  if (appState.isStreaming) {
    sendBtn.classList.add("stop");
    sendBtn.disabled = false;
    sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
    shimmerStatus.classList.add("active");
  } else {
    sendBtn.classList.remove("stop");
    sendBtn.disabled = !promptInput.value.trim();
    sendBtn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';
    shimmerStatus.classList.remove("active");
  }
}

async function refreshState() {
  const res = await fetch("/api/state");
  const s = await res.json();
  appState = { ...appState, ...s };
  const folderName = (s.cwd || "").split("/").filter(Boolean).pop() || s.cwd || "workspace";
  cwdBar.textContent = s.cwd || "";
  targetProjectLabel.textContent = folderName;

  const pct = s.contextUsage && s.contextUsage.percent != null ? s.contextUsage.percent : 0;
  statsPill.textContent = pct.toFixed(1) + "%";
  ctxFill.style.width = Math.min(100, pct) + "%";
  ctxTokens.textContent = String(s.contextUsage?.tokens ?? 0);
  ctxWindow.textContent = String(s.contextUsage?.contextWindow ?? 0);

  updateToolbarMeta();
  renderMessages();
  if (activeTab === "sessions") renderSidebar();
  if (pickerView !== "closed") renderEffortPopover();
}

async function sendPrompt(overrideText) {
  if (appState.isStreaming && !overrideText) {
    await fetch("/api/abort", { method: "POST" });
    return;
  }
  const text = (overrideText ?? promptInput.value).trim();
  if (!text) return;
  if (!overrideText) {
    promptInput.value = "";
    promptInput.style.height = "auto";
  }
  slashMenu.classList.remove("open");
  mentionMenu.classList.remove("open");
  updateToolbarMeta();
  await fetch("/api/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
}

function closeMobileSidebar() {
  sidebar.classList.remove("open");
  sidebarBackdrop.classList.remove("open");
}

sidebarBody.addEventListener("click", (ev) => {
  const row = ev.target.closest(".list-item");
  if (!row) return;
  if (row.dataset.sessionPath) void switchSession(row.dataset.sessionPath);
  else if (row.dataset.dirPath) void loadFiles(row.dataset.dirPath);
  else if (row.dataset.filePath) void previewFile(row.dataset.filePath);
});

chatEl.addEventListener("click", (ev) => {
  const tog = ev.target.closest("[data-toggle-tool]");
  if (tog) {
    const body = tog.nextElementSibling;
    body.style.display = body.style.display === "none" ? "block" : "none";
    return;
  }
  const sug = ev.target.closest("[data-suggest]");
  if (sug) { void sendPrompt(sug.dataset.suggest); return; }
  const cpCode = ev.target.closest("[data-copy-code]");
  if (cpCode) {
    const code = cpCode.closest(".code-block").querySelector("code").textContent;
    navigator.clipboard.writeText(code).then(() => { cpCode.textContent = "Copied"; setTimeout(() => cpCode.textContent = "Copy", 1200); });
    return;
  }
  const cpMsg = ev.target.closest("[data-copy-msg]");
  if (cpMsg) {
    navigator.clipboard.writeText(cpMsg.dataset.copyMsg).then(() => { cpMsg.textContent = "Copied"; setTimeout(() => cpMsg.textContent = "Copy", 1200); });
    return;
  }
  const regen = ev.target.closest("[data-regen]");
  if (regen) { void sendPrompt(regen.dataset.regen); }
});

effortPopover.addEventListener("click", (ev) => {
  const opt = ev.target.closest("[data-pick-model]");
  if (!opt) return;
  const [provider, ...rest] = opt.dataset.pickModel.split("/");
  const id = rest.join("/");
  appState.model = { provider, id };
  pickerView = "effort";
  renderEffortPopover();
  updateToolbarMeta();
  void fetch("/api/model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, id }) });
});

pickerTrigger.onclick = (e) => {
  e.stopPropagation();
  pickerView = pickerView === "closed" ? "effort" : "closed";
  renderEffortPopover();
};
ctxPill.onclick = (e) => { e.stopPropagation(); ctxPopover.classList.toggle("open"); };
document.addEventListener("click", (e) => {
  if (!effortPopover.contains(e.target) && !pickerTrigger.contains(e.target)) { pickerView = "closed"; renderEffortPopover(); }
  if (!ctxPopover.contains(e.target) && !ctxPill.contains(e.target)) ctxPopover.classList.remove("open");
});

document.getElementById("menuBtn").onclick = () => {
  if (window.innerWidth <= 860) {
    sidebar.classList.toggle("open");
    sidebarBackdrop.classList.toggle("open");
  } else {
    sidebar.classList.toggle("collapsed");
  }
};
sidebarBackdrop.onclick = closeMobileSidebar;
document.getElementById("themeBtn").onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("pi-web-theme", next);
};
document.getElementById("newSessionBtn").onclick = async () => {
  await fetch("/api/new-session", { method: "POST" });
  liveAssistant = null;
  await refreshState();
  closeMobileSidebar();
};
document.getElementById("filesQuickBtn").onclick = () => {
  activeTab = "files";
  document.querySelectorAll(".seg-tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === "files"));
  if (window.innerWidth <= 860) { sidebar.classList.add("open"); sidebarBackdrop.classList.add("open"); }
  else sidebar.classList.remove("collapsed");
  renderSidebar();
};
document.getElementById("dockClose").onclick = () => panelDock.classList.remove("open");
document.getElementById("dockCopy").onclick = () => navigator.clipboard.writeText(dockPre.textContent);
sidebarSearch.oninput = () => renderSidebar();

document.querySelectorAll(".seg-tab").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll(".seg-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    activeTab = t.dataset.tab;
    renderSidebar();
  };
});

document.getElementById("mentionTriggerBtn").onclick = async () => {
  promptInput.focus();
  const val = promptInput.value;
  promptInput.value = val + (val && !val.endsWith(" ") ? " @" : "@");
  promptInput.dispatchEvent(new Event("input"));
};

promptInput.addEventListener("input", async () => {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(200, promptInput.scrollHeight) + "px";
  updateToolbarMeta();

  const val = promptInput.value;
  if (val.startsWith("/") && !val.includes(" ")) {
    const q = val.toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q));
    if (matches.length) {
      slashMenu.innerHTML = matches.map((m) => \`<div class="menu-item" data-slash="\${esc(m.cmd)}"><span class="menu-cmd">\${esc(m.cmd)}</span><span class="menu-desc">\${esc(m.desc)}</span></div>\`).join("");
      slashMenu.classList.add("open");
      mentionMenu.classList.remove("open");
      return;
    }
  }
  slashMenu.classList.remove("open");

  const atMatch = val.match(/(?:^|\\s)@([^\\s]*)$/);
  if (atMatch) {
    if (!cachedFiles.length) await loadFiles(".");
    const q = atMatch[1].toLowerCase();
    const files = cachedFiles.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 12);
    if (files.length) {
      mentionMenu.innerHTML = files.map((f) => \`<div class="menu-item" data-mention="\${esc(f.path)}"><span>\${esc(f.name)}</span><span class="menu-desc">\${f.isDir ? "dir" : "file"}</span></div>\`).join("");
      mentionMenu.classList.add("open");
      return;
    }
  }
  mentionMenu.classList.remove("open");
});

slashMenu.addEventListener("click", (e) => {
  const item = e.target.closest("[data-slash]");
  if (!item) return;
  promptInput.value = item.dataset.slash + " ";
  slashMenu.classList.remove("open");
  promptInput.focus();
  updateToolbarMeta();
});
mentionMenu.addEventListener("click", (e) => {
  const item = e.target.closest("[data-mention]");
  if (!item) return;
  promptInput.value = promptInput.value.replace(/@([^\\s]*)$/, "@" + item.dataset.mention + " ");
  mentionMenu.classList.remove("open");
  promptInput.focus();
  updateToolbarMeta();
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendPrompt(); }
  if (e.key === "Escape") { slashMenu.classList.remove("open"); mentionMenu.classList.remove("open"); pickerView = "closed"; renderEffortPopover(); }
});
sendBtn.onclick = () => void sendPrompt();

const es = new EventSource("/api/events");
es.onmessage = (ev) => {
  const event = JSON.parse(ev.data);
  if (event.type === "agent_start") {
    appState.isStreaming = true;
    shimmerStatus.textContent = "Thinking...";
    updateToolbarMeta();
  } else if (event.type === "tool_execution_start") {
    shimmerStatus.textContent = "Running " + (event.toolName || "tool") + "...";
  } else if (event.type === "message_start" && event.message?.role === "assistant") {
    liveAssistant = event.message;
    renderMessages();
  } else if (event.type === "message_update" && event.message?.role === "assistant") {
    liveAssistant = event.message;
    renderMessages();
  } else if (event.type === "message_end" && event.message?.role === "assistant") {
    liveAssistant = null;
    void refreshState();
  } else if (event.type === "agent_end" || event.type === "agent_settled" || event.type === "tool_execution_end" || event.type === "session_changed") {
    if (event.type === "session_changed") liveAssistant = null;
    void refreshState();
  }
};

refreshState().catch((err) => {
  cwdBar.textContent = "Failed to load state: " + (err?.message || err);
});
</script>
</body>
</html>`;
}
