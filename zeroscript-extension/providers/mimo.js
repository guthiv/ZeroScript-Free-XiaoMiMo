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
    chatItem: ".chat-message, .message-item, [class*='message']",
    userMod: "user", // class part for user messages
    assistantMod: "assistant", // class part for assistant messages
    box: ".markdown, [class*='markdown'], .message-content",
    editor: "textarea", // MiMo uses a real <textarea>
    thinking: ".thinking, .reasoning, [class*='think']",
    markdown: ".markdown, [class*='markdown']",
    generating: ".loading, .streaming, [class*='generating']",
    sendBtn: "button[type='submit'], .send-button, [class*='send']",
    stopBtn: "button[class*='stop'], [class*='stop']",
    // surfaces where MiMo shows errors / limit modals / toasts
    errorSurfaces:
      '[class*="toast"],[class*="error"],[class*="alert"],' +
      '[class*="warning"],[class*="modal"],[role="alert"]',
    attachArea: "[class*='file-list'], [class*='upload']",
    imageThumb: "[class*='thumbnail'], [class*='file-item']",
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
    deepThink: /deep ?think|深度思考|r1|reasoning/i,
    searchMode: /search|web|搜索/i,
  };

  // Completion-detection windows, calibrated for MiMo's typical response speed.
  const timings = {
    GEN_IDLE_MS: 800,        // answer phase: text unchanged this long ⇒ idle
    REASON_IDLE_MS: 10000,   // reasoning stalls
    WARMUP_MS: 30000,        // empty turn container may precede the first token
    REASON_NOREPLY_MS: 60000, // reasoning written but no answer yet: keep waiting
    STABLE_MS: 8000,         // generating-flag stuck ON but text frozen → done
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ──────────────────────────────────────────────────
  function isUserItem(item) {
    if (!item) return false;
    // Check for user class or user bubble
    if (item.classList.contains(S.userMod)) return true;
    if (item.querySelector('[class*="user"]')) return true;
    return false;
  }
  const isAssistantItem = (item) => !!item && !isUserItem(item);

  // Text of an item for signature detection. For assistant turns we use ONLY
  // the non-thinking markdown.
  function itemText(item) {
    if (isAssistantItem(item)) {
      const mds = [...item.querySelectorAll(S.markdown)].filter((m) => !m.closest(S.thinking));
      return mds.map((m) => m.textContent).join("\n");
    }
    return item.textContent || "";
  }

  // Text used by the core to CLASSIFY a turn for camouflage - excludes the
  // reasoning area AND any element matching `excludeSel`.
  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      return [...item.querySelectorAll(S.markdown)]
        .filter((m) => !m.closest(S.thinking) && !(excludeSel && m.closest(excludeSel)))
        .map((m) => m.textContent).join("\n");
    }
    let t = "";
    for (const n of item.childNodes) {
      if (excludeSel && n.nodeType === 1 && n.matches && n.matches(excludeSel)) continue;
      t += n.textContent || "";
    }
    return t;
  }

  // ── DOM primitives ──────────────────────────────────────────────────────
  const allItems = () => [...document.querySelectorAll(S.chatItem)];
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;

  // Get the main textarea (composer). Scope to the site's composer only;
  // avoid matching ZeroScript's own injected UI.
  function getEditor() {
    const editors = document.querySelectorAll(S.editor);
    for (const e of editors) {
      // Skip any textarea that is inside our own injected UI (#zs-root)
      if (e.closest('#zs-root')) continue;
      // Also skip if it's not visible or disabled
      if (e.offsetParent === null && e.closest('[style*="display:none"]')) continue;
      return e;
    }
    return null;
  }

  // Get the primary send button (the one that triggers the message).
  function getSendBtn() {
    // Look for a button with type="submit" or class containing "send"
    const btns = document.querySelectorAll(S.sendBtn);
    for (const b of btns) {
      if (b.closest('#zs-root')) continue;
      // Prefer visible, enabled buttons
      if (b.offsetParent !== null && !b.disabled) return b;
    }
    // Fallback: any button inside the composer area
    const composer = document.querySelector('[class*="composer"], [class*="input-area"]');
    if (composer) {
      const btn = composer.querySelector('button:not([disabled])');
      if (btn) return btn;
    }
    return null;
  }

  // Determine if the primary button is in "stop" state (generating).
  function isStopBtn(btn) {
    if (!btn) return false;
    // Check for stop-related classes or text content
    if (btn.classList.contains('stop') || btn.classList.contains('stopping')) return true;
    const txt = btn.textContent.trim().toLowerCase();
    if (txt === 'stop' || txt === '■' || txt === '⏹' || txt.includes('stop')) return true;
    // Some sites use an SVG path; check for stop icon (square or rectangle)
    const svg = btn.querySelector('svg');
    if (svg) {
      const path = svg.querySelector('path');
      if (path) {
        const d = path.getAttribute('d') || '';
        // Stop icon often has a square path like "M2 2h20v20H2z"
        if (d.match(/M\s*\d+\s+\d+\s+h\s*\d+/i)) return true;
      }
    }
    return false;
  }

  // Check if the UI indicates the model is currently generating.
  function isGenerating() {
    // Look for a loading/generating class
    if (document.querySelector(S.generating)) return true;
    // Check the button state
    const btn = getSendBtn();
    if (btn && isStopBtn(btn)) return true;
    // Check for a spinner or thinking indicator
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

    // Focus and set value
    editor.focus();
    editor.value = text;
    // Dispatch input event to trigger any reactivity
    editor.dispatchEvent(new Event('input', { bubbles: true }));

    // Wait a tiny bit for the UI to update
    await sleep(100);

    // Find and click the send button
    const sendBtn = getSendBtn();
    if (sendBtn) {
      sendBtn.click();
      return true;
    }

    // Fallback: try pressing Enter (if the textarea triggers submit on Enter)
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
    return last.textContent || null;
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

    // Wait for the last assistant message to stabilize.
    let lastText = '';
    let stableStart = 0;
    let idleStart = 0;
    let generatingDetected = false;

    while (Date.now() - start < timeout) {
      // Check for errors
      if (checkForErrors()) {
        diag('[MiMo] Error detected, stopping wait');
        return null;
      }

      const items = assistantItems();
      if (items.length === 0) {
        // No assistant turn yet; wait a bit
        await sleep(200);
        continue;
      }

      const latest = items[items.length - 1];
      const text = itemText(latest);

      // If text is empty, it might be a placeholder; wait for content
      if (!text.trim()) {
        await sleep(200);
        continue;
      }

      // Check if we have a "Continue" button (model is waiting for user action)
      const contBtn = getContinueBtn();
      if (contBtn) {
        diag('[MiMo] Continue button detected, clicking it');
        contBtn.click();
        await sleep(500);
        continue;
      }

      // Check generating status
      const gen = isGenerating();
      if (gen) {
        generatingDetected = true;
        // Reset idle timer when we see generating activity
        idleStart = 0;
        // If text has changed, reset stable timer
        if (text !== lastText) {
          stableStart = 0;
          lastText = text;
        } else {
          // Text unchanged while generating: if it stays frozen too long, consider done
          if (stableStart === 0) stableStart = Date.now();
          if (Date.now() - stableStart > timings.STABLE_MS) {
            diag('[MiMo] Text frozen while generating, assuming done');
            return lastText;
          }
        }
      } else {
        // Not generating: if we have text, check if it's stable
        if (lastText && text === lastText) {
          if (idleStart === 0) idleStart = Date.now();
          if (Date.now() - idleStart > timings.GEN_IDLE_MS) {
            diag('[MiMo] Text stable, response complete');
            return lastText;
          }
        } else {
          // Text changed while not generating? maybe it's still streaming but the flag is missing
          idleStart = 0;
          lastText = text;
        }
      }

      // If we've waited a long time and have some text, return it
      if (lastText.trim() && Date.now() - start > 30000) {
        diag('[MiMo] Long wait with text, returning what we have');
        return lastText;
      }

      await sleep(500);
    }

    // Timeout: return what we have, if anything
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
    // Expose selectors and timings for debugging
    _S: S,
    _timings: timings,
  };
})();
