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
  // Multiple fallbacks for each selector to handle both standard and ultra-speed versions.
  const S = {
    // The message list container (scrollable area)
    chatList: "#message-list, [class*='message-list'], [class*='chat-list'], [class*='messages']",
    // Each message item is a direct child of the chatList
    chatItem: "> div", // direct child divs of the chatList
    // User messages: they have a div with class 'bg-mimo-bg-message' or alignment 'justify-end'
    userIndicator: ".bg-mimo-bg-message, [class*='user-message'], [class*='userMessage']",
    assistantIndicator: ".justify-start, [class*='assistant-message'], [class*='assistantMessage']",
    userAlign: "justify-end",
    assistantAlign: "justify-start",
    // Text container for user messages
    userText: ".whitespace-pre-wrap, [class*='message-content'], [class*='user-text']",
    // Assistant text: sometimes inside <p> or .prose
    assistantText: "p, .prose, .markdown, [class*='message-content'], [class*='assistant-text']",
    // Composer - multiple fallbacks for different MiMo versions.
    // CRITICAL: MiMo uses a React-controlled <textarea>. We MUST trigger
    // the native setter + dispatch an 'input' Event (bubbles: true) so
    // React's synthetic event system picks it up.
    editor: [
      "textarea[placeholder*='Ask me anything']",
      "textarea[placeholder*='ask']",
      "textarea[placeholder*='message']",
      "textarea[placeholder*='Message']",
      "textarea[placeholder*='chat']",
      "textarea[placeholder*='Chat']",
      "textarea[placeholder*='send']",
      "textarea[placeholder*='Send']",
      "textarea[placeholder*='type']",
      "textarea[placeholder*='Type']",
      "textarea[placeholder]",
      // Last resort: ANY textarea NOT inside our own UI
      "textarea:not(#zs-root textarea)",
      "[contenteditable='true'][role='textbox']:not(#zs-root *)",
      "[contenteditable='true']:not(#zs-root *)",
    ].join(", "),
    // Send button - multiple fallbacks. MiMo standard uses a button with
    // a specific aria-label or data attribute. All selectors exclude our
    // own ZeroScript UI (#zs-root) to avoid false matches.
    sendBtn: [
      "button[data-track-id='home_send_btn']:not(#zs-root *)",
      "button[data-track-id*='send']:not(#zs-root *)",
      "button[aria-label*='send' i]:not(#zs-root *)",
      "button[aria-label*='Send' i]:not(#zs-root *)",
      "button[aria-label*='submit' i]:not(#zs-root *)",
      "button[type='submit']:not(#zs-root *)",
      "button.send-btn:not(#zs-root *)",
      "button[class*='send']:not(#zs-root *)",
      "button[class*='Send']:not(#zs-root *)",
      // Fallback: button with an SVG child (arrow icon) - safe JS fallback, not :has()
    ].join(", "),
    stopBtn: "button[aria-label*='stop' i]:not(#zs-root *), button[class*='stop']:not(#zs-root *), button[class*='Stop']:not(#zs-root *)",
    generating: ".loading, .streaming, [class*='generating'], [class*='thinking'], [class*='streaming']",
    errorSurfaces: '[role="alert"], [class*="error"], [class*="alert"], [class*="toast"]',
    // Composer container (for scoping button/editor searches)
    composer: "[class*='composer'], [class*='input-area'], [class*='inputArea'], [class*='footer'], [class*='chat-input'], [class*='chatInput']",
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

  function lastAssistant() {
    const items = assistantItems();
    return items.length ? items[items.length - 1] : null;
  }

  function lastUser() {
    const items = allItems().filter(isUserItem);
    return items.length ? items[items.length - 1] : null;
  }

  // ── Input / composer ────────────────────────────────────────────────────
  function editor() {
    // Scope search to composer container first for reliability
    const composer = document.querySelector(S.composer);
    const scope = composer || document;
    const el = scope.querySelector(S.editor);
    return el;
  }

  // Find send button - with JS fallback for SVG-icon buttons (no :has())
  function findSendBtn() {
    // Try CSS selectors first (excluding our own UI)
    for (const sel of S.sendBtn.split(", ")) {
      try {
        const el = document.querySelector(sel);
        if (el && !el.closest('#zs-root')) return el;
      } catch (e) {
        // Skip invalid selectors silently
      }
    }
    // JS fallback: find buttons with SVG children (the send arrow icon)
    // MiMo standard uses a button containing an SVG in the footer area
    const composer = document.querySelector(S.composer);
    const scope = composer || document;
    const buttons = scope.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.closest('#zs-root')) continue;
      if (btn.querySelector('svg')) return btn;
    }
    return null;
  }

  function isGenerating() {
    // Check for loading/thinking indicators
    if (document.querySelector(S.generating)) return true;
    // Check if send button shows a stop icon (meaning generation is active)
    const btn = findSendBtn();
    if (!btn) return false;
    // If the primary button contains a stop/square icon instead of arrow
    const svg = btn.querySelector('svg');
    if (!svg) return false;
    // Stop icons typically have rect or a square shape
    const hasRect = svg.querySelector('rect');
    // Send icons typically have path (arrow)
    const hasPath = svg.querySelector('path');
    // If it has a rect (stop button) and no arrow path, it's generating
    if (hasRect && !hasPath) return true;
    return false;
  }

  async function typeAndSend(text, opts = {}) {
    const ed = editor();
    if (!ed) throw new Error("MiMo editor not found");
    // Focus the editor
    ed.focus();
    await sleep(100);
    // Set value using native setter for React
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeSetter.call(ed, text);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    // Find and click send button
    const btn = findSendBtn();
    if (!btn) throw new Error("MiMo send button not found");
    btn.click();
  }

  function stopGeneration() {
    const stopBtn = document.querySelector(S.stopBtn);
    if (stopBtn && !stopBtn.closest('#zs-root')) {
      stopBtn.click();
      return true;
    }
    return false;
  }

  // ── Snapshot / identity ─────────────────────────────────────────────────
  function snapshot() {
    return {
      assistantCount: assistantCount(),
      userCount: userCount(),
      generating: isGenerating(),
    };
  }

  function conversationKey() {
    const items = allItems();
    if (!items.length) return null;
    // Use first user message as key
    const firstUser = items.find(isUserItem);
    if (!firstUser) return null;
    return itemText(firstUser).slice(0, 100);
  }

  // ── Public interface ────────────────────────────────────────────────────
  return {
    timings,
    init(opts) {
      if (opts && opts.diag) diag = opts.diag;
    },
    allItems,
    isUserItem,
    isAssistantItem,
    itemText,
    classifyText,
    assistantItems,
    assistantCount,
    userCount,
    lastAssistant,
    lastUser,
    editor,
    findSendBtn,
    isGenerating,
    typeAndSend,
    stopGeneration,
    snapshot,
    conversationKey,
  };
})();
