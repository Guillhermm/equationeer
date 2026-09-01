import type { StreamMessage } from "../types/messages";
import { parseModelsResponse, type ModelInfo } from "./models";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const API_VERSION = "2023-06-01";

function authHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
    "content-type": "application/json",
  };
}

type ConversationMessage = { role: "user" | "assistant"; content: string | unknown[] };
type StreamCallback = (msg: StreamMessage) => void;

interface StreamOptions {
  model: string;
  maxTokens: number;
  /** Only set for models whose catalog entry reports effort support; a 400 otherwise. */
  effort?: string;
}

/**
 * Longest gap between bytes before the stream is treated as dead. This covers
 * time-to-first-token too, which includes the model's thinking. It exists so a
 * stalled connection ends in a message rather than a spinner that never stops,
 * and it keeps the request well inside the MV3 service worker's lifetime.
 */
const STREAM_IDLE_TIMEOUT_MS = 60_000;

/** Distinguishes our own watchdog from a network failure. */
class StreamIdleError extends Error {}

/** Rejects with StreamIdleError if `promise` has not settled within `ms`. */
function withIdleTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new StreamIdleError("idle"));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const TRUNCATION_NOTE =
  "\n\n---\n*Cut off at the response length limit. Raise Response Length in Settings for the full explanation.*";

export async function streamExplanation(
  apiKey: string,
  systemPrompt: string,
  messages: ConversationMessage[],
  onMessage: StreamCallback,
  options: StreamOptions,
): Promise<void> {
  console.log("[EQ:api] streamExplanation start, model:", options.model);
  let fullText = "";
  let stopReason: string | null = null;

  const controller = new AbortController();

  try {
    const response = await withIdleTimeout(
      fetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens,
        system: systemPrompt,
        messages,
        stream: true,
        ...(options.effort ? { output_config: { effort: options.effort } } : {}),
      }),
      }),
      STREAM_IDLE_TIMEOUT_MS,
      () => controller.abort(),
    );

    console.log("[EQ:api] response status:", response.status);

    if (!response.ok) {
      const errText = await response.text();
      onMessage({ type: "STREAM_ERROR", error: `API ${response.status}: ${errText}` });
      return;
    }

    if (!response.body) {
      onMessage({ type: "STREAM_ERROR", error: "No response body" });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    /** Returns true when the caller should stop: the stream reported an error. */
    const handleEvent = (event: ParsedEvent | null): boolean => {
      if (!event) return false;
      if (event.kind === "text") {
        fullText += event.text;
        onMessage({ type: "STREAM_CHUNK", text: event.text });
      } else if (event.kind === "stop") {
        stopReason = event.stopReason;
      } else {
        onMessage({ type: "STREAM_ERROR", error: event.message });
        return true;
      }
      return false;
    };

    while (true) {
      const { done, value } = await withIdleTimeout(
        reader.read(),
        STREAM_IDLE_TIMEOUT_MS,
        () => controller.abort(),
      );
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (handleEvent(parseSSELine(line))) return;
      }
    }

    // The last event can arrive without a trailing newline; it would otherwise
    // be dropped, losing either the final text or the stop_reason.
    if (handleEvent(parseSSELine(buffer))) return;

    console.log("[EQ:api] stream complete, chars:", fullText.length, "stop:", stopReason);

    // A thinking model can spend the whole budget reasoning and emit no answer.
    // Say so rather than leaving the panel blank.
    if (!fullText) {
      onMessage({
        type: "STREAM_ERROR",
        error: stopReason === "max_tokens"
          ? "The model used its whole token budget before writing an answer. Raise Response Length in Settings, or pick a faster model."
          : "The model returned an empty response. Try again, or re-select the equation.",
      });
      return;
    }

    onMessage({
      type: "STREAM_DONE",
      fullText: stopReason === "max_tokens" ? fullText + TRUNCATION_NOTE : fullText,
    });
  } catch (err) {
    if (err instanceof StreamIdleError) {
      console.error("[EQ:api] stream idle timeout");
      onMessage({
        type: "STREAM_ERROR",
        error: `No data from the API for ${STREAM_IDLE_TIMEOUT_MS / 1000}s. Check your connection and try again.`,
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[EQ:api] fetch error:", msg);
    onMessage({ type: "STREAM_ERROR", error: msg });
  }
}

type ParsedEvent =
  | { kind: "text"; text: string }
  | { kind: "stop"; stopReason: string | null }
  | { kind: "error"; message: string };

function parseSSELine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) return null;
  const data = trimmed.slice(6);
  if (data === "[DONE]") return null;
  try {
    const event = JSON.parse(data) as {
      type: string;
      delta?: { type?: string; text?: string; stop_reason?: string };
      error?: { message?: string; type?: string };
    };
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      return event.delta.text ? { kind: "text", text: event.delta.text } : null;
    }
    // Carries the stop_reason; "max_tokens" means the answer was cut short.
    if (event.type === "message_delta") {
      return { kind: "stop", stopReason: event.delta?.stop_reason ?? null };
    }
    // The API reports mid-stream failures as an event, not an HTTP status.
    if (event.type === "error") {
      return { kind: "error", message: event.error?.message ?? "Stream error" };
    }
  } catch {
    // ignore malformed SSE lines
  }
  return null;
}

export async function streamImageExplanation(
  apiKey: string,
  systemPrompt: string,
  imageDataUrl: string,
  onMessage: StreamCallback,
  options: StreamOptions,
): Promise<void> {
  const match = imageDataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    onMessage({ type: "STREAM_ERROR", error: "Invalid image data URL" });
    return;
  }

  await streamExplanation(
    apiKey,
    systemPrompt,
    [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          },
          {
            type: "text",
            text: "Please explain the mathematical equation(s) shown in this image.",
          },
        ],
      },
    ],
    onMessage,
    options,
  );
}

/**
 * Live model list. Called with the user's key, so the extension never ships a
 * hardcoded set of model IDs that goes stale between releases.
 */
export async function fetchModels(apiKey: string): Promise<ModelInfo[]> {
  const response = await fetch(MODELS_URL, {
    method: "GET",
    headers: authHeaders(apiKey),
  });
  if (!response.ok) {
    throw new Error(`Models API ${response.status}: ${await response.text()}`);
  }
  const models = parseModelsResponse(await response.json());
  if (models.length === 0) throw new Error("Models API returned no usable models");
  return models;
}

/**
 * Validate a key against GET /v1/models: it costs no tokens and needs no model
 * ID, so key validation can never break because a model was retired.
 */
export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(MODELS_URL, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    return response.ok;
  } catch {
    return false;
  }
}
