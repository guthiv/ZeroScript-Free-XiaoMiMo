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
    // Each message item - now uses a more robust direct-child + class fallback approach
    chatItem: "> div, > [class*='message-item'], > [class*='chat-message'], > [class*='MessageItem']",
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
      "textarea:not(#zs-root textarea)",
      "[contenteditable='true'][role='textbox']:not(#zs-root *)",
      "[contenteditable='true']:not(#zs-root *)",
    ].join(", "),
    // Send button - all scoped with :not(#zs-root *) to avoid targeting ZeroScript UI.
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
    ].join(", "),
    stopBtn: "button[aria-label*='stop' i], button[class*='stop'], button[class*='Stop']",
    generating: ".loading, .streaming, [class*='generating'], [class*='thinking'], [class*='streaming']",
    errorSurfaces: '[role="alert"], [class*="error"], [class*="alert"], [class*="toast"]',
    composer: "[class*='composer'], [class*='input-area'], [class*='inputArea'], [class*='footer'], [class*='chat-input'], [class*='chatInput']",
  };

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

  const timings = {
    GEN_IDLE_MS: 800,
    REASON_IDLE_MS: 10000,
    WARMUP_MS: 30000,
    REASON_NOREPLY_MS: 60000,
    STABLE_MS: 8000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  function allItems() {
    const list = document.querySelector(S.chatList);
    if (!list) return [];
    return [...list.children].filter(el => el.tagName === 'DIV');
  }

  function isUserItem(item) {
    if (!item) return false;
    if (item.querySelector(S.userIndicator)) return true;
    if (item.classList.contains(S.userAlign)) return true;
    if (item.className && item.className.includes && item.className.includes('justify-end')) return true;
    return false;
  }

  const isAssistantItem = (item) => !!item && !isUserItem(item);

  function itemText(item) {
    if (isAssistantItem(item)) {
      const textContainer = item.querySelector(S.assistantText);
      if (textContainer) return textContainer.textContent.trim();
      return item.textContent.trim();
    } else {
      const textContainer = item.querySelector(S.userText);
      if (textContainer) return textContainer.textContent.trim();
      return item.textContent.trim();
    }
  }

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

  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  function findEditor() {
    const sel = S.editor;
    const selectors = sel.split(", ").map(s => s.trim());
    for (const s of selectors) {
      try {
        const el = document.querySelector(s);
        if (el && !el.closest("#zs-root")) return el;
      } catch (e) { continue; }
    }
    return null;
  }

  function findSendBtn() {
    const sel = S.sendBtn;
    const selectors = sel.split(", ").map(s => s.trim());
    for (const s of selectors) {
      try {
        const el = document.querySelector(s);
        if (el && !el.closest("#zs-root")) return el;
      } catch (e) { continue; }
    }
    // Fallback: find any button containing an SVG (send icon) without :has()
    const buttons = document.querySelectorAll("button:not(#zs-root *)");
    for (const btn of buttons) {
      if (btn.closest("#zs-root")) continue;
      if (btn.querySelector("svg")) return btn;
    }
    return null;
  }

  const P = {
    name: () => "MiMo",
    timings,

    init(opts) {
      if (opts && opts.diag) diag = opts.diag;
      diag("mimo_init", {});
    },

    snapshot() {
      const items = allItems();
      const key = items.length ? `${items.length}:${itemText(items[0]).slice(0, 40)}` : "empty";
      return { items: items.length, key };
    },

    isGenerating() {
      if (document.querySelector(S.generating)) return true;
      const stopBtn = document.querySelector(S.stopBtn);
      if (stopBtn && stopBtn.offsetParent !== null) return true;
      return false;
    },

    async stop() {
      const btn = document.querySelector(S.stopBtn);
      if (btn) btn.click();
    },

    async typeAndSend(text) {
      const editor = findEditor();
      if (!editor) throw new Error("Could not find MiMo input field");
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(100);
      const sendBtn = findSendBtn();
      if (sendBtn) {
        sendBtn.click();
      } else {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
      diag("mimo_send", { textLen: text.length });
    },

    async waitForReply() {
      const startCount = assistantCount();
      const timeout = timings.RESPONSE_TIMEOUT_MS;
      const start = Date.now();
      return new Promise((resolve) => {
        const check = () => {
          const currentCount = assistantCount();
          if (currentCount > startCount) {
            const items = assistantItems();
            const last = items[items.length - 1];
            if (last) { waitForGenFinish(last).then((text) => resolve(text)); return; }
          }
          if (Date.now() - start > timeout) { resolve("(No response from MiMo within timeout)"); return; }
          setTimeout(check, 500);
        };
        check();
      });
    },
  };

  async function waitForGenFinish(item) {
    const maxWait = timings.RESPONSE_TIMEOUT_MS;
    const start = Date.now();
    let lastLen = 0, stableCount = 0;
    while (Date.now() - start < maxWait) {
      const currentText = itemText(item);
      if (currentText.length === lastLen && !P.isGenerating()) {
        stableCount++;
        if (stableCount >= 3) return currentText;
      } else { stableCount = 0; }
      lastLen = currentText.length;
      await sleep(timings.GEN_IDLE_MS / 2);
    }
    return itemText(item);
  }

  return P;
})();
