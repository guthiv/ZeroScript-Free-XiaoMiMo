// SPDX-License-Identifier: GPL-3.0-or-later
// providers/mimo.js - the MiMo (aistudio.xiaomimimo.com) provider.
// Exports the same ZSProvider interface as providers/deepseek.js; the core
// (core/main.js) is provider-agnostic. To enable MiMo support, add the URL
// pattern to manifest.json (content_scripts + host_permissions) and to
// background.js PROVIDER_URLS.
//
// MiMo DOM notes (based on observed UI):
//  - The chat page uses a standard textarea for input; the send button is
//    a primary button (likely with an icon or aria-label).
//  - Messages are wrapped in containers; user messages are right-aligned,
//    assistant messages are left-aligned (typical chat UI).
//  - The message list is a scrollable container; each turn is a div with
//    a text body (plain text or markdown).
//  - While generating, the send button is replaced by a stop button (or
//    the send button changes its aria-label).
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  // DOM selectors for aistudio.xiaomimimo.com. These are best guesses;
  // adjust if the site's class names change.
  const S = {
    chatList: "[class*='message-list'], [class*='chat-list'], .chat-messages, .messages",
    chatItem: "[class*='message'], [class*='turn'], .chat-message",
    userClass: "user", // class or attribute indicating a user message; fallback to alignment
    assistantClass: "assistant", // class or attribute indicating an assistant message
    userAlign: "justify-end", // Tailwind class for right-aligned (user)
    assistantAlign: "justify-start", // Tailwind class for left-aligned (assistant)
    box: ".prose, .markdown, .message-body, .text-content", // main text container
    editor: "textarea", // composer input
    sendBtn: "button[type='submit'], button[aria-label*='send' i], button[aria-label*='envoyer' i], .send-button",
    stopBtn: "button[aria-label*='stop' i], button[aria-label*='arrêter' i], .stop-button",
    errorSurfaces: '[role="alert"], [class*="error"], [class*="alert"], [class*="toast"]',
    generating: ".generating, .loading, .streaming", // spinner or indicator
    thinking: ".thinking, .reasoning", // if MiMo has a reasoning panel
    attachArea: "[class*='file-list'], [class*='upload']", // if images are supported
    imageThumb: "[class*='thumbnail'], [class*='file-item']",
  };

  // Error / state regexes (English + French - MiMo may follow the locale).
  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|dépassé)",
        "session.{0,20}(expired|expirée)",
        "please.{0,30}(start|créer).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "message.{0,20}too.{0,10}long",
        "maximum.{0,20}context",
        "this conversation has reached",
        "cette conversation a atteint",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /server is busy|serveur est occup|please try again|réessayer plus tard|system is currently busy/i,
    continueBtn: /^(continue|continuer|继续(生成)?|fortfahren|continuar|seguir|続行)$/i,
    stopped: /(arrêté|arrété|stopped|已停止|停止生成|已暂停)/i,
  };

  // Completion-detection windows. MiMo likely uses standard streaming.
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000, // if MiMo has reasoning
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ───────────────────────────────────────────────────
  function getChatItems() {
    const list = document.querySelector(S.chatList) || document;
    return [...list.querySelectorAll(S.chatItem)];
  }

  function isUserItem(item) {
    if (!item) return false;
    // Check by class or alignment
    if (item.classList.contains(S.userClass)) return true;
    if (S.userAlign && item.classList.contains(S.userAlign)) return true;
    // Check for bubble alignment (common in Tailwind)
    if (item.querySelector(".justify-end")) return true;
    return false;
  }

  const isAssistantItem = (item) => !!item && !isUserItem(item);

  function itemText(item) {
    const box = item.querySelector(S.box);
    return box ? box.textContent : (item.textContent || "");
  }

  function classifyText(item, excludeSel) {
    const box = item.querySelector(S.box);
    if (box) {
      if (excludeSel && box.closest(excludeSel)) return "";
      return box.textContent;
    }
    let t = "";
    for (const n of item.childNodes) {
      if (excludeSel && n.nodeType === 1 && n.matches && n.matches(excludeSel)) continue;
      t += n.textContent || "";
    }
    return t;
  }

  // ── DOM primitives ────────────────────────────────────────────────────────
  function allItems() {
    // Try to get the message list container; fallback to querying globally.
    const list = document.querySelector(S.chatList);
    if (list) {
      return [...list.querySelectorAll(S.chatItem)];
    }
    // Fallback: any element with message class
    return [...document.querySelectorAll(S.chatItem)];
  }

  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  function getEditor() {
    // The composer textarea; avoid ZeroScript's own UI.
    const textareas = [...document.querySelectorAll(S.editor)];
    for (const ta of textareas) {
      // Skip if inside ZeroScript's own UI
      if (ta.closest("#zs-root")) continue;
      // Skip hidden or disabled textareas (like recaptcha)
      if (ta.offsetParent === null || ta.disabled) continue;
      // If the textarea is not in the main chat area, skip
      if (!ta.closest("form") && !ta.closest(".composer")) continue;
      return ta;
    }
    return null;
  }

  function getSendButton() {
    // Primary send button; try by aria-label first.
    const btns = [...document.querySelectorAll(S.sendBtn)];
    for (const btn of btns) {
      if (btn.offsetParent === null) continue;
      // Sometimes the send button is the only primary button in the composer
      if (btn.closest("form") || btn.closest(".composer")) return btn;
    }
    // Fallback: any button inside the composer with type submit
    const form = document.querySelector("form");
    if (form) {
      const submit = form.querySelector("button[type='submit']");
      if (submit) return submit;
    }
    return null;
  }

  function getStopButton() {
    // The stop button appears during generation; often same element as send
    // but with a different aria-label or icon.
    const btns = [...document.querySelectorAll(S.stopBtn)];
    for (const btn of btns) {
      if (btn.offsetParent === null) continue;
      if (btn.closest("form") || btn.closest(".composer")) return btn;
    }
    // Fallback: primary button with "stop" in aria-label
    const all = document.querySelectorAll("button");
    for (const btn of all) {
      const label = btn.getAttribute("aria-label") || "";
      if (/stop|arrêter/i.test(label) && btn.offsetParent !== null) {
        return btn;
      }
    }
    return null;
  }

  function isGenerating() {
    // Check for stop button presence or a loading spinner
    const stop = getStopButton();
    if (stop) return true;
    // Also check for any generating indicator
    const indicators = document.querySelectorAll(S.generating);
    for (const el of indicators) {
      if (el.offsetParent !== null) return true;
    }
    return false;
  }

  function stopGeneration() {
    const stopBtn = getStopButton();
    if (stopBtn) {
      stopBtn.click();
      return true;
    }
    return false;
  }

  // ── Sending a message ────────────────────────────────────────────────────
  async function typeAndSend(text, images = []) {
    const editor = getEditor();
    if (!editor) {
      diag("MiMo: no editor found");
      return false;
    }

    // Set text
    editor.value = text;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));

    // If images are supported, try to attach them (placeholder)
    if (images && images.length > 0) {
      // Many sites don't support image attachment; we'll skip for now.
      // If MiMo supports it, we can implement later.
      diag("MiMo: image attachment not implemented");
    }

    // Click send button
    const sendBtn = getSendButton();
    if (!sendBtn) {
      diag("MiMo: no send button found");
      return false;
    }
    sendBtn.click();

    return true;
  }

  function getLastAssistantMessage() {
    const items = assistantItems();
    if (items.length === 0) return null;
    const last = items[items.length - 1];
    const text = itemText(last);
    return text || null;
  }

  // ── Error detection ──────────────────────────────────────────────────────
  function hasError() {
    const surfaces = document.querySelectorAll(S.errorSurfaces);
    for (const el of surfaces) {
      if (el.offsetParent !== null) {
        const txt = el.textContent || "";
        if (txt.length > 0) return txt;
      }
    }
    return null;
  }

  // ── Initialisation ──────────────────────────────────────────────────────
  function init(diagFn) {
    if (diagFn) diag = diagFn;
    diag("MiMo provider initialised");
  }

  // ── Export ───────────────────────────────────────────────────────────────
  return {
    init,
    allItems,
    assistantItems,
    assistantCount,
    userCount,
    isUserItem,
    isAssistantItem,
    itemText,
    classifyText,
    getEditor,
    getSendButton,
    getStopButton,
    isGenerating,
    stopGeneration,
    typeAndSend,
    getLastAssistantMessage,
    hasError,
    timings,
    RE,
    // For debugging
    S,
  };
})();
