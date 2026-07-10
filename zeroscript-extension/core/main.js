// SPDX-License-Identifier: GPL-3.0-or-later
// core/main.js - the provider-agnostic agentic loop, UI and session state.
// Drives any AI chat site through the ZSProvider interface (providers/*.js):
// waits for the model's reply, parses ZeroScript commands (ZSParse), asks the
// background worker to execute them on the Roblox MCP bridge, and feeds the
// result back. Camouflages the system prompt ("Starting Up") and tool JSON
// behind animated chips, masks injected input, and exposes a Stop button.
// The model ALWAYS receives an output.
//
// This file must NEVER touch the host site's DOM directly - everything
// site-specific goes through P (the provider). Our OWN UI (panel, chips,
// banners…) is plain DOM we create ourselves and is allowed here.

(() => {
  "use strict";
  const P = ZSProvider;
  const T = P.timings;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log("[zeroscript]", ...a);

  // ── Anti-bot mitigation (EXPERIMENTAL) ──────────────────────────────────
  const HUMANIZE_SEND = false;
  const SEND_JITTER_MS = [400, 1400];
  function jitterBeforeSend() {
    if (!HUMANIZE_SEND) return Promise.resolve();
    const [lo, hi] = SEND_JITTER_MS;
    return sleep(lo + Math.random() * (hi - lo));
  }

  // ── State (MUST be declared before diag references it) ───────────────────
  const A = {
    running: false,
    stop: false,
    stopping: false,
    userStopped: false,
    lastGenAt: 0,
    started: false,
    starting: false,
    startingKey: null,
    startGen: 0,
    loopKey: null,
    bootBaselineId: null,
    injecting: false,
    toolRunning: false,
    toolStart: 0,
    toolName: "",
    toolItem: null,
    toolArg: "",
    toolList: [],
    toolNames: new Set(),
    toolCallsSinceReminder: 0,
    bridge: { connected: false, mcpAlive: false, tools: 0 },
    pendingImages: null,
  };

  // ── Diagnostics ───────────────────────────────────────────────────────────
  const ZS_DIAG_MAX = 300;
  const _diag = [];
  function diag(event, data) {
    const snap = { ...P.snapshot(), gen: P.isGenerating(), run: A.running };
    const e = { t: Date.now(), iso: new Date().toISOString().slice(11, 23), event,
                data: data || null, snap };
    _diag.push(e);
    if (_diag.length > ZS_DIAG_MAX) _diag.shift();
    try { console.log("[zs-diag]", e.iso, event, JSON.stringify({ ...data, ...snap })); } catch {}
    try {
      let n = document.getElementById("zs-diag-log");
      if (!n) { n = document.createElement("script"); n.type = "application/json"; n.id = "zs-diag-log"; (document.body || document.documentElement).appendChild(n); }
      n.textContent = JSON.stringify(_diag);
    } catch {}
    try { window.__zsDiag = _diag; } catch {}
  }
  P.init({ diag });

  const KOFI_URL = "https://ko-fi.com/sebattfg";
  const GITHUB_URL = "https://github.com/sebattfg/ZeroScript-Free";
  const EXT_VERSION = chrome.runtime.getManifest().version;
  const VIDEO_URL = "https://youtu.be/kPKiZLZ9_Ps";
  const ROBUX_PASSES = [
    { robux: 30, id: 1865342947 },
    { robux: 100, id: 1866782815 },
    { robux: 300, id: 1869176990 },
    { robux: 1000, id: 1865192973 },
  ];
  const passUrl = (id) => `https://www.roblox.com/game-pass/${id}`;
  const AI_SITES = [
    { name: "DeepSeek", url: "https://chat.deepseek.com/" },
    { name: "Gemini", url: "https://gemini.google.com/app" },
    { name: "Kimi", url: "https://www.kimi.com/" },
    { name: "GLM", url: "https://chat.z.ai/" },
    { name: "Qwen", url: "https://chat.qwen.ai/" },
    { name: "Arena", url: "https://arena.ai/text/direct" },
    { name: "MiMo", url: "https://aistudio.xiaomimimo.com/" },
  ];

  // ── UI ────────────────────────────────────────────────────────────────────
  let root = null;
  let panel = null;
  let startBtn = null;
  let stopBtn = null;
  let statusBar = null;
  let chipsContainer = null;
  let bannerEl = null;

  function ensureRoot() {
    if (root) return root;
    root = document.createElement("div");
    root.id = "zs-root";
    root.innerHTML = `
      <style>
        #zs-root { position:fixed;bottom:16px;right:16px;z-index:2147483646;font-family:"Segoe UI",system-ui,sans-serif;font-size:12px;line-height:1.4;pointer-events:none; }
        #zs-root * { pointer-events:auto; }
        #zs-panel { background:#16161a;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:10px 14px;min-width:200px;max-width:280px;box-shadow:0 8px 32px rgba(0,0,0,.5); }
        #zs-panel .zs-row { display:flex;align-items:center;gap:8px;margin:4px 0;color:#e8e8ec;font-size:11px; }
        #zs-panel .zs-dot { width:8px;height:8px;border-radius:50%;background:#6b7280;flex-shrink:0; }
        #zs-panel .zs-dot.on { background:#34d399;box-shadow:0 0 6px #34d399; }
        #zs-panel .zs-dot.warn { background:#fbbf24;box-shadow:0 0 6px #fbbf24; }
        #zs-panel .zs-free { font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#34d399;background:rgba(52,211,153,.14);border:1px solid rgba(52,211,153,.35);padding:1px 5px;border-radius:5px; }
        #zs-panel .zs-btn { width:100%;margin:6px 0;padding:7px;border:0;border-radius:8px;cursor:pointer;font-size:11px;font-weight:600; }
        #zs-panel .zs-btn.start { background:#34d399;color:#0a0a0a; }
        #zs-panel .zs-btn.start:disabled { background:#374151;color:#6b7280;cursor:not-allowed; }
        #zs-panel .zs-btn.stop { background:#ef4444;color:#fff; }
        #zs-panel .zs-btn.ghost { background:rgba(255,255,255,.08);color:#e8e8ec; }
        #zs-panel .zs-chips { margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08);max-height:120px;overflow-y:auto; }
        #zs-panel .zs-chip { display:inline-block;padding:2px 7px;margin:2px;border-radius:6px;font-size:10px;font-family:monospace; }
        #zs-panel .zs-chip.read { background:rgba(59,130,246,.15);color:#93c5fd; }
        #zs-panel .zs-chip.edit { background:rgba(239,68,68,.15);color:#fca5a5; }
        #zs-panel .zs-chip.screen { background:rgba(168,85,247,.15);color:#c4b5fd; }
        #zs-panel .zs-chip.generate { background:rgba(34,197,94,.15);color:#86efac; }
        #zs-panel .zs-chip.roblox { background:rgba(251,191,36,.15);color:#fde68a; }
        #zs-panel .zs-chip.tool { background:rgba(255,255,255,.08);color:#d1d5db; }
        #zs-banner { margin-top:8px;padding:8px 12px;border-radius:8px;font-size:11px;background:rgba(0,0,0,.8);border:1px solid rgba(255,255,255,.1);color:#e8e8ec;display:none; }
        #zs-banner.show { display:block; }
        #zs-banner.error { border-color:rgba(239,68,68,.5);color:#fca5a5; }
        #zs-banner.info { border-color:rgba(59,130,246,.5);color:#93c5fd; }
      </style>
      <div id="zs-panel">
        <div class="zs-row"><span class="zs-dot" id="zs-dot"></span><span id="zs-state">Bridge: …</span><span class="zs-free" id="zs-ver">v${EXT_VERSION}</span></div>
        <div class="zs-row" id="zs-tools" style="opacity:.75">0 tools available</div>
        <button class="zs-btn start" id="zs-start">▶ Start Roblox Agent</button>
        <button class="zs-btn stop" id="zs-stop" style="display:none">■ Stop</button>
        <div class="zs-chips" id="zs-chips"></div>
        <div style="margin-top:8px;opacity:.6;font-size:10px">
          <a href="${GITHUB_URL}" target="_blank" style="color:#93c5fd;text-decoration:none">GitHub</a> ·
          <a href="${VIDEO_URL}" target="_blank" style="color:#93c5fd;text-decoration:none">Setup video</a> ·
          <a href="${KOFI_URL}" target="_blank" style="color:#ff8fa3;text-decoration:none">♥ Tip</a>
        </div>
      </div>
      <div id="zs-banner"></div>
    `;
    (document.body || document.documentElement).appendChild(root);
    panel = root.querySelector("#zs-panel");
    startBtn = root.querySelector("#zs-start");
    stopBtn = root.querySelector("#zs-stop");
    statusBar = root.querySelector("#zs-state");
    chipsContainer = root.querySelector("#zs-chips");
    bannerEl = root.querySelector("#zs-banner");
    const dot = root.querySelector("#zs-dot");

    startBtn.addEventListener("click", () => startSession());
    stopBtn.addEventListener("click", () => stopSession());

    setInterval(() => {
      chrome.runtime.sendMessage({ type: "status" }, (s) => {
        if (!s) return;
        A.bridge = { connected: s.connected, mcpAlive: s.mcpAlive, tools: s.tools || 0 };
        const mcpOk = s.connected && (s.mcpAlive || s.tools > 0);
        const studioOff = mcpOk && s.studio === false;
        const ok = mcpOk && !studioOff;
        dot.className = "zs-dot " + (s.connected ? (ok ? "on" : "warn") : "");
        statusBar.textContent = s.connected
          ? (ok ? "Connected · Roblox Studio ready"
              : studioOff ? "Studio not connected"
              : "Bridge OK · open Roblox Studio")
          : "Bridge offline";
        const toolsEl = root.querySelector("#zs-tools");
        if (toolsEl) toolsEl.textContent = s.connected ? `${s.tools || 0} tools available` : "Run bridge.py";
        updateChips();
        updateButtons();
      });
    }, 2000);

    return root;
  }

  function updateButtons() {
    if (!startBtn || !stopBtn) return;
    const generating = P.isGenerating();
    if (A.running || A.starting) {
      startBtn.style.display = "none";
      stopBtn.style.display = "block";
      stopBtn.textContent = A.stopping ? "Stopping…" : "■ Stop";
    } else if (generating) {
      startBtn.style.display = "none";
      stopBtn.style.display = "block";
      stopBtn.textContent = "■ Stop";
    } else {
      startBtn.style.display = "block";
      stopBtn.style.display = "none";
      startBtn.disabled = !A.bridge.connected || A.bridge.tools === 0;
      startBtn.textContent = A.bridge.connected && A.bridge.tools > 0 ? "▶ Start Roblox Agent" : "⚠ No tools (check bridge)";
    }
  }

  function updateChips() {
    if (!chipsContainer || !A.toolList.length) return;
    chipsContainer.innerHTML = A.toolList.slice(0, 15).map(t => {
      const cat = (ZS && ZS.toolCategory) ? ZS.toolCategory(t) : "tool";
      return `<span class="zs-chip ${cat}">${t}</span>`;
    }).join("");
  }

  function showBanner(msg, type = "info") {
    if (!bannerEl) return;
    bannerEl.textContent = msg;
    bannerEl.className = `show ${type}`;
    clearTimeout(bannerEl._timeout);
    bannerEl._timeout = setTimeout(() => { bannerEl.className = ""; }, 8000);
  }

  // ── Session management ────────────────────────────────────────────────────
  async function startSession() {
    if (A.running || A.starting) return;
    ensureRoot();
    A.starting = true;
    A.stop = false;
    A.userStopped = false;
    A.stopping = false;
    updateButtons();
    showBanner("Starting session…", "info");

    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "status" }, (s) => resolve(s));
    });
    if (resp && resp.tools) {
      A.toolList = resp.tools.map(t => t.name || t);
      A.toolNames = new Set(A.toolList);
    }
    updateChips();

    const siteName = P.name ? P.name() : "this AI site";
    const prompt = ZS.buildSystemPrompt({ siteName, tools: A.toolList });
    
    try {
      await P.typeAndSend(prompt);
      A.starting = false;
      A.running = true;
      A.started = true;
      updateButtons();
      showBanner("Agent started. Model is now controlling Roblox Studio.", "info");
      agentLoop();
    } catch (e) {
      A.starting = false;
      updateButtons();
      showBanner(`Failed to start: ${e.message}`, "error");
    }
  }

  function stopSession() {
    A.stop = true;
    A.userStopped = true;
    A.stopping = true;
    updateButtons();
    try { P.stop(); } catch {}
  }

  // ── Agentic loop ──────────────────────────────────────────────────────────
  async function agentLoop() {
    while (A.running && !A.stop) {
      try {
        const reply = await P.waitForReply();
        if (!reply || A.stop) break;
        if (A.userStopped) { A.userStopped = false; break; }

        const parsed = ZSParse.parse(reply);
        if (!parsed || !parsed.tool) continue;

        A.toolName = parsed.tool;
        A.toolRunning = true;
        A.toolStart = Date.now();
        updateButtons();

        const result = await runTool(parsed.tool, parsed.arguments);
        A.toolRunning = false;
        
        if (A.stop) break;

        const feedback = formatToolResult(parsed.tool, result);
        await P.typeAndSend(feedback);
      } catch (e) {
        log("agentLoop error", e);
        if (!A.stop) {
          try { await P.typeAndSend(`ERROR: ${e.message}. Please try again.`); } catch {}
        }
      }
    }
    A.running = false;
    A.stopping = false;
    A.started = false;
    updateButtons();
  }

  async function runTool(tool, args) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "execute", tool, args }, (r) => {
        resolve(r || { ok: false, error: "no response" });
      });
    });
  }

  function formatToolResult(tool, result) {
    if (!result.ok) {
      return `Tool "${tool}" failed: ${result.error || "unknown error"}. Fix and retry.`;
    }
    const data = result.data !== undefined ? result.data : result.result;
    if (typeof data === "string") return data;
    return JSON.stringify(data, null, 2);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  ensureRoot();
  updateButtons();
})();
