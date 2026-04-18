import type { StreamMessage } from "../types/messages";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MODEL = "claude-sonnet-4-6";

type ConversationMessage = { role: "user" | "assistant"; content: string | unknown[] };
type StreamCallback = (msg: StreamMessage) => void;

export async function streamExplanation(
  apiKey: string,
  systemPrompt: string,
  messages: ConversationMessage[],
  onMessage: StreamCallback,
): Promise<void> {
  console.log("[EQ:api] streamExplanation start, model:", MODEL);
  let fullText = "";

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages,
        stream: true,
      }),
    });

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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const chunk = parseSSELine(line);
        if (chunk) {
          fullText += chunk;
          onMessage({ type: "STREAM_CHUNK", text: chunk });
        }
      }
    }

    console.log("[EQ:api] stream complete, chars:", fullText.length);
    onMessage({ type: "STREAM_DONE", fullText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[EQ:api] fetch error:", msg);
    onMessage({ type: "STREAM_ERROR", error: msg });
  }
}

function parseSSELine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data: ")) return null;
  const data = trimmed.slice(6);
  if (data === "[DONE]") return null;
  try {
    const event = JSON.parse(data) as {
      type: string;
      delta?: { type: string; text?: string };
    };
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      return event.delta.text ?? null;
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
  );
}

export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 10,
        messages: [{ role: "user", content: "ok" }],
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
