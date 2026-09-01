import { fetchModels, streamExplanation, streamImageExplanation, validateApiKey } from "../utils/api";
import {
  getCachedModelCatalog,
  getSettings,
  saveSettings,
  setCachedModelCatalog,
} from "../utils/settings";
import {
  BUNDLED_MODELS,
  EXPLANATION_EFFORT,
  findModel,
  isCatalogStale,
  resolveMaxTokens,
  resolveModelId,
  wordBudget,
  type ModelCatalog,
  type ModelInfo,
} from "../utils/models";
import {
  buildExplanationPrompt,
  buildFollowUpPrompt,
  buildImageExplanationPrompt,
} from "../utils/promptBuilder";
import type { AppSettings, StreamMessage } from "../types/messages";

const log = (...a: unknown[]) => console.log("[EQ:SW]", ...a);
const err = (...a: unknown[]) => console.error("[EQ:SW]", ...a);

// ── Model catalog ────────────────────────────────────────────────────────────

/**
 * The catalog is fetched from the Models API with the user's key and cached for
 * a day, so a model released after this build appears in Settings on its own.
 * The bundled list is only the cold-start fallback.
 */
async function getModelCatalog(force = false): Promise<ModelCatalog> {
  const cached = await getCachedModelCatalog();
  if (!force && !isCatalogStale(cached)) return cached as ModelCatalog;

  const { apiKey } = await getSettings();
  if (apiKey) {
    try {
      const models = await fetchModels(apiKey);
      const fresh: ModelCatalog = { models, fetchedAt: Date.now(), source: "live" };
      await setCachedModelCatalog(fresh);
      log("Model catalog refreshed:", models.length, "models");
      return fresh;
    } catch (e) {
      err("Model catalog refresh failed, using cache:", e);
    }
  }
  return cached ?? { models: BUNDLED_MODELS, fetchedAt: 0, source: "bundled" };
}

interface SelectedModel {
  id: string;
  info?: ModelInfo;
  maxTokens: number;
  /** Undefined for models that reject the parameter outright. */
  effort?: string;
}

/** Resolve the configured model against the catalog, falling back if it was retired. */
async function selectModel(settings: AppSettings): Promise<SelectedModel> {
  const catalog = await getModelCatalog();
  const id = resolveModelId(catalog.models, settings.model);
  if (id !== settings.model) {
    log("Configured model", settings.model, "is unavailable, falling back to", id);
  }
  const info = findModel(catalog.models, id);
  return {
    id,
    info,
    maxTokens: resolveMaxTokens(settings.maxTokens, info),
    effort: info?.supportsEffort ? EXPLANATION_EFFORT : undefined,
  };
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

const MENU_ID = "equationeer-explain";

chrome.runtime.onInstalled.addListener((details) => {
  log("Installed:", details.reason);
  chrome.contextMenus.create(
    // Visible unless a content script reports the page is out of scope.
    { id: MENU_ID, title: "Explain with Equationeer", contexts: ["selection"], visible: true },
    () => { if (chrome.runtime.lastError) err("Context menu:", chrome.runtime.lastError.message); },
  );
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  void getModelCatalog(true);
});

chrome.runtime.onStartup.addListener(() => { void getModelCatalog(); });

// ── Per-tab activation, mirrored onto the context menu ───────────────────────

/**
 * The content script is the only place that can tell whether a page is a PDF,
 * so it reports its scope decision here. The context menu is global, so it is
 * updated whenever the active tab changes.
 *
 * Fails open: a tab we have heard nothing from keeps the menu. After an
 * extension update every already-open tab holds an orphaned content script that
 * can no longer message us, and failing closed would silently remove the
 * right-click entry from all of them until each was reloaded.
 */
const activeTabs = new Map<number, boolean>();

function syncContextMenu(tabId: number | undefined): void {
  const visible = tabId === undefined || activeTabs.get(tabId) !== false;
  chrome.contextMenus.update(MENU_ID, { visible }, () => {
    // The menu does not exist until onInstalled has run; ignore that case.
    void chrome.runtime.lastError;
  });
}

chrome.tabs.onActivated.addListener(({ tabId }) => syncContextMenu(tabId));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A navigation invalidates the previous decision until the new page reports.
  if (changeInfo.status === "loading") {
    activeTabs.delete(tabId);
    syncContextMenu(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => activeTabs.delete(tabId));

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

    case "GET_MODELS":
      return await getModelCatalog((message.payload as { force?: boolean })?.force ?? false);

    case "SCOPE_STATUS": {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return { error: "No tabId" };
      const active = (message.payload as { active: boolean }).active;
      activeTabs.set(tabId, active);
      if (sender.tab?.active) syncContextMenu(tabId);
      return { success: true };
    }

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
    // max_tokens is a ceiling the model cannot see; this is what makes it fit.
    wordBudget: wordBudget(settings.maxTokens),
  });

  const { id, maxTokens, effort } = await selectModel(settings);
  log("Starting Claude stream for math, model:", id, "maxTokens:", maxTokens, "effort:", effort);
  streamExplanation(
    settings.apiKey,
    systemPrompt,
    [{ role: "user", content: payload.math }],
    broadcast,
    { model: id, maxTokens, effort },
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
    // max_tokens is a ceiling the model cannot see; this is what makes it fit.
    wordBudget: wordBudget(settings.maxTokens),
  });

  const selected = await selectModel(settings);
  if (selected.info && !selected.info.supportsImages) {
    const msg = `${selected.info.displayName} cannot read images. Pick a vision-capable model in Settings to use Screenshot Mode.`;
    broadcastError(msg);
    return { error: msg };
  }

  log("Starting Claude stream for image, model:", selected.id, "maxTokens:", selected.maxTokens);
  streamImageExplanation(
    settings.apiKey,
    systemPrompt,
    payload.imageDataUrl,
    broadcast,
    { model: selected.id, maxTokens: selected.maxTokens, effort: selected.effort },
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
    // max_tokens is a ceiling the model cannot see; this is what makes it fit.
    wordBudget: wordBudget(settings.maxTokens),
  });

  const messages = [
    ...payload.conversationHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: payload.question },
  ];

  const { id, maxTokens, effort } = await selectModel(settings);
  log("Starting Claude stream for follow-up, model:", id, "maxTokens:", maxTokens, "effort:", effort);
  streamExplanation(
    settings.apiKey,
    systemPrompt,
    messages,
    broadcast,
    { model: id, maxTokens, effort },
  ).catch((e) => { err(e); broadcastError(String(e)); });

  return { streaming: true };
}
