import { isMathContent, getSurroundingText } from "../utils/mathDetector";

let tooltipEl: HTMLDivElement | null = null;
let screenshotOverlay: HTMLDivElement | null = null;

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

function triggerExplain() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const text = selection.toString().trim();
  if (!text) return;

  const surroundingText = getSurroundingText(selection);

  // Step 1: queue the pending explanation in session storage
  chrome.runtime.sendMessage({
    type: "QUEUE_PENDING",
    payload: {
      kind: "math",
      math: text,
      surroundingText,
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

document.addEventListener("mouseup", (e) => {
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
});

document.addEventListener("mousedown", (e) => {
  if (!(e.target as HTMLElement)?.closest?.("#equationeer-tooltip")) removeTooltip();
});

// ── Screenshot / clip mode ────────────────────────────────────────────────────

function activateScreenshotMode() {
  if (screenshotOverlay) return;

  screenshotOverlay = document.createElement("div");
  screenshotOverlay.id = "equationeer-screenshot-overlay";

  const hint = document.createElement("div");
  hint.id = "equationeer-screenshot-hint";
  hint.textContent = "Draw a rectangle over the equation. Press Esc to cancel.";

  document.body.appendChild(screenshotOverlay);
  document.body.appendChild(hint);

  let startX = 0, startY = 0;
  let selectionBox: HTMLDivElement | null = null;

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
    cleanup();
    // Double rAF so the overlay is fully repainted away before capture
    requestAnimationFrame(() => requestAnimationFrame(() => captureAndCrop(x, y, w, h)));
  };

  screenshotOverlay.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", onKeyDown);

  function cleanup() {
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

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TRIGGER_EXPLAIN") triggerExplain();
  if (message.type === "ACTIVATE_SCREENSHOT") activateScreenshotMode();
});
