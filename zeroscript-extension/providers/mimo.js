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
    // Composer
    editor: "textarea[placeholder*='Ask me anything']",
    sendBtn: "button[data-track-id='home_send_btn']",
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
    // For simplicity, we return the same as itemText, but we could exclude
    // elements with excludeSel if needed.
    let text = itemText(item);
    if (excludeSel) {
      // Remove any content inside elements matching excludeSel
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
    const editors = document.querySelectorAll(S.editor);
    for (const e of editors) {
      if (e.closest('#zs-root')) continue;
      if (e.offsetParent === null && e.closest('[style*="display:none"]')) continue;
      return e;
    }
    return null;
  }

  // Get the primary send button
  function getSendBtn() {
    const btns = document.querySelectorAll(S.sendBtn);
    for (const b of btns) {
      if (b.closest('#zs-root')) continue;
      if (b.offsetParent !== null && !b.disabled) return b;
    }
    // Fallback: any button inside the composer with type submit
    const composer = document.querySelector('[class*="composer"], [class*="input-area"]');
    if (composer) {
      const btn = composer.querySelector('button[type="submit"], button:not([disabled])');
      if (btn) return btn;
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
    if (btn && isStopBtn(btn)) return true;
    if (document.querySelector('[class*="spinner"], [class*="thinking"]')) return true;
    return false;
  }

  // Check for a "Continue" button that needs to be clicked to resume.
  function getContinueBtn() {
    const btns = document.querySelectorAll('button, [role="button"]');
    for (const b of btns) {
      if (b.closest('#zs-root')) continue;
      const txt = b.textContent.trim();
      if (RE.continueBtn.test(txt)) return b;
    }
    return null;
  }

  // ── Provider interface ──────────────────────────────────────────────────

  // init: called by core with a diagnostic function.
  function init(diagFn) {
    diag = diagFn || (() => {});
  }

  // isActive: returns true if this provider matches the current page.
  function isActive() {
    const url = window.location.href;
    return url.includes('aistudio.xiaomimimo.com') || url.includes('ultraspeed.xiaomimimo.com');
  }

  // typeAndSend: type the given text into the composer and send it.
  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) {
      diag('[MiMo] No editor found');
      return false;
    }

    editor.focus();
    editor.value = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    await sleep(100);

    const sendBtn = getSendBtn();
    if (sendBtn) {
      sendBtn.click();
      return true;
    }

    // Fallback: try pressing Enter
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  }

  // getLastAssistantMessage: returns the text of the latest assistant turn.
  function getLastAssistantMessage() {
    const items = assistantItems();
    if (items.length === 0) return null;
    const last = items[items.length - 1];
    return itemText(last);
  }

  // getLastAssistantNode: returns the DOM node of the latest assistant turn.
  function getLastAssistantNode() {
    const items = assistantItems();
    if (items.length === 0) return null;
    return items[items.length - 1];
  }

  // getLastUserMessage: returns the text of the latest user turn.
  function getLastUserMessage() {
    const items = allItems().filter(isUserItem);
    if (items.length === 0) return null;
    const last = items[items.length - 1];
    return itemText(last);
  }

  // getLastUserNode: returns the DOM node of the latest user turn.
  function getLastUserNode() {
    const items = allItems().filter(isUserItem);
    if (items.length === 0) return null;
    return items[items.length - 1];
  }

  // getTurnCounts: returns { user, assistant } counts.
  function getTurnCounts() {
    return { user: userCount(), assistant: assistantCount() };
  }

  // waitForResponse: waits for the model to finish generating.
  // Returns the final assistant message text, or null on timeout/error.
  async function waitForResponse(timeoutMs) {
    const start = Date.now();
    const timeout = timeoutMs || timings.RESPONSE_TIMEOUT_MS;

    let lastText = '';
    let stableStart = 0;
    let idleStart = 0;

    while (Date.now() - start < timeout) {
      if (checkForErrors()) {
        diag('[MiMo] Error detected, stopping wait');
        return null;
      }

      const items = assistantItems();
      if (items.length === 0) {
        await sleep(200);
        continue;
      }

      const latest = items[items.length - 1];
      const text = itemText(latest);

      if (!text.trim()) {
        await sleep(200);
        continue;
      }

      const contBtn = getContinueBtn();
      if (contBtn) {
        diag('[MiMo] Continue button detected, clicking it');
        contBtn.click();
        await sleep(500);
        continue;
      }

      const gen = isGenerating();
      if (gen) {
        idleStart = 0;
        if (text !== lastText) {
          stableStart = 0;
          lastText = text;
        } else {
          if (stableStart === 0) stableStart = Date.now();
          if (Date.now() - stableStart > timings.STABLE_MS) {
            diag('[MiMo] Text frozen while generating, assuming done');
            return lastText;
          }
        }
      } else {
        if (lastText && text === lastText) {
          if (idleStart === 0) idleStart = Date.now();
          if (Date.now() - idleStart > timings.GEN_IDLE_MS) {
            diag('[MiMo] Text stable, response complete');
            return lastText;
          }
        } else {
          idleStart = 0;
          lastText = text;
        }
      }

      if (lastText.trim() && Date.now() - start > 30000) {
        diag('[MiMo] Long wait with text, returning what we have');
        return lastText;
      }

      await sleep(500);
    }

    const finalText = getLastAssistantMessage();
    if (finalText) {
      diag('[MiMo] Timeout but returning last message');
      return finalText;
    }
    diag('[MiMo] Timeout with no response');
    return null;
  }

  // checkForErrors: scans for error messages and returns true if found.
  function checkForErrors() {
    const surfaces = document.querySelectorAll(S.errorSurfaces);
    for (const el of surfaces) {
      const txt = el.textContent || '';
      if (RE.contextLimit.test(txt) || RE.tooLong.test(txt) || RE.busy.test(txt)) {
        diag('[MiMo] Error detected:', txt);
        return true;
      }
    }
    return false;
  }

  // getSiteName: returns a human-readable name for the current site.
  function getSiteName() {
    const url = window.location.href;
    if (url.includes('ultraspeed')) return 'MiMo (UltraSpeed)';
    return 'MiMo Studio';
  }

  // ── Exports ─────────────────────────────────────────────────────────────
  return {
    init,
    isActive,
    typeAndSend,
    getLastAssistantMessage,
    getLastAssistantNode,
    getLastUserMessage,
    getLastUserNode,
    getTurnCounts,
    waitForResponse,
    getEditor,
    getSendBtn,
    isGenerating,
    isStopBtn,
    getContinueBtn,
    checkForErrors,
    getSiteName,
    _S: S,
    _timings: timings,
  };
})();
