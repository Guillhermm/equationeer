import { streamExplanation, streamImageExplanation, validateApiKey } from "../utils/api";
import { getSettings, saveSettings } from "../utils/storage";
import {
  buildExplanationPrompt,
  buildFollowUpPrompt,
  buildImageExplanationPrompt,
} from "../utils/promptBuilder";
import type { StreamMessage } from "../types/messages";

const log = (...a: unknown[]) => console.log("[EQ:SW]", ...a);
const err = (...a: unknown[]) => console.error("[EQ:SW]", ...a);

const MODEL_MAX_TOKENS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 8096,
  "claude-sonnet-4-6": 8096,
  "claude-opus-4-7": 16000,
};

function resolveMaxTokens(model: string, maxTokens: number): number {
  return maxTokens === 0 ? (MODEL_MAX_TOKENS[model] ?? 8096) : maxTokens;
}

// ── Rate limiting ────────────────────────────────────────────────────────────

let timestamps: number[] = [];
let lastRequest = 0;

function rateLimitCheck(): string | null {
  const now = Date.now();
  if (now - lastRequest < 500) return "Too fast — wait a moment before requesting again.";
  lastRequest = now;
  timestamps = timestamps.filter((t) => now - t < 60_000);
  if (timestamps.length >= 30) return "Rate limit: 30 requests per minute. Please wait.";
  timestamps.push(now);
  return null;
}

// ── Broadcast helpers ────────────────────────────────────────────────────────

function broadcast(msg: StreamMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Side panel may not be open — that's fine
  });
}

function broadcastError(message: string): void {
  broadcast({ type: "STREAM_ERROR", error: message });
}

// ── Extension lifecycle ──────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.runtime.onInstalled.addListener((details) => {
  log("Installed:", details.reason);
  chrome.contextMenus.create(
    { id: "equationeer-explain", title: "Explain with Equationeer", contexts: ["selection"] },
    () => { if (chrome.runtime.lastError) err("Context menu:", chrome.runtime.lastError.message); },
  );
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

// ── Context menu ─────────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "equationeer-explain" || !tab?.id || !info.selectionText) return;
  // sidePanel.open MUST be called synchronously in the user gesture context;
  // any await before it expires the gesture and silently fails.
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => err("sidePanel.open:", e));

  const tabId = tab.id;
  const pending = {
    kind: "math" as const,
    math: info.selectionText,
    surroundingText: info.selectionText,
    pageTitle: tab.title ?? "",
    pageUrl: tab.url ?? "",
  };

  // Async: extract relevant page text and attach to the pending explanation.
  // The panel's onChanged listener handles the pending even if it mounts first.
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try {
        if (document.contentType === "application/pdf" ||
            window.location.href.toLowerCase().endsWith(".pdf")) return "";
        const el = document.querySelector<HTMLElement>(
          "article, main, [role=main], .paper-body, .article-body, .ltx_document, #content, .content"
        );
        return ((el ?? document.body).innerText ?? "").slice(0, 8000);
      } catch { return ""; }
    },
  }).then((results) => {
    const documentText = (results?.[0]?.result as string) || undefined;
    chrome.storage.session.set({ equationeerPending: { ...pending, documentText } })
      .catch((e) => err("storage.session.set:", e));
  }).catch(() => {
    // Fallback: queue without document text
    chrome.storage.session.set({ equationeerPending: pending })
      .catch((e) => err("storage.session.set:", e));
  });
});

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    log("Message:", message?.type);
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((e) => {
        err("Handler threw:", e);
        sendResponse({ error: String(e) });
      });
    return true;
  },
);

async function handleMessage(
  message: { type: string; payload?: unknown },
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message?.type) {

    case "CAPTURE_TAB": {
      if (!sender.tab?.windowId) return { error: "No window" };
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(
          sender.tab.windowId, { format: "png" },
        );
        return { dataUrl };
      } catch (e) {
        err("captureVisibleTab:", e);
        return { error: String(e) };
      }
    }

    case "OPEN_SIDE_PANEL": {
      const tabId = sender.tab?.id;
      if (!tabId) return { error: "No tabId" };
      try { await chrome.sidePanel.open({ tabId }); }
      catch (e) { err("sidePanel.open:", e); return { error: String(e) }; }
      return { success: true };
    }

    case "QUEUE_PENDING": {
      await chrome.storage.session.set({ equationeerPending: message.payload });
      log("Queued pending explanation");
      return { success: true };
    }

    case "GET_SETTINGS":
      return await getSettings();

    case "SAVE_SETTINGS":
      return await saveSettings(message.payload as Partial<Record<string, unknown>>);

    case "VALIDATE_API_KEY":
      return { valid: await validateApiKey((message.payload as { apiKey: string }).apiKey) };

    case "EXPLAIN_MATH":
      return await handleExplainMath(message.payload as {
        math: string; surroundingText: string; documentText?: string;
        pageTitle: string; pageUrl: string; depth: string;
      });

    case "EXPLAIN_IMAGE":
      return await handleExplainImage(message.payload as {
        imageDataUrl: string; pageTitle: string; pageUrl: string; depth: string;
      });

    case "FOLLOW_UP":
      return await handleFollowUp(message.payload as {
        question: string; conversationHistory: { role: string; content: string }[];
        originalMath: string; depth: string;
      });

    default:
      log("Unknown message type:", message?.type);
      return { error: "Unknown message type" };
  }
}

// ── API call handlers ────────────────────────────────────────────────────────

async function handleExplainMath(payload: {
  math: string; surroundingText: string; documentText?: string;
  pageTitle: string; pageUrl: string; depth: string;
}): Promise<unknown> {
  const limitErr = rateLimitCheck();
  if (limitErr) { broadcastError(limitErr); return { error: limitErr }; }

  const settings = await getSettings();
  if (!settings.apiKey) {
    const msg = "No API key set. Open the Settings page to add your Anthropic key.";
    broadcastError(msg);
    return { error: msg };
  }

  const systemPrompt = buildExplanationPrompt({
    math: payload.math,
    surroundingText: payload.surroundingText,
    documentText: payload.documentText,
    pageTitle: payload.pageTitle,
    pageUrl: payload.pageUrl,
    depth: payload.depth as "grad" | "undergrad" | "curious",
    language: settings.language,
  });

  const maxTokens = resolveMaxTokens(settings.model, settings.maxTokens);
  log("Starting Claude stream for math, model:", settings.model, "maxTokens:", maxTokens);
  streamExplanation(
    settings.apiKey,
    systemPrompt,
    [{ role: "user", content: payload.math }],
    broadcast,
    { model: settings.model, maxTokens },
  ).catch((e) => { err(e); broadcastError(String(e)); });

  return { streaming: true };
}

async function handleExplainImage(payload: {
  imageDataUrl: string; pageTitle: string; pageUrl: string; depth: string;
}): Promise<unknown> {
  const limitErr = rateLimitCheck();
  if (limitErr) { broadcastError(limitErr); return { error: limitErr }; }

  const settings = await getSettings();
  if (!settings.apiKey) {
    const msg = "No API key set.";
    broadcastError(msg);
    return { error: msg };
  }

  const systemPrompt = buildImageExplanationPrompt({
    pageTitle: payload.pageTitle,
    pageUrl: payload.pageUrl,
    depth: payload.depth as "grad" | "undergrad" | "curious",
    language: settings.language,
  });

  const maxTokensImg = resolveMaxTokens(settings.model, settings.maxTokens);
  log("Starting Claude stream for image, model:", settings.model, "maxTokens:", maxTokensImg);
  streamImageExplanation(
    settings.apiKey,
    systemPrompt,
    payload.imageDataUrl,
    broadcast,
    { model: settings.model, maxTokens: maxTokensImg },
  ).catch((e) => { err(e); broadcastError(String(e)); });

  return { streaming: true };
}

async function handleFollowUp(payload: {
  question: string; conversationHistory: { role: string; content: string }[];
  originalMath: string; depth: string;
}): Promise<unknown> {
  const limitErr = rateLimitCheck();
  if (limitErr) { broadcastError(limitErr); return { error: limitErr }; }

  const settings = await getSettings();
  if (!settings.apiKey) {
    const msg = "No API key set.";
    broadcastError(msg);
    return { error: msg };
  }

  const systemPrompt = buildFollowUpPrompt({
    originalMath: payload.originalMath,
    depth: payload.depth as "grad" | "undergrad" | "curious",
    language: settings.language,
  });

  const messages = [
    ...payload.conversationHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: payload.question },
  ];

  const maxTokensFu = resolveMaxTokens(settings.model, settings.maxTokens);
  log("Starting Claude stream for follow-up, model:", settings.model, "maxTokens:", maxTokensFu);
  streamExplanation(
    settings.apiKey,
    systemPrompt,
    messages,
    broadcast,
    { model: settings.model, maxTokens: maxTokensFu },
  ).catch((e) => { err(e); broadcastError(String(e)); });

  return { streaming: true };
}
