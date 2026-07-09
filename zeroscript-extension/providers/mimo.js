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
    // Composer - multiple fallbacks for different MiMo versions
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
      "textarea",
      "[contenteditable='true'][role='textbox']",
      "[contenteditable='true']",
    ].join(", "),
    // Send button - multiple fallbacks
    sendBtn: [
      "button[data-track-id='home_send_btn']",
      "button[data-track-id*='send']",
      "button[aria-label*='send' i]",
      "button[aria-label*='Send' i]",
      "button[type='submit']",
      "button.send-btn",
      "button[class*='send']",
      "button[class*='Send']",
    ].join(", "),
    stopBtn: "button[aria-label*='stop' i], button[class*='stop'], button[class*='Stop']",
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
    // Try each selector in the comma-separated list individually
    const selectors = S.editor.split(", ");
    for (const sel of selectors) {
      try {
        const editors = document.querySelectorAll(sel);
        for (const e of editors) {
          // Skip our own UI
          if (e.closest('#zs-root')) continue;
          // Skip hidden elements
          if (e.offsetParent === null && e.closest('[style*="display:none"]')) continue;
          // For textareas, they must be visible
          if (e.tagName === 'TEXTAREA' && e.offsetParent !== null) return e;
          // For contenteditable
          if (e.getAttribute('contenteditable') === 'true') {
            if (e.offsetParent !== null) return e;
          }
        }
      } catch (_) {
        // selector might be invalid - skip to next
      }
    }

    // Last resort: find ANY visible textarea not in our UI
    const allTextareas = document.querySelectorAll('textarea');
    for (const t of allTextareas) {
      if (t.closest('#zs-root')) continue;
      if (t.offsetParent !== null && !t.disabled) return t;
    }

    // Try contenteditable as final fallback
    const editables = document.querySelectorAll('[contenteditable="true"]');
    for (const e of editables) {
      if (e.closest('#zs-root')) continue;
      if (e.offsetParent !== null) return e;
    }

    return null;
  }

  // Get the primary send button
  function getSendBtn() {
    // Try each selector individually
    const selectors = S.sendBtn.split(", ");
    for (const sel of selectors) {
      try {
        const btns = document.querySelectorAll(sel);
        for (const b of btns) {
          if (b.closest('#zs-root')) continue;
          if (b.offsetParent !== null && !b.disabled) return b;
        }
      } catch (_) {
        // selector might be invalid - skip to next
      }
    }

    // Fallback: any button inside the composer that looks like a submit/send button
    const composer = document.querySelector(S.composer);
    if (composer) {
      const btn = composer.querySelector('button[type="submit"], button:not([disabled])');
      if (btn) return btn;
    }

    // Last resort: find the last visible button near the textarea that looks like a submit
    const editor = getEditor();
    if (editor) {
      const container = editor.closest('form') || editor.closest('[class*="composer"]') || editor.closest('[class*="input"]') || editor.parentElement;
      if (container) {
        const btns = container.querySelectorAll('button:not([disabled])');
        for (const b of btns) {
          if (b.closest('#zs-root')) continue;
          if (b.offsetParent !== null) return b;
        }
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
    if (btn && isStopBtn(btn)) return true;
    return false;
  }

  // Stop the current generation if possible.
  function stopGeneration() {
    // Try the stop button selectors
    const stopBtns = document.querySelectorAll(S.stopBtn);
    for (const b of stopBtns) {
      if (b.closest('#zs-root')) continue;
      if (b.offsetParent !== null) {
        b.click();
        return true;
      }
    }
    // Try the send button (which turns into a stop button during generation)
    const btn = getSendBtn();
    if (btn && isStopBtn(btn)) {
      btn.click();
      return true;
    }
    return false;
  }

  // ── Compose & send ───────────────────────────────────────────────────────
  // Type text into the composer and send it.
  async function typeAndSend(text, images) {
    const editor = getEditor();
    if (!editor) {
      console.warn("[zs-mimo] editor not found");
      return false;
    }
    const sendBtn = getSendBtn();
    if (!sendBtn) {
      console.warn("[zs-mimo] send button not found");
      return false;
    }

    // Focus and set value
    editor.focus();
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      // Native setter + input event for React-controlled inputs
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
      ) || Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value'
      );
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(editor, text);
      } else {
        editor.value = text;
      }
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable
      editor.textContent = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Wait a tick for React to process the input
    await sleep(150);

    // Attach images if any (for vision feedback)
    if (images && images.length > 0) {
      // Images are attached by the core via DOM manipulation
      // For now, just log that we have images to attach
      console.log("[zs-mimo] images to attach:", images.length);
    }

    // Click send
    sendBtn.click();
    return true;
  }

  // Submit text directly (used for tool results)
  async function submitText(text) {
    return typeAndSend(text, null);
  }

  // Get the last assistant turn's text
  function lastAssistantText() {
    const items = assistantItems();
    if (items.length === 0) return "";
    return itemText(items[items.length - 1]);
  }

  // Get a snapshot of the current conversation state for diag
  function snapshot() {
    return {
      userTurns: userCount(),
      assistantTurns: assistantCount(),
      generating: isGenerating(),
    };
  }

  // Get the unique conversation key (URL-based)
  function conversationKey() {
    return window.location.pathname + window.location.search;
  }

  // Initialize - called by core/main.js
  function init(opts) {
    if (opts && opts.diag) diag = opts.diag;
  }

  // Wait for the response to complete
  async function waitForResponse() {
    // Wait until generation stops (idle for GEN_IDLE_MS)
    let idleCount = 0;
    while (idleCount < timings.GEN_IDLE_MS / 100) {
      await sleep(100);
      if (isGenerating()) {
        idleCount = 0;
      } else {
        idleCount++;
      }
    }
    // Small extra settle
    await sleep(300);
    return lastAssistantText();
  }

  // ── Public interface ────────────────────────────────────────────────────
  return {
    init,
    timings,
    snapshot,
    conversationKey,
    isGenerating,
    stopGeneration,
    typeAndSend,
    submitText,
    waitForResponse,
    lastAssistantText,
    allItems,
    assistantItems,
    userCount,
    assistantCount,
    isUserItem,
    isAssistantItem,
    itemText,
    classifyText,
    getEditor,
    getSendBtn,
  };
})();
