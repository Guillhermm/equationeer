import Anthropic from "@anthropic-ai/sdk";
import type { StreamMessage } from "../types/messages";

let client: Anthropic | null = null;

function getClient(apiKey: string): Anthropic {
  if (!client || (client as unknown as { apiKey: string }).apiKey !== apiKey) {
    client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
    });
  }
  return client;
}

export async function streamExplanation(
  apiKey: string,
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string | Anthropic.MessageCreateParams["messages"][0]["content"] }>,
  onMessage: (msg: StreamMessage) => void,
): Promise<void> {
  const anthropic = getClient(apiKey);
  let fullText = "";

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullText += event.delta.text;
        onMessage({ type: "STREAM_CHUNK", text: event.delta.text });
      }
    }

    onMessage({ type: "STREAM_DONE", fullText });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error occurred";
    onMessage({ type: "STREAM_ERROR", error: message });
  }
}

export async function streamImageExplanation(
  apiKey: string,
  systemPrompt: string,
  imageDataUrl: string,
  onMessage: (msg: StreamMessage) => void,
): Promise<void> {
  const anthropic = getClient(apiKey);
  let fullText = "";

  const match = imageDataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    onMessage({ type: "STREAM_ERROR", error: "Invalid image data" });
    return;
  }

  const mediaType = match[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  const base64Data = match[2];

  try {
    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64Data,
              },
            },
            {
              type: "text",
              text: "Please explain the mathematical equation(s) shown in this image.",
            },
          ],
        },
      ],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullText += event.delta.text;
        onMessage({ type: "STREAM_CHUNK", text: event.delta.text });
      }
    }

    onMessage({ type: "STREAM_DONE", fullText });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error occurred";
    onMessage({ type: "STREAM_ERROR", error: message });
  }
}

export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const anthropic = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
    });
    await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 10,
      messages: [{ role: "user", content: "Say ok" }],
    });
    return true;
  } catch {
    return false;
  }
}
