import { streamExplanation, streamImageExplanation, validateApiKey } from "../utils/api";
import { getSettings, saveSettings } from "../utils/storage";
import {
  buildExplanationPrompt,
  buildFollowUpPrompt,
  buildImageExplanationPrompt,
} from "../utils/promptBuilder";
import type { ExtensionMessage, StreamMessage } from "../types/messages";

interface CaptureTabRequest {
  type: "CAPTURE_TAB";
}

interface ContextMenuExplainMessage {
  type: "CONTEXT_MENU_EXPLAIN";
  payload: { text: string };
}

type AllMessages = ExtensionMessage | CaptureTabRequest | ContextMenuExplainMessage;

// Rate limiting
let requestTimestamps: number[] = [];
const MAX_REQUESTS_PER_MINUTE = 30;
const DEBOUNCE_MS = 500;
let lastRequestTime = 0;

function isRateLimited(): boolean {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < 60_000);
  return requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE;
}

function isDebouncedTooSoon(): boolean {
  const now = Date.now();
  if (now - lastRequestTime < DEBOUNCE_MS) return true;
  lastRequestTime = now;
  return false;
}

// Set up side panel behavior
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {});

// Context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "equationeer-explain",
    title: "Explain with Equationeer",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "equationeer-explain" && tab?.id) {
    chrome.sidePanel.open({ tabId: tab.id });
    // Small delay to let panel open, then send the selection
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: "CONTEXT_MENU_EXPLAIN",
        payload: { text: info.selectionText ?? "" },
      });
    }, 500);
  }
});

// Keyboard shortcut
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "explain-selection" && tab?.id) {
    chrome.sidePanel.open({ tabId: tab.id });
    chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_EXPLAIN" });
  }
});

// Message handler
chrome.runtime.onMessage.addListener(
  (
    message: AllMessages,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    handleMessage(message, sender).then(sendResponse);
    return true; // keep channel open for async
  },
);

async function handleMessage(
  message: AllMessages,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  switch (message.type) {
    case "CAPTURE_TAB": {
      const tabId = sender.tab?.id;
      if (!tabId) return { error: "No tab found" };
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(
          sender.tab!.windowId!,
          { format: "png" },
        );
        return { dataUrl };
      } catch (err) {
        return { error: String(err) };
      }
    }

    case "OPEN_SIDE_PANEL": {
      const tabId = sender.tab?.id;
      if (tabId) {
        await chrome.sidePanel.open({ tabId });
      }
      return { success: true };
    }

    case "GET_SETTINGS": {
      return await getSettings();
    }

    case "SAVE_SETTINGS": {
      return await saveSettings(message.payload);
    }

    case "VALIDATE_API_KEY": {
      const valid = await validateApiKey(message.payload.apiKey);
      return { valid };
    }

    case "EXPLAIN_MATH": {
      if (isDebouncedTooSoon()) {
        return { error: "Please wait a moment before making another request." };
      }
      if (isRateLimited()) {
        return {
          error: "Rate limit reached (30 requests/minute). Please wait.",
        };
      }
      requestTimestamps.push(Date.now());

      const settings = await getSettings();
      if (!settings.apiKey) {
        return { error: "API key not configured. Please set it in options." };
      }

      const { math, surroundingText, pageTitle, depth } = message.payload;
      const systemPrompt = buildExplanationPrompt({
        math,
        surroundingText,
        pageTitle,
        depth,
      });

      void streamToSidePanel(settings.apiKey, systemPrompt, [
        { role: "user" as const, content: math },
      ]);
      return { streaming: true };
    }

    case "EXPLAIN_IMAGE": {
      if (isDebouncedTooSoon() || isRateLimited()) {
        return { error: "Rate limited. Please wait." };
      }
      requestTimestamps.push(Date.now());

      const settings = await getSettings();
      if (!settings.apiKey) {
        return { error: "API key not configured. Please set it in options." };
      }

      const systemPrompt = buildImageExplanationPrompt({
        pageTitle: message.payload.pageTitle,
        depth: message.payload.depth,
      });

      void streamImageToSidePanel(
        settings.apiKey,
        systemPrompt,
        message.payload.imageDataUrl,
      );
      return { streaming: true };
    }

    case "FOLLOW_UP": {
      if (isDebouncedTooSoon() || isRateLimited()) {
        return { error: "Rate limited. Please wait." };
      }
      requestTimestamps.push(Date.now());

      const settings = await getSettings();
      if (!settings.apiKey) {
        return { error: "API key not configured." };
      }

      const { question, conversationHistory, originalMath, depth } =
        message.payload;
      const systemPrompt = buildFollowUpPrompt({ originalMath, depth });

      const messages = [
        ...conversationHistory.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: question },
      ];

      void streamToSidePanel(settings.apiKey, systemPrompt, messages);
      return { streaming: true };
    }

    default:
      return { error: "Unknown message type" };
  }
}

async function streamToSidePanel(
  apiKey: string,
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<void> {
  await streamExplanation(apiKey, systemPrompt, messages, (msg: StreamMessage) => {
    chrome.runtime.sendMessage(msg).catch(() => {});
  });
}

async function streamImageToSidePanel(
  apiKey: string,
  systemPrompt: string,
  imageDataUrl: string,
): Promise<void> {
  await streamImageExplanation(apiKey, systemPrompt, imageDataUrl, (msg: StreamMessage) => {
    chrome.runtime.sendMessage(msg).catch(() => {});
  });
}
