// SPDX-License-Identifier: GPL-3.0-or-later
// providers/mimo.js - the MiMo (aistudio.xiaomimimo.com & ultraspeed.xiaomimimo.com) provider.
// EVERYTHING that knows MiMo's DOM, quirks, and UI strings lives here; the
// core (core/main.js) only ever talks to the ZSProvider interface this file
// exports.
//
// MiMo notes (validated live on both standard and ultra-speed versions):
//  - One turn = one .chat-message or .message-item. User turns have a user class;
//    assistant turns have an assistant class.
//  - The input is a real <textarea> (not a contenteditable): we set its value via
//    the native setter + an input event, then click the primary send button.
//  - "generating" is detected from the primary footer button: while streaming it
//    shows a stop button; when idle a send arrow. Also, a .loading or .thinking
//    class may appear.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  // DOM selectors for MiMo. Grouped so a future site tweak is a one-liner.
  const S = {
    // The message list container (scrollable area)
    chatList: "#message-list",
    // Each message item is a direct child of the chatList
    chatItem: "> div", // direct child divs of the chatList
    // User messages: they have a div with class 'bg-mimo-bg-message' or alignment 'justify-end'
    userIndicator: ".bg-mimo-bg-message", // user bubble class
    assistantIndicator: ".justify-start", // assistant alignment
    userAlign: "justify-end",
    assistantAlign: "justify-start",
    // Text container for user messages
    userText: ".whitespace-pre-wrap",
    // Assistant text: sometimes inside <p> or .prose
    assistantText: "p, .prose, .markdown",
    // Composer - multiple fallback selectors for different MiMo versions
    editor: [
      "textarea[placeholder*='Ask me anything']",
      "textarea[placeholder*='Ask']",
      "textarea[placeholder*='Message']",
      "textarea[placeholder*='message']",
      "textarea:not([aria-hidden='true'])"
    ].join(","),
    sendBtn: [
      "button[data-track-id='home_send_btn']",
      "button[aria-label*='send' i]",
      "button[aria-label*='Send']",
      "button[type='submit']:not([disabled])",
      "button:has(svg):not([disabled])"
    ].join(","),
    stopBtn: "button[aria-label*='stop' i], button[class*='stop']",
    generating: ".loading, .streaming, [class*='generating']",
    errorSurfaces: '[role="alert"], [class*="error"], [class*="alert"], [class*="toast"]',
  };

  // Error / state regexes (English only - MiMo's UI is primarily English).
  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|limit|exceeded)",
        "context.{0,20}(limit|exceeded)",
        "session.{0,20}(expired)",
        "please.{0,30}(start|create).{0,20}(new).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "message.{0,20}too.{0,10}long",
        "maximum.{0,20}context",
        "this conversation has reached",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long)/i,
    busy: /server is busy|please try again|system is currently busy/i,
    continueBtn: /^(continue|continuer|继续|fortfahren|continuar|seguir|続行)$/i,
    stopped: /(stopped|已停止|停止生成|已暂停)/i,
  };

  // Completion-detection windows, calibrated for MiMo's typical response speed.
  const timings = {
    GEN_IDLE_MS: 800,
    REASON_IDLE_MS: 10000,
    WARMUP_MS: 30000,
    REASON_NOREPLY_MS: 60000,
    STABLE_MS: 8000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ──────────────────────────────────────────────────
  // Get all message items (direct children of the chat list)
  function allItems() {
    const list = document.querySelector(S.chatList);
    if (!list) return [];
    // Direct children that are divs (the message containers)
    return [...list.children].filter(el => el.tagName === 'DIV');
  }

  function isUserItem(item) {
    if (!item) return false;
    // Look for the user bubble class
    if (item.querySelector(S.userIndicator)) return true;
    // Or check alignment class
    if (item.classList.contains(S.userAlign)) return true;
    // Or check if it has a user-specific class (e.g., from Tailwind)
    if (item.className.includes('justify-end')) return true;
    return false;
  }

  const isAssistantItem = (item) => !!item && !isUserItem(item);

  // Get the text content of a message item
  function itemText(item) {
    if (isAssistantItem(item)) {
      // Try to find the assistant text container: <p> or .prose or .markdown
      const textContainer = item.querySelector(S.assistantText);
      if (textContainer) return textContainer.textContent.trim();
      // Fallback: all text excluding any child that might be a button or metadata
      return item.textContent.trim();
    } else {
      // User message: find the .whitespace-pre-wrap or fallback to textContent
      const textContainer = item.querySelector(S.userText);
      if (textContainer) return textContainer.textContent.trim();
      return item.textContent.trim();
    }
  }

  // Text used by the core to CLASSIFY a turn for camouflage - excludes the
  // reasoning area AND any element matching `excludeSel`.
  function classifyText(item, excludeSel) {
    let text = itemText(item);
    if (excludeSel) {
      const temp = item.cloneNode(true);
      const els = temp.querySelectorAll(excludeSel);
      for (const el of els) el.remove();
      text = temp.textContent.trim();
    }
    return text;
  }

  // ── DOM primitives ──────────────────────────────────────────────────────
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  // Get the main textarea (composer). Scope to the site's composer only;
  // avoid matching ZeroScript's own injected UI.
  function getEditor() {
    // Try the composite selector first
    const editors = document.querySelectorAll(S.editor);
    for (const e of editors) {
      if (e.closest('#zs-root')) continue;
      if (e.offsetParent === null && e.closest('[style*="display:none"]')) continue;
      return e;
    }
    // Broader fallback: any visible textarea not in our UI
    const allTextareas = document.querySelectorAll('textarea');
    for (const ta of allTextareas) {
      if (ta.closest('#zs-root')) continue;
      if (ta.offsetParent === null) continue;
      if (ta.getAttribute('aria-hidden') === 'true') continue;
      return ta;
    }
    return null;
  }

  // Get the primary send button
  function getSendBtn() {
    // Try the composite selector first
    const btns = document.querySelectorAll(S.sendBtn);
    for (const b of btns) {
      if (b.closest('#zs-root')) continue;
      if (b.offsetParent !== null && !b.disabled) return b;
    }
    // Broader fallback: find a button near the textarea
    const editor = getEditor();
    if (editor) {
      // Look for a sibling or nearby button
      const parent = editor.closest('form') || editor.parentElement;
      if (parent) {
        const btn = parent.querySelector('button[type="submit"]:not([disabled]), button:not([disabled])');
        if (btn && !btn.closest('#zs-root')) return btn;
      }
      // Look in the same container
      let container = editor.closest('[class*="input"], [class*="composer"], [class*="footer"], [class*="bottom"]');
      if (!container) container = editor.parentElement?.parentElement;
      if (container) {
        const btn = container.querySelector('button:not([disabled])');
        if (btn && !btn.closest('#zs-root')) return btn;
      }
    }
    // Last resort: any visible, non-disabled button that looks like a send button
    const allBtns = document.querySelectorAll('button:not([disabled])');
    for (const b of allBtns) {
      if (b.closest('#zs-root')) continue;
      if (b.offsetParent === null) continue;
      const svg = b.querySelector('svg');
      if (svg && b.offsetWidth < 100 && b.offsetHeight < 60) {
        return b;
      }
    }
    return null;
  }

  // Determine if the primary button is in "stop" state (generating).
  function isStopBtn(btn) {
    if (!btn) return false;
    if (btn.classList.contains('stop') || btn.classList.contains('stopping')) return true;
    const txt = btn.textContent.trim().toLowerCase();
    if (txt === 'stop' || txt === '■' || txt === '⏹' || txt.includes('stop')) return true;
    const svg = btn.querySelector('svg');
    if (svg) {
      const path = svg.querySelector('path');
      if (path) {
        const d = path.getAttribute('d') || '';
        if (d.match(/M\s*\d+\s+\d+\s+h\s*\d+/i)) return true;
      }
    }
    return false;
  }

  // Check if the UI indicates the model is currently generating.
  function isGenerating() {
    if (document.querySelector(S.generating)) return true;
    const btn = getSendBtn();
    if (isStopBtn(btn)) return true;
    return false;
  }

  // Snapshot for diagnostics
  function snapshot() {
    return {
      userCount: userCount(),
      assistantCount: assistantCount(),
      generating: isGenerating(),
      editorFound: !!getEditor(),
      sendBtnFound: !!getSendBtn(),
    };
  }

  // Initialize - receive the diag function from core
  function init(opts) {
    if (opts && opts.diag) diag = opts.diag;
  }

  return {
    init,
    timings,
    snapshot,
    allItems,
    isUserItem,
    isAssistantItem,
    itemText,
    classifyText,
    assistantItems,
    assistantCount,
    userCount,
    getEditor,
    getSendBtn,
    isStopBtn,
    isGenerating,
  };
})();
