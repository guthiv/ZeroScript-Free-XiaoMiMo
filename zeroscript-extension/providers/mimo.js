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
    // a specific aria-label or data attribute.
    sendBtn: [
      "button[data-track-id='home_send_btn']",
      "button[data-track-id*='send']",
      "button[aria-label*='send' i]",
      "button[aria-label*='Send' i]",
      "button[aria-label*='submit' i]",
      "button[type='submit']",
      "button.send-btn",
      "button[class*='send']",
      "button[class*='Send']",
      // MiMo standard: a button with an SVG icon (arrow)
      "button:has(svg)",
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
    const selectors = S.editor.split(", ");
    for (const sel of selectors) {
      try {
        const all = document.querySelectorAll(sel);
        for (const el of all) {
          // Skip elements inside ZeroScript's own UI
          if (el.closest('#zs-root')) continue;
          // For broad fallback selectors, ensure it's visible
          if (sel.includes(':not') || sel === "textarea") {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
          }
          return el;
        }
      } catch (e) {
        continue;
      }
    }
    return null;
  }

  // Get the composer container (for bar placement)
  function getComposer() {
    // Try the composer selectors first
    const selectors = S.composer.split(", ");
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && !el.closest('#zs-root')) return el;
      } catch (e) { continue; }
    }
    // Fallback: find the textarea's closest container
    const editor = getEditor();
    if (editor) {
      let el = editor.parentElement;
      while (el && el !== document.body) {
        const cn = el.className || '';
        if (typeof cn === 'string' &&
            (cn.includes('composer') || cn.includes('input') ||
             cn.includes('footer') || cn.includes('chat'))) {
          return el;
        }
        el = el.parentElement;
      }
      return editor.parentElement;
    }
    return null;
  }

  function getSendButton() {
    const selectors = S.sendBtn.split(", ");
    for (const sel of selectors) {
      try {
        const all = document.querySelectorAll(sel);
        for (const el of all) {
          if (el.closest('#zs-root')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return el;
        }
      } catch (e) { continue; }
    }
    return null;
  }

  function isGenerating() {
    // Check for stop button presence (indicates generation in progress)
    const stopBtns = document.querySelectorAll(S.stopBtn);
    for (const btn of stopBtns) {
      if (!btn.closest('#zs-root')) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return true;
      }
    }
    // Check for loading/streaming indicators
    const genEls = document.querySelectorAll(S.generating);
    for (const el of genEls) {
      if (!el.closest('#zs-root')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return true;
      }
    }
    return false;
  }

  // ── Input primitives ────────────────────────────────────────────────────
  // MiMo uses React. To set the textarea value, we MUST:
  // 1. Use the native value setter (Object.getOwnPropertyDescriptor)
  // 2. Dispatch an 'input' Event (bubbles: true) so React's synthetic
  //    event system picks up the change and updates its internal state.
  function typeIn(editor, text) {
    if (!editor) return;
    editor.focus();
    // Use the native setter to bypass React's controlled component
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value'
    );
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(editor, text);
    } else {
      editor.value = text;
    }
    // Dispatch input event for React
    editor.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    // Also dispatch a change event (some frameworks listen for this)
    editor.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  async function sendMessage(text) {
    const editor = getEditor();
    if (!editor) {
      diag("MiMo: editor not found");
      return false;
    }
    const btn = getSendButton();
    if (!btn) {
      diag("MiMo: send button not found");
      return false;
    }

    // Type the text
    typeIn(editor, text);
    await sleep(150);

    // Click the send button
    btn.click();
    return true;
  }

  // ── Public interface (required by core/main.js) ─────────────────────────
  return {
    init(diagFn) {
      diag = diagFn || (() => {});
      diag("MiMo provider initialised");
    },

    // Detect which MiMo variant we're on
    siteName() {
      if (location.hostname.includes('ultraspeed')) return "MiMo Ultra";
      return "MiMo";
    },

    // Return the composer container so the core can position the bar
    getComposer,

    // Return the editor element
    getEditor,

    // Send a message through the MiMo UI
    sendMessage,

    // Type text into the editor without sending
    typeIn,

    // Turn classification
    allItems,
    isUserItem,
    isAssistantItem,
    itemText,
    classifyText,
    assistantItems,
    assistantCount,
    userCount,

    // State
    isGenerating,

    // Error detection
    getError() {
      const surfaces = document.querySelectorAll(S.errorSurfaces);
      for (const el of surfaces) {
        if (el.closest('#zs-root')) continue;
        const text = el.textContent.trim();
        if (!text) continue;
        if (RE.contextLimit.test(text)) return { kind: 'context', text };
        if (RE.busy.test(text)) return { kind: 'busy', text };
        if (RE.stopped.test(text)) return { kind: 'stopped', text };
        if (RE.tooLong.test(text)) return { kind: 'toolong', text };
      }
      return null;
    },

    // Timings
    timings,

    // Regex patterns
    RE,
  };
})();
