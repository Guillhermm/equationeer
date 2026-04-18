import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamMessage } from "../../src/types/messages";
import { streamExplanation, streamImageExplanation, validateApiKey } from "../../src/utils/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
}

function makeMockFetch(status: number, body: ReadableStream | string | null, ok = status < 400) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : ""),
    body: typeof body === "object" && body !== null ? body : null,
  });
}

// ── streamExplanation ─────────────────────────────────────────────────────────

describe("streamExplanation", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  const systemPrompt = "You are a math teacher.";
  const messages = [{ role: "user" as const, content: "Explain E=mc^2" }];

  it("calls the Anthropic API with correct headers", async () => {
    const mockFetch = makeMockFetch(200, makeSSEStream(["data: [DONE]"]));
    vi.stubGlobal("fetch", mockFetch);

    const received: StreamMessage[] = [];
    await streamExplanation("key-123", systemPrompt, messages, (m) => received.push(m));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("key-123");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("uses model claude-sonnet-4-6", async () => {
    const mockFetch = makeMockFetch(200, makeSSEStream(["data: [DONE]"]));
    vi.stubGlobal("fetch", mockFetch);

    await streamExplanation("k", systemPrompt, messages, () => {});

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  it("sends STREAM_CHUNK messages for each token", async () => {
    const chunk = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } });
    const stream = makeSSEStream([`data: ${chunk}`]);
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m));

    const chunks = received.filter((m) => m.type === "STREAM_CHUNK");
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as Extract<StreamMessage, { type: "STREAM_CHUNK" }>).text).toBe("Hello");
  });

  it("sends STREAM_DONE with accumulated fullText", async () => {
    const makeChunk = (text: string) =>
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}`;
    const stream = makeSSEStream([makeChunk("Hello "), makeChunk("world")]);
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m));

    const done = received.find((m) => m.type === "STREAM_DONE") as Extract<StreamMessage, { type: "STREAM_DONE" }>;
    expect(done).toBeDefined();
    expect(done.fullText).toBe("Hello world");
  });

  it("sends STREAM_ERROR on non-200 response", async () => {
    vi.stubGlobal("fetch", makeMockFetch(401, "Unauthorized", false));

    const received: StreamMessage[] = [];
    await streamExplanation("bad-key", systemPrompt, messages, (m) => received.push(m));

    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err).toBeDefined();
    expect(err.error).toContain("401");
  });

  it("sends STREAM_ERROR when fetch throws an Error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network failure")));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m));

    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err?.error).toContain("Network failure");
  });

  it("sends STREAM_ERROR when fetch rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("plain string error"));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m));

    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err?.error).toBe("plain string error");
  });

  it("ignores SSE event where delta.text is undefined", async () => {
    const chunk = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta" } }); // no text field
    const stream = makeSSEStream([`data: ${chunk}`]);
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m));

    const done = received.find((m) => m.type === "STREAM_DONE") as Extract<StreamMessage, { type: "STREAM_DONE" }>;
    expect(done?.fullText).toBe("");
  });

  it("ignores malformed JSON in SSE data", async () => {
    const stream = makeSSEStream(["data: {not valid json}"]);
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m));

    // Should still complete with empty text, no crash
    const done = received.find((m) => m.type === "STREAM_DONE");
    expect(done).toBeDefined();
  });

  it("sends STREAM_ERROR when body is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m));

    const err = received.find((m) => m.type === "STREAM_ERROR");
    expect(err).toBeDefined();
  });

  it("ignores non-text SSE event types", async () => {
    const other = JSON.stringify({ type: "message_start", message: {} });
    const stream = makeSSEStream([`data: ${other}`, "data: [DONE]"]);
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m));

    const chunks = received.filter((m) => m.type === "STREAM_CHUNK");
    expect(chunks).toHaveLength(0);
  });
});

// ── streamImageExplanation ────────────────────────────────────────────────────

describe("streamImageExplanation", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it("sends STREAM_ERROR for invalid data URL", async () => {
    const received: StreamMessage[] = [];
    await streamImageExplanation("k", "prompt", "not-a-data-url", (m) => received.push(m));

    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err?.error).toContain("Invalid image");
  });

  it("sends image content for valid data URL", async () => {
    const fakeDataUrl = "data:image/png;base64,abc123";
    const stream = makeSSEStream(["data: [DONE]"]);
    const mockFetch = makeMockFetch(200, stream);
    vi.stubGlobal("fetch", mockFetch);

    const received: StreamMessage[] = [];
    await streamImageExplanation("k", "prompt", fakeDataUrl, (m) => received.push(m));

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    const content = body.messages[0].content;
    const imgBlock = content.find((c: { type: string }) => c.type === "image");
    expect(imgBlock?.source?.data).toBe("abc123");
    expect(imgBlock?.source?.media_type).toBe("image/png");
  });

  it("sends STREAM_DONE on successful image explanation", async () => {
    const chunk = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Result" } });
    const stream = makeSSEStream([`data: ${chunk}`]);
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamImageExplanation("k", "prompt", "data:image/png;base64,xyz", (m) => received.push(m));

    const done = received.find((m) => m.type === "STREAM_DONE") as Extract<StreamMessage, { type: "STREAM_DONE" }>;
    expect(done?.fullText).toBe("Result");
  });
});

// ── validateApiKey ────────────────────────────────────────────────────────────

describe("validateApiKey", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it("returns true when API responds with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    expect(await validateApiKey("valid-key")).toBe(true);
  });

  it("returns false when API responds with 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect(await validateApiKey("bad-key")).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await validateApiKey("k")).toBe(false);
  });

  it("sends the api key in the request header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", mockFetch);

    await validateApiKey("my-test-key");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("my-test-key");
  });
});
