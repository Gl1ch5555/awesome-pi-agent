export const PI_WEB_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#1c1e22"/>
  <rect x="4" y="4" width="120" height="120" rx="24" fill="none" stroke="#3b404c" stroke-width="2"/>
  <path d="M32 42h64M48 42v46M78 42v36c0 7 4 10 10 10h6" fill="none" stroke="#84b596" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const PI_WEB_MANIFEST = JSON.stringify(
	{
		name: "pi-awesome",
		short_name: "pi",
		description: "Local Web UI for pi-awesome coding agent",
		start_url: "/",
		display: "standalone",
		background_color: "#14161a",
		theme_color: "#1c1e22",
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1c1e22">
<title>pi-awesome · Web UI</title>
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<link rel="manifest" href="/manifest.webmanifest">
<style>
  :root {
    --bg: #131519;
    --surface: #1b1e24;
    --surface2: #22262e;
    --border: #2e333d;
    --text: #e4e6eb;
    --muted: #9aa0ab;
    --dim: #686e7a;
    --accent: #84b596;
    --accent-soft: rgba(132, 181, 150, 0.14);
    --blue: #7aa2f7;
    --coral: #cf7d72;
    --amber: #cca872;
    --mono: "JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; overflow: hidden; }
  .app { display: flex; height: 100dvh; width: 100%; }
  .sidebar {
    width: 280px; min-width: 280px; background: var(--surface); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; height: 100%; z-index: 30;
  }
  .sidebar-header {
    padding: 12px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .brand { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 14px; letter-spacing: 0.2px; }
  .brand img { width: 22px; height: 22px; border-radius: 6px; }
  .btn {
    background: var(--surface2); color: var(--text); border: 1px solid var(--border); border-radius: 7px;
    padding: 5px 10px; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
    transition: border-color 0.15s, background 0.15s;
  }
  .btn:hover { border-color: var(--muted); }
  .btn.primary { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .btn.danger { border-color: var(--coral); color: var(--coral); background: rgba(207,125,114,0.1); }
  .cwd-bar { padding: 8px 14px; font-family: var(--mono); font-size: 11px; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tabs { display: flex; border-bottom: 1px solid var(--border); }
  .tab { flex: 1; padding: 8px; text-align: center; font-size: 12px; font-weight: 600; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .sidebar-body { flex: 1; overflow-y: auto; padding: 8px; }
  .list-item {
    padding: 8px 10px; border-radius: 7px; cursor: pointer; display: flex; align-items: center; gap: 8px;
    font-size: 12.5px; color: var(--muted); margin-bottom: 2px;
  }
  .list-item:hover { background: var(--surface2); color: var(--text); }
  .list-item.active { background: var(--accent-soft); color: var(--text); }
  .list-item .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list-item .meta { font-size: 11px; color: var(--dim); font-family: var(--mono); }

  .main { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100%; }
  .topbar {
    height: 48px; padding: 0 14px; border-bottom: 1px solid var(--border); background: var(--surface);
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
  }
  .topbar-left, .topbar-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .menu-btn { display: none; }
  select {
    background: var(--surface2); color: var(--text); border: 1px solid var(--border); border-radius: 7px;
    padding: 4px 8px; font-size: 12px; font-family: var(--mono); max-width: 210px; outline: none;
  }
  .pill {
    font-family: var(--mono); font-size: 11.5px; color: var(--muted); background: var(--surface2);
    border: 1px solid var(--border); border-radius: 999px; padding: 3px 9px; white-space: nowrap;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); display: inline-block; }
  .dot.busy { background: var(--amber); animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

  .chat { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
  .msg { max-width: 920px; width: 100%; margin: 0 auto; }
  .msg-user {
    background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 11px 14px;
    white-space: pre-wrap; word-break: break-word; line-height: 1.5;
  }
  .msg-assistant { padding: 4px 2px; line-height: 1.6; word-break: break-word; }
  .msg-assistant p { margin-bottom: 8px; }
  .msg-assistant p:last-child { margin-bottom: 0; }
  .msg-assistant pre {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
    overflow-x: auto; font-family: var(--mono); font-size: 12.5px; margin: 8px 0; position: relative;
  }
  .msg-assistant code { font-family: var(--mono); background: var(--surface2); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
  .msg-assistant pre code { background: none; padding: 0; }
  .thinking-box {
    border-left: 2px solid var(--border); padding: 4px 10px; margin: 6px 0 10px; color: var(--muted); font-size: 12.5px;
  }
  .thinking-box summary { cursor: pointer; font-family: var(--mono); font-size: 11.5px; color: var(--dim); user-select: none; }
  .tool-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin: 8px 0; overflow: hidden;
  }
  .tool-head {
    padding: 7px 11px; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    font-family: var(--mono); font-size: 12px; background: var(--surface2); cursor: pointer;
  }
  .tool-name { color: var(--accent); font-weight: 700; }
  .tool-name.err { color: var(--coral); }
  .tool-body {
    padding: 9px 11px; font-family: var(--mono); font-size: 12px; color: var(--muted);
    white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow-y: auto; border-top: 1px solid var(--border);
  }

  .composer-wrap { padding: 10px 16px 14px; border-top: 1px solid var(--border); background: var(--surface); }
  .composer {
    max-width: 920px; margin: 0 auto; display: flex; gap: 8px; align-items: flex-end;
    background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px;
  }
  .composer:focus-within { border-color: var(--accent); }
  textarea {
    flex: 1; background: transparent; border: none; color: var(--text); font-family: var(--sans); font-size: 14px;
    resize: none; outline: none; max-height: 160px; min-height: 22px; line-height: 1.45;
  }
  .file-preview-modal {
    position: fixed; inset: 0; background: rgba(0,0,0,0.65); display: none; align-items: center; justify-content: center; z-index: 50; padding: 16px;
  }
  .file-preview-modal.open { display: flex; }
  .modal-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 10px; max-width: 900px; width: 100%;
    max-height: 85dvh; display: flex; flex-direction: column; overflow: hidden;
  }
  .modal-head { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; font-family: var(--mono); font-size: 12.5px; }
  .modal-pre { padding: 12px 14px; overflow: auto; font-family: var(--mono); font-size: 12px; white-space: pre; color: var(--text); }

  @media (max-width: 820px) {
    .sidebar { position: fixed; left: 0; top: 0; bottom: 0; transform: translateX(-100%); transition: transform 0.2s; }
    .sidebar.open { transform: translateX(0); }
    .menu-btn { display: inline-flex; }
    .pill.hide-sm { display: none; }
    .chat { padding: 12px; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <div class="brand"><img src="/icon.svg" alt="pi"><span>pi-awesome</span></div>
      <button class="btn primary" id="newSessionBtn" title="New session">+ New</button>
    </div>
    <div class="cwd-bar" id="cwdBar">loading...</div>
    <div class="tabs">
      <div class="tab active" data-tab="sessions">Sessions</div>
      <div class="tab" data-tab="files">Files</div>
    </div>
    <div class="sidebar-body" id="sidebarBody"></div>
  </aside>

  <main class="main">
    <header class="topbar">
      <div class="topbar-left">
        <button class="btn menu-btn" id="menuBtn" aria-label="Menu">☰</button>
        <span class="dot" id="connDot"></span>
        <select id="modelSelect" title="Model"></select>
        <select id="thinkingSelect" title="Thinking"></select>
      </div>
      <div class="topbar-right">
        <span class="pill hide-sm" id="statsPill">0%</span>
        <button class="btn danger" id="abortBtn" style="display:none">Stop</button>
      </div>
    </header>

    <div class="chat" id="chat"></div>

    <div class="composer-wrap">
      <div class="composer">
        <textarea id="promptInput" rows="1" placeholder="Ask pi anything... (Enter to send, Shift+Enter for newline)"></textarea>
        <button class="btn primary" id="sendBtn">Send</button>
      </div>
    </div>
  </main>
</div>

<div class="file-preview-modal" id="fileModal">
  <div class="modal-card">
    <div class="modal-head"><span id="modalTitle"></span><button class="btn" id="modalClose">Close</button></div>
    <pre class="modal-pre" id="modalPre"></pre>
  </div>
</div>

<script>
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

const chatEl = document.getElementById("chat");
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");
const abortBtn = document.getElementById("abortBtn");
const modelSelect = document.getElementById("modelSelect");
const thinkingSelect = document.getElementById("thinkingSelect");
const statsPill = document.getElementById("statsPill");
const cwdBar = document.getElementById("cwdBar");
const sidebar = document.getElementById("sidebar");
const sidebarBody = document.getElementById("sidebarBody");
const connDot = document.getElementById("connDot");
const fileModal = document.getElementById("fileModal");
const modalTitle = document.getElementById("modalTitle");
const modalPre = document.getElementById("modalPre");

let appState = { messages: [], isStreaming: false, sessions: [], cwd: "", currentDir: "" };
let activeTab = "sessions";
let liveAssistant = null;

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderMarkdown(text) {
  let out = esc(text || "");
  out = out.replace(/\`\`\`([\\w-]*)\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => \`<pre><code>\${code}</code></pre>\`);
  out = out.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
  return out.split(/\\n\\n+/).map((p) => (p.startsWith("<pre>") ? p : \`<p>\${p.replace(/\\n/g, "<br>")}</p>\`)).join("");
}

function renderToolCard(tc, resultMap) {
  const res = resultMap.get(tc.id);
  const status = res ? (res.isError ? "error" : "done") : "running";
  const argsPreview = tc.arguments && typeof tc.arguments === "object"
    ? (tc.arguments.path || tc.arguments.command || tc.arguments.action || JSON.stringify(tc.arguments).slice(0, 120))
    : "";
  let body = "";
  if (tc.name === "write" && tc.arguments?.content) {
    body = tc.arguments.content.split("\\n").slice(-15).join("\\n");
  } else if (tc.name === "edit" && (tc.arguments?.newText || tc.arguments?.edits)) {
    body = tc.arguments.newText || JSON.stringify(tc.arguments.edits, null, 2);
  } else if (res?.text) {
    body = res.text;
  } else if (tc.arguments) {
    body = JSON.stringify(tc.arguments, null, 2);
  }
  return \`<div class="tool-card">
    <div class="tool-head" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
      <span><span class="tool-name \${res?.isError ? "err" : ""}">\${esc(tc.name)}</span> \${esc(argsPreview)}</span>
      <span style="color:var(--dim)">\${status}</span>
    </div>
    <div class="tool-body" style="display:\${status === "running" || tc.name === "write" || tc.name === "edit" ? "block" : "none"}">\${esc(body.slice(0, 4000))}</div>
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
  const html = [];
  for (const m of msgs) {
    if (m.role === "user") {
      const txt = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.filter((c) => c.type === "text").map((c) => c.text).join("\\n") : "");
      if (txt) html.push(\`<div class="msg"><div class="msg-user">\${esc(txt)}</div></div>\`);
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      const parts = [];
      for (const b of m.content) {
        if (b.type === "thinking" && b.thinking) {
          parts.push(\`<details class="thinking-box"><summary>thinking</summary><div style="margin-top:4px;white-space:pre-wrap">\${esc(b.thinking)}</div></details>\`);
        } else if (b.type === "toolCall") {
          parts.push(renderToolCard(b, resultMap));
        } else if (b.type === "text" && b.text) {
          parts.push(renderMarkdown(b.text));
        }
      }
      if (parts.length) html.push(\`<div class="msg"><div class="msg-assistant">\${parts.join("")}</div></div>\`);
    }
  }
  const atBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
  chatEl.innerHTML = html.join("");
  if (atBottom) chatEl.scrollTop = chatEl.scrollHeight;
}

function renderSidebar() {
  if (activeTab === "sessions") {
    sidebarBody.innerHTML = (appState.sessions || []).map((s) =>
      \`<div class="list-item \${s.active ? "active" : ""}" onclick="switchSession('\${esc(s.path)}')">
        <span class="title">\${esc(s.name || s.firstMessage || "Untitled")}</span>
        <span class="meta">\${esc(s.messageCount || 0)}</span>
      </div>\`
    ).join("") || '<div style="padding:12px;color:var(--dim);font-size:12px">No saved sessions yet.</div>';
  } else {
    loadFiles(appState.currentDir || ".");
  }
}

async function loadFiles(dir) {
  const res = await fetch("/api/files?dir=" + encodeURIComponent(dir));
  const data = await res.json();
  appState.currentDir = data.dir;
  const rows = [];
  if (data.dir !== ".") {
    const up = data.dir.includes("/") ? data.dir.split("/").slice(0, -1).join("/") || "." : ".";
    rows.push(\`<div class="list-item" onclick="loadFiles('\${esc(up)}')"><span class="title">..</span></div>\`);
  }
  for (const e of (data.entries || [])) {
    if (e.isDir) {
      rows.push(\`<div class="list-item" onclick="loadFiles('\${esc(e.path)}')"><span class="title">[dir] \${esc(e.name)}</span></div>\`);
    } else {
      rows.push(\`<div class="list-item" onclick="previewFile('\${esc(e.path)}')"><span class="title">\${esc(e.name)}</span></div>\`);
    }
  }
  sidebarBody.innerHTML = rows.join("");
}

async function previewFile(path) {
  const res = await fetch("/api/file?path=" + encodeURIComponent(path));
  const data = await res.json();
  modalTitle.textContent = path;
  modalPre.textContent = data.content || data.error || "";
  fileModal.classList.add("open");
}

async function switchSession(path) {
  await fetch("/api/switch-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
  await refreshState();
  sidebar.classList.remove("open");
}

async function refreshState() {
  const res = await fetch("/api/state");
  const s = await res.json();
  appState = { ...appState, ...s };
  cwdBar.textContent = s.cwd || "";
  connDot.className = s.isStreaming ? "dot busy" : "dot";
  abortBtn.style.display = s.isStreaming ? "inline-flex" : "none";
  const pct = s.contextUsage && s.contextUsage.percent != null ? s.contextUsage.percent.toFixed(1) + "%" : "0%";
  statsPill.textContent = pct;

  modelSelect.innerHTML = (s.models || []).map((m) => {
    const val = m.provider + "/" + m.id;
    const sel = s.model && s.model.provider === m.provider && s.model.id === m.id ? "selected" : "";
    return \`<option value="\${esc(val)}" \${sel}>\${esc(m.id)}</option>\`;
  }).join("");

  thinkingSelect.innerHTML = (s.availableThinkingLevels || []).map((lvl) =>
    \`<option value="\${esc(lvl)}" \${s.thinkingLevel === lvl ? "selected" : ""}>\${esc(lvl)}</option>\`
  ).join("");

  renderMessages();
  if (activeTab === "sessions") renderSidebar();
}

async function sendPrompt() {
  const text = promptInput.value.trim();
  if (!text) return;
  promptInput.value = "";
  promptInput.style.height = "auto";
  await fetch("/api/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
}

sendBtn.onclick = sendPrompt;
abortBtn.onclick = () => fetch("/api/abort", { method: "POST" });
document.getElementById("newSessionBtn").onclick = async () => {
  await fetch("/api/new-session", { method: "POST" });
  liveAssistant = null;
  await refreshState();
};
document.getElementById("menuBtn").onclick = () => sidebar.classList.toggle("open");
document.getElementById("modalClose").onclick = () => fileModal.classList.remove("open");
modelSelect.onchange = () => {
  const [provider, ...rest] = modelSelect.value.split("/");
  fetch("/api/model", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, id: rest.join("/") }) });
};
thinkingSelect.onchange = () => {
  fetch("/api/thinking", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level: thinkingSelect.value }) });
};
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    activeTab = t.dataset.tab;
    renderSidebar();
  };
});
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});
promptInput.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(160, promptInput.scrollHeight) + "px";
});

const es = new EventSource("/api/events");
es.onmessage = (ev) => {
  const event = JSON.parse(ev.data);
  if (event.type === "agent_start") {
    connDot.className = "dot busy";
    abortBtn.style.display = "inline-flex";
  } else if (event.type === "message_start" && event.message?.role === "assistant") {
    liveAssistant = event.message;
    renderMessages();
  } else if (event.type === "message_update" && event.message?.role === "assistant") {
    liveAssistant = event.message;
    renderMessages();
  } else if (event.type === "message_end" && event.message?.role === "assistant") {
    liveAssistant = null;
    refreshState();
  } else if (event.type === "agent_end" || event.type === "agent_settled" || event.type === "tool_execution_end") {
    refreshState();
  }
};

refreshState();
</script>
</body>
</html>`;
}
