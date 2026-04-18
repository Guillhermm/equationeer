import { isMathContent, getSurroundingText } from "../utils/mathDetector";
import type { ExplainMathRequest } from "../types/messages";

let tooltipEl: HTMLDivElement | null = null;
let screenshotOverlay: HTMLDivElement | null = null;

// --- Tooltip ---

function showTooltip(x: number, y: number) {
  removeTooltip();

  tooltipEl = document.createElement("div");
  tooltipEl.id = "equationeer-tooltip";
  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top = `${y - 40}px`;

  const btn = document.createElement("button");
  btn.setAttribute("aria-label", "Explain equation with Equationeer");
  btn.innerHTML = `<span class="eq-sigma">\u03A3</span> Explain`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    triggerExplain();
  });

  tooltipEl.appendChild(btn);
  document.body.appendChild(tooltipEl);
}

function removeTooltip() {
  if (tooltipEl) {
    tooltipEl.remove();
    tooltipEl = null;
  }
}

function triggerExplain() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;

  const text = selection.toString().trim();
  if (!text) return;

  const surroundingText = getSurroundingText(selection);

  const message: ExplainMathRequest = {
    type: "EXPLAIN_MATH",
    payload: {
      math: text,
      surroundingText,
      pageTitle: document.title,
      pageUrl: window.location.href,
      depth: "undergrad", // default, side panel can change it
    },
  };

  // Open side panel and send explanation request
  chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });

  // Small delay to let panel initialize
  setTimeout(() => {
    chrome.runtime.sendMessage(message);
  }, 300);

  removeTooltip();
}

// --- Selection listener ---

document.addEventListener("mouseup", (e) => {
  // Ignore clicks on our own UI
  if ((e.target as HTMLElement)?.closest?.("#equationeer-tooltip")) return;

  setTimeout(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      removeTooltip();
      return;
    }

    const text = selection.toString().trim();
    if (!text || text.length < 2) {
      removeTooltip();
      return;
    }

    // Always show tooltip — let users explain any text they think is math
    // The math detector is used as a hint but we don't block non-math selections
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
  if (!(e.target as HTMLElement)?.closest?.("#equationeer-tooltip")) {
    removeTooltip();
  }
});

// --- Screenshot/clip mode ---

function activateScreenshotMode() {
  if (screenshotOverlay) return;

  screenshotOverlay = document.createElement("div");
  screenshotOverlay.id = "equationeer-screenshot-overlay";

  const hint = document.createElement("div");
  hint.id = "equationeer-screenshot-hint";
  hint.textContent = "Draw a rectangle over the equation to explain. Press Esc to cancel.";

  document.body.appendChild(screenshotOverlay);
  document.body.appendChild(hint);

  let startX = 0;
  let startY = 0;
  let selectionBox: HTMLDivElement | null = null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") cleanup();
  };

  const onMouseDown = (e: MouseEvent) => {
    startX = e.clientX;
    startY = e.clientY;

    selectionBox = document.createElement("div");
    selectionBox.id = "equationeer-screenshot-selection";
    selectionBox.style.left = `${startX}px`;
    selectionBox.style.top = `${startY}px`;
    selectionBox.style.width = "0px";
    selectionBox.style.height = "0px";
    document.body.appendChild(selectionBox);
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!selectionBox) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    selectionBox.style.left = `${x}px`;
    selectionBox.style.top = `${y}px`;
    selectionBox.style.width = `${w}px`;
    selectionBox.style.height = `${h}px`;
  };

  const onMouseUp = (e: MouseEvent) => {
    if (!selectionBox) return;

    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);

    if (w < 10 || h < 10) {
      cleanup();
      return;
    }

    // Capture the visible tab, then crop
    cleanup();
    captureAndCrop(x, y, w, h);
  };

  screenshotOverlay.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", onKeyDown);

  function cleanup() {
    screenshotOverlay?.remove();
    screenshotOverlay = null;
    selectionBox?.remove();
    selectionBox = null;
    hint.remove();
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("keydown", onKeyDown);
  }
}

function captureAndCrop(x: number, y: number, w: number, h: number) {
  // Ask background to capture the tab
  chrome.runtime.sendMessage(
    { type: "CAPTURE_TAB" },
    (response: { dataUrl?: string }) => {
      if (!response?.dataUrl) return;

      const img = new Image();
      img.onload = () => {
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement("canvas");
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.drawImage(
          img,
          x * dpr,
          y * dpr,
          w * dpr,
          h * dpr,
          0,
          0,
          w * dpr,
          h * dpr,
        );

        const croppedDataUrl = canvas.toDataURL("image/png");

        chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" });
        setTimeout(() => {
          chrome.runtime.sendMessage({
            type: "EXPLAIN_IMAGE",
            payload: {
              imageDataUrl: croppedDataUrl,
              pageTitle: document.title,
              pageUrl: window.location.href,
              depth: "undergrad",
            },
          });
        }, 300);
      };
      img.src = response.dataUrl;
    },
  );
}

// --- Listen for messages from background ---

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TRIGGER_EXPLAIN") {
    triggerExplain();
  }
  if (message.type === "ACTIVATE_SCREENSHOT") {
    activateScreenshotMode();
  }
});
