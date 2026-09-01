import { isMathContent, getSurroundingText } from "../utils/mathDetector";
import { getScopeSettings } from "../utils/settings";
import {
  detectPdf,
  isExtensionActive,
  isOpaquePdfViewer,
  isTooltipActive,
  normalizeHost,
  type PageContext,
  type ScopeSettings,
} from "../utils/siteScope";

let tooltipEl: HTMLDivElement | null = null;
let launcherEl: HTMLDivElement | null = null;
let screenshotOverlay: HTMLDivElement | null = null;
let cancelScreenshot: (() => void) | null = null;

// Scope state: nothing below attaches until applyScope says so.
let extensionActive = false;
let tooltipActive = false;

// ── Tooltip ───────────────────────────────────────────────────────────────────

function showTooltip(x: number, y: number) {
  removeTooltip();
  tooltipEl = document.createElement("div");
  tooltipEl.id = "equationeer-tooltip";
  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top = `${y - 40}px`;

  const btn = document.createElement("button");
  btn.setAttribute("aria-label", "Explain equation with Equationeer");
  btn.innerHTML = `<span class="eq-sigma">\u03A3</span> Explain`;
  btn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); triggerExplain(); });

  tooltipEl.appendChild(btn);
  document.body.appendChild(tooltipEl);
}

function removeTooltip() {
  tooltipEl?.remove();
  tooltipEl = null;
}

// ── PDF launcher ──────────────────────────────────────────────────────────────

/**
 * Chrome's PDF viewer never lets the pill see a selection, so PDFs get a
 * standing button instead. It starts Screenshot Mode, which works over the
 * viewer because the overlay lives in the top-level document.
 */
function showPdfLauncher() {
  if (launcherEl) return;
  launcherEl = document.createElement("div");
  launcherEl.id = "equationeer-pdf-launcher";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Explain an equation in this PDF with Equationeer");
  btn.title = "Draw a box over an equation. To explain text, right-click your selection.";
  btn.innerHTML = `<span class="eq-sigma">\u03A3</span> Explain`;
  btn.addEventListener("click", (e) => { e.preventDefault(); activateScreenshotMode(); });

  launcherEl.appendChild(btn);
  document.body.appendChild(launcherEl);
}

function removePdfLauncher() {
  launcherEl?.remove();
  launcherEl = null;
}

/** Hidden during a capture so the button itself is not in the screenshot. */
function setLauncherHidden(hidden: boolean) {
  if (launcherEl) launcherEl.style.display = hidden ? "none" : "";
}

function getDocumentText(): string {
  // Skip for PDFs — Chrome PDF viewer content is inaccessible from content scripts
  if (
    document.contentType === "application/pdf" ||
    window.location.href.toLowerCase().endsWith(".pdf")
  ) return "";
  try {
    // Prefer semantic content containers over the full body — they exclude nav,
    // headers, footers, and ads which waste context window space.
    const contentEl = document.querySelector<HTMLElement>(
      "article, main, [role=main], .paper-body, .article-body, .ltx_document, #content, .content"
    );
    const source = contentEl ?? document.body;
    return (source.innerText ?? "").slice(0, 8000);
  } catch {
    return "";
  }
}

function triggerExplain() {
  if (!extensionActive) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const text = selection.toString().trim();
  if (!text) return;

  const surroundingText = getSurroundingText(selection);
  const documentText = getDocumentText();

  // Step 1: queue the pending explanation in session storage
  chrome.runtime.sendMessage({
    type: "QUEUE_PENDING",
    payload: {
      kind: "math",
      math: text,
      surroundingText,
      documentText,
      pageTitle: document.title,
      pageUrl: window.location.href,
    },
  }, () => {
    // Step 2: open the side panel only AFTER the pending data is saved
    chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });
  });

  removeTooltip();
}

// ── Selection listener ────────────────────────────────────────────────────────

const onMouseUp = (e: MouseEvent) => {
  if ((e.target as HTMLElement)?.closest?.("#equationeer-tooltip")) return;

  setTimeout(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) { removeTooltip(); return; }

    const text = selection.toString().trim();
    if (!text || text.length < 2) { removeTooltip(); return; }

    if (isMathContent(text) || text.length >= 3) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const x = rect.left + rect.width / 2 - 40 + window.scrollX;
      const y = rect.top + window.scrollY;
      showTooltip(x, y);
    }
  }, 10);
};

const onMouseDownOutside = (e: MouseEvent) => {
  if (!(e.target as HTMLElement)?.closest?.("#equationeer-tooltip")) removeTooltip();
};

let selectionListenersAttached = false;

function setSelectionListeners(enabled: boolean): void {
  if (enabled === selectionListenersAttached) return;
  if (enabled) {
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousedown", onMouseDownOutside);
  } else {
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("mousedown", onMouseDownOutside);
    removeTooltip();
  }
  selectionListenersAttached = enabled;
}

// ── Screenshot / clip mode ────────────────────────────────────────────────────

function activateScreenshotMode() {
  if (!extensionActive || screenshotOverlay) return;

  screenshotOverlay = document.createElement("div");
  screenshotOverlay.id = "equationeer-screenshot-overlay";
  // Must be focusable so keyboard events (Esc) reach it even when a PDF
  // viewer iframe or embed is holding focus.
  screenshotOverlay.tabIndex = -1;

  const hint = document.createElement("div");
  hint.id = "equationeer-screenshot-hint";
  hint.textContent = "Draw a rectangle over the equation. Press Esc to cancel.";

  document.body.appendChild(screenshotOverlay);
  document.body.appendChild(hint);
  screenshotOverlay.focus();

  let startX = 0, startY = 0;
  let selectionBox: HTMLDivElement | null = null;

  setLauncherHidden(true);

  const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") cleanup(); };
  const onMouseDown = (e: MouseEvent) => {
    startX = e.clientX; startY = e.clientY;
    selectionBox = document.createElement("div");
    selectionBox.id = "equationeer-screenshot-selection";
    Object.assign(selectionBox.style, { left: `${startX}px`, top: `${startY}px`, width: "0px", height: "0px" });
    document.body.appendChild(selectionBox);
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!selectionBox) return;
    const x = Math.min(e.clientX, startX), y = Math.min(e.clientY, startY);
    Object.assign(selectionBox.style, {
      left: `${x}px`, top: `${y}px`,
      width: `${Math.abs(e.clientX - startX)}px`, height: `${Math.abs(e.clientY - startY)}px`,
    });
  };
  const onMouseUp = (e: MouseEvent) => {
    if (!selectionBox) return;
    const x = Math.min(e.clientX, startX), y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX), h = Math.abs(e.clientY - startY);
    if (w < 10 || h < 10) { cleanup(); return; }
    // Keep the launcher hidden past cleanup: it would otherwise be captured.
    cleanup({ restoreLauncher: false });
    // Double rAF so the overlay is fully repainted away before capture
    requestAnimationFrame(() => requestAnimationFrame(() => captureAndCrop(x, y, w, h)));
  };

  cancelScreenshot = cleanup;
  screenshotOverlay.addEventListener("mousedown", onMouseDown);
  screenshotOverlay.addEventListener("keydown", onKeyDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", onKeyDown);

  function cleanup({ restoreLauncher = true }: { restoreLauncher?: boolean } = {}) {
    cancelScreenshot = null;
    if (restoreLauncher) setLauncherHidden(false);
    screenshotOverlay?.remove(); screenshotOverlay = null;
    selectionBox?.remove(); selectionBox = null;
    hint.remove();
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("keydown", onKeyDown);
  }
}

function captureAndCrop(x: number, y: number, w: number, h: number) {
  chrome.runtime.sendMessage({ type: "CAPTURE_TAB" }, (response: { dataUrl?: string }) => {
    setLauncherHidden(false);
    if (!response?.dataUrl) return;

    const img = new Image();
    img.onload = () => {
      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.width = w * dpr; canvas.height = h * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, x * dpr, y * dpr, w * dpr, h * dpr, 0, 0, w * dpr, h * dpr);

      const imageDataUrl = canvas.toDataURL("image/png");

      chrome.runtime.sendMessage({
        type: "QUEUE_PENDING",
        payload: {
          kind: "image",
          imageDataUrl,
          pageTitle: document.title,
          pageUrl: window.location.href,
        },
      }, () => {
        chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });
      });
    };
    img.src = response.dataUrl;
  });
}

// ── Background messages ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TRIGGER_EXPLAIN") triggerExplain();
  if (message.type === "ACTIVATE_SCREENSHOT") activateScreenshotMode();
  if (message.type === "GET_SCOPE") {
    const ctx = pageContext();
    sendResponse({
      active: extensionActive,
      tooltip: tooltipActive,
      isPdf: ctx.isPdf,
      hostname: ctx.hostname,
      opaqueViewer: ctx.opaqueViewer,
    });
  }
  return true;
});

// ── Scope ─────────────────────────────────────────────────────────────────────

function pageContext(): PageContext {
  return {
    isPdf: detectPdf(document, window.location.href),
    hostname: normalizeHost(window.location.href),
    opaqueViewer: isOpaquePdfViewer(document),
  };
}

/**
 * Decide whether this page gets Equationeer at all, and whether it gets the
 * hover pill. Called on load, again once the document settles (a PDF.js viewer
 * may not have rendered yet), and whenever the settings change, so flipping a
 * setting takes effect without reloading the tab.
 */
function applyScope(settings: ScopeSettings): void {
  const ctx = pageContext();
  const wasActive = extensionActive;

  extensionActive = isExtensionActive(settings, ctx);
  tooltipActive = isTooltipActive(settings, ctx);

  // On Chrome's PDF viewer the pill can never fire, so use the launcher there.
  const opaquePdf = ctx.opaqueViewer === true;
  setSelectionListeners(tooltipActive && !opaquePdf);
  if (tooltipActive && opaquePdf) showPdfLauncher();
  else removePdfLauncher();

  if (!extensionActive) cancelScreenshot?.();

  if (extensionActive !== wasActive || document.readyState !== "complete") {
    chrome.runtime.sendMessage({ type: "SCOPE_STATUS", payload: { active: extensionActive } })
      .catch(() => { /* service worker asleep; it will ask again on activation */ });
  }
}

function refreshScope(): void {
  getScopeSettings().then(applyScope).catch(() => { /* storage unavailable */ });
}

refreshScope();
window.addEventListener("load", refreshScope, { once: true });
// A PDF.js viewer can mount after the page is otherwise idle; check once more.
setTimeout(refreshScope, 1500);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("siteActivation" in changes || "tooltipScope" in changes || "siteAllowlist" in changes) {
    refreshScope();
  }
});
