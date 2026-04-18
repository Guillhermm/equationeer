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
  chrome.storage.session.set({
    equationeerPending: {
      kind: "math",
      math: info.selectionText,
      surroundingText: info.selectionText,
      pageTitle: tab.title ?? "",
      pageUrl: tab.url ?? "",
    },
  }).catch((e) => err("storage.session.set:", e));
});

// ── Keyboard command ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command, tab) => {
  log("Command:", command);
  if (command === "explain-selection" && tab?.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
    chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_EXPLAIN" }).catch(() => {});
  }
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
        math: string; surroundingText: string;
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
  math: string; surroundingText: string;
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
    pageTitle: payload.pageTitle,
    pageUrl: payload.pageUrl,
    depth: payload.depth as "grad" | "undergrad" | "curious",
    language: settings.language,
  });

  log("Starting Claude stream for math, model:", settings.model);
  streamExplanation(
    settings.apiKey,
    systemPrompt,
    [{ role: "user", content: payload.math }],
    broadcast,
    { model: settings.model, maxTokens: settings.maxTokens },
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

  log("Starting Claude stream for image, model:", settings.model);
  streamImageExplanation(
    settings.apiKey,
    systemPrompt,
    payload.imageDataUrl,
    broadcast,
    { model: settings.model, maxTokens: settings.maxTokens },
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

  log("Starting Claude stream for follow-up, model:", settings.model);
  streamExplanation(
    settings.apiKey,
    systemPrompt,
    messages,
    broadcast,
    { model: settings.model, maxTokens: settings.maxTokens },
  ).catch((e) => { err(e); broadcastError(String(e)); });

  return { streaming: true };
}
