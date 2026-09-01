import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamMessage } from "../../src/types/messages";
import { fetchModels, streamExplanation, streamImageExplanation, validateApiKey } from "../../src/utils/api";

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
    await streamExplanation("key-123", systemPrompt, messages, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("key-123");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("uses the model and maxTokens from options", async () => {
    const mockFetch = makeMockFetch(200, makeSSEStream(["data: [DONE]"]));
    vi.stubGlobal("fetch", mockFetch);

    await streamExplanation("k", systemPrompt, messages, () => {}, { model: "claude-opus-4-7", maxTokens: 512 });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe("claude-opus-4-7");
    expect(body.max_tokens).toBe(512);
  });

  it("sends STREAM_CHUNK messages for each token", async () => {
    const chunk = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } });
    const stream = makeSSEStream([`data: ${chunk}`]);
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

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
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

    const done = received.find((m) => m.type === "STREAM_DONE") as Extract<StreamMessage, { type: "STREAM_DONE" }>;
    expect(done).toBeDefined();
    expect(done.fullText).toBe("Hello world");
  });

  it("sends STREAM_ERROR on non-200 response", async () => {
    vi.stubGlobal("fetch", makeMockFetch(401, "Unauthorized", false));

    const received: StreamMessage[] = [];
    await streamExplanation("bad-key", systemPrompt, messages, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err).toBeDefined();
    expect(err.error).toContain("401");
  });

  it("sends STREAM_ERROR when fetch throws an Error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network failure")));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err?.error).toContain("Network failure");
  });

  it("sends STREAM_ERROR when fetch rejects with a non-Error value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("plain string error"));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err?.error).toBe("plain string error");
  });

  it("reports an error rather than an empty panel when no text arrives", async () => {
    const chunk = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta" } }); // no text field
    const stream = makeSSEStream([`data: ${chunk}`]);
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

    expect(received.find((m) => m.type === "STREAM_DONE")).toBeUndefined();
    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err.error).toContain("empty response");
  });

  it("does not crash on malformed JSON in SSE data", async () => {
    const stream = makeSSEStream(["data: {not valid json}"]);
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

    expect(received.filter((m) => m.type === "STREAM_CHUNK")).toHaveLength(0);
    expect(received.at(-1)?.type).toBe("STREAM_ERROR");
  });

  it("omits output_config unless an effort is given", async () => {
    const mockFetch = makeMockFetch(200, makeSSEStream(["data: [DONE]"]));
    vi.stubGlobal("fetch", mockFetch);
    await streamExplanation("k", systemPrompt, messages, () => {}, { model: "claude-haiku-4-5-20251001", maxTokens: 1024 });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    // Haiku 4.5 rejects the parameter with a 400.
    expect(body.output_config).toBeUndefined();
  });

  it("sends output_config.effort when one is given", async () => {
    const mockFetch = makeMockFetch(200, makeSSEStream(["data: [DONE]"]));
    vi.stubGlobal("fetch", mockFetch);
    await streamExplanation("k", systemPrompt, messages, () => {}, { model: "claude-opus-5", maxTokens: 2048, effort: "low" });

    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.output_config).toEqual({ effort: "low" });
  });

  it("explains an answer starved by a thinking budget instead of showing nothing", async () => {
    // Reproduces the real failure: Claude Opus 5 spent the whole max_tokens
    // thinking and streamed no text.
    const stop = JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" } });
    vi.stubGlobal("fetch", makeMockFetch(200, makeSSEStream([`data: ${stop}`])));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-opus-5", maxTokens: 1024 });

    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err.error).toContain("whole token budget");
    expect(err.error).toContain("Response Length");
  });

  it("marks a truncated answer instead of passing it off as complete", async () => {
    const text = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Partial answer" } });
    const stop = JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" } });
    vi.stubGlobal("fetch", makeMockFetch(200, makeSSEStream([`data: ${text}`, `data: ${stop}`])));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-opus-5", maxTokens: 1024 });

    const done = received.find((m) => m.type === "STREAM_DONE") as Extract<StreamMessage, { type: "STREAM_DONE" }>;
    expect(done.fullText).toContain("Partial answer");
    expect(done.fullText).toContain("Cut off at the response length limit");
  });

  it("leaves a complete answer untouched", async () => {
    const text = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Full answer" } });
    const stop = JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } });
    vi.stubGlobal("fetch", makeMockFetch(200, makeSSEStream([`data: ${text}`, `data: ${stop}`])));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-opus-5", maxTokens: 2048 });

    const done = received.find((m) => m.type === "STREAM_DONE") as Extract<StreamMessage, { type: "STREAM_DONE" }>;
    expect(done.fullText).toBe("Full answer");
  });

  it("reads a final event that arrives without a trailing newline", async () => {
    // The SSE parser splits on "\n"; a stream ending mid-line used to drop it.
    const encoder = new TextEncoder();
    const text = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Tail" } });
    const stop = JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" } });
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${text}\n`));
        controller.enqueue(encoder.encode(`data: ${stop}`)); // no trailing newline
        controller.close();
      },
    });
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-opus-5", maxTokens: 2048 });

    const done = received.find((m) => m.type === "STREAM_DONE") as Extract<StreamMessage, { type: "STREAM_DONE" }>;
    expect(done.fullText).toContain("Tail");
    // The trailing stop_reason was read, so the cut-off is marked.
    expect(done.fullText).toContain("Cut off at the response length limit");
  });

  it("ends a stalled stream with a message instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      // A body that never delivers a chunk and never closes.
      const stalled = new ReadableStream({ start() { /* nothing, ever */ } });
      vi.stubGlobal("fetch", makeMockFetch(200, stalled));

      const received: StreamMessage[] = [];
      const pending = streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-opus-5", maxTokens: 2048 });

      await vi.advanceTimersByTimeAsync(61_000);
      await pending;

      const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
      expect(err.error).toContain("No data from the API");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a mid-stream error event, which arrives with HTTP 200", async () => {
    const text = JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Start" } });
    const bad = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    vi.stubGlobal("fetch", makeMockFetch(200, makeSSEStream([`data: ${text}`, `data: ${bad}`])));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-opus-5", maxTokens: 2048 });

    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err.error).toBe("Overloaded");
    expect(received.find((m) => m.type === "STREAM_DONE")).toBeUndefined();
  });

  it("sends STREAM_ERROR when body is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

    const err = received.find((m) => m.type === "STREAM_ERROR");
    expect(err).toBeDefined();
  });

  it("ignores non-text SSE event types", async () => {
    const other = JSON.stringify({ type: "message_start", message: {} });
    const stream = makeSSEStream([`data: ${other}`, "data: [DONE]"]);
    vi.stubGlobal("fetch", makeMockFetch(200, stream));

    const received: StreamMessage[] = [];
    await streamExplanation("k", systemPrompt, messages, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

    const chunks = received.filter((m) => m.type === "STREAM_CHUNK");
    expect(chunks).toHaveLength(0);
  });
});

// ── streamImageExplanation ────────────────────────────────────────────────────

describe("streamImageExplanation", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it("sends STREAM_ERROR for invalid data URL", async () => {
    const received: StreamMessage[] = [];
    await streamImageExplanation("k", "prompt", "not-a-data-url", (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

    const err = received.find((m) => m.type === "STREAM_ERROR") as Extract<StreamMessage, { type: "STREAM_ERROR" }>;
    expect(err?.error).toContain("Invalid image");
  });

  it("sends image content for valid data URL", async () => {
    const fakeDataUrl = "data:image/png;base64,abc123";
    const stream = makeSSEStream(["data: [DONE]"]);
    const mockFetch = makeMockFetch(200, stream);
    vi.stubGlobal("fetch", mockFetch);

    const received: StreamMessage[] = [];
    await streamImageExplanation("k", "prompt", fakeDataUrl, (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

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
    await streamImageExplanation("k", "prompt", "data:image/png;base64,xyz", (m) => received.push(m), { model: "claude-sonnet-4-6", maxTokens: 1500 });

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

// ── fetchModels ───────────────────────────────────────────────────────────────

describe("fetchModels", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  const payload = {
    data: [
      { id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z", max_tokens: 128000, max_input_tokens: 1000000, capabilities: { image_input: { supported: true } } },
    ],
  };

  it("requests the Models API with the key", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    vi.stubGlobal("fetch", mockFetch);

    const models = await fetchModels("my-key");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/models");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("my-key");
    expect(models[0].id).toBe("claude-opus-5");
  });

  it("throws on a non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 401, text: () => Promise.resolve("bad key"),
    }));
    await expect(fetchModels("k")).rejects.toThrow("401");
  });

  it("throws when the response has no usable models", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: () => Promise.resolve({ data: [] }),
    }));
    await expect(fetchModels("k")).rejects.toThrow("no usable models");
  });
});
