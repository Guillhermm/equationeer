import { describe, it, expect } from "vitest";
import {
  BUNDLED_MODELS,
  CATALOG_TTL_MS,
  DEFAULT_MODEL,
  MAX_OUTPUT_CEILING,
  THINKING_HEADROOM_TOKENS,
  TOKENS_PER_WORD,
  describeModel,
  findModel,
  isCatalogStale,
  modelTier,
  parseModelsResponse,
  resolveMaxTokens,
  resolveModelId,
  wordBudget,
  type ModelInfo,
} from "../../src/utils/models";

/** Shape taken from a real GET /v1/models response. */
const apiPayload = {
  data: [
    {
      type: "model",
      id: "claude-sonnet-5",
      display_name: "Claude Sonnet 5",
      created_at: "2026-06-29T00:00:00Z",
      max_input_tokens: 1000000,
      max_tokens: 128000,
      capabilities: {
        image_input: { supported: true },
        effort: { supported: true },
        thinking: { types: { adaptive: { supported: true } } },
      },
    },
    {
      type: "model",
      id: "claude-opus-5",
      display_name: "Claude Opus 5",
      created_at: "2026-07-24T00:00:00Z",
      max_input_tokens: 1000000,
      max_tokens: 128000,
      capabilities: {
        image_input: { supported: true },
        effort: { supported: true },
        thinking: { types: { adaptive: { supported: true } } },
      },
    },
  ],
  has_more: false,
};

// ── parseModelsResponse ───────────────────────────────────────────────────────

describe("parseModelsResponse", () => {
  it("maps the API payload and sorts newest first", () => {
    const models = parseModelsResponse(apiPayload);
    expect(models.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(models[0]).toMatchObject({
      displayName: "Claude Opus 5",
      maxOutputTokens: 128000,
      maxInputTokens: 1000000,
      supportsImages: true,
      supportsEffort: true,
      supportsAdaptiveThinking: true,
    });
  });

  it("flags a model without image input", () => {
    const models = parseModelsResponse({
      data: [{ id: "text-only", capabilities: { image_input: { supported: false } } }],
    });
    expect(models[0].supportsImages).toBe(false);
  });

  it("fills in defaults for missing fields", () => {
    const models = parseModelsResponse({ data: [{ id: "bare-model" }] });
    expect(models[0]).toEqual({
      id: "bare-model",
      displayName: "bare-model",
      createdAt: "",
      maxOutputTokens: MAX_OUTPUT_CEILING,
      maxInputTokens: 0,
      supportsImages: true,
      // Opt-in: sending effort to a model that lacks it is a hard 400.
      supportsEffort: false,
      supportsAdaptiveThinking: false,
    });
  });

  it("reads Haiku 4.5's lack of effort support rather than assuming it", () => {
    const models = parseModelsResponse({
      data: [{
        id: "claude-haiku-4-5-20251001",
        capabilities: {
          effort: { supported: false },
          thinking: { types: { enabled: { supported: true }, adaptive: { supported: false } } },
        },
      }],
    });
    expect(models[0].supportsEffort).toBe(false);
    expect(models[0].supportsAdaptiveThinking).toBe(false);
  });

  it("drops entries without a usable id", () => {
    const models = parseModelsResponse({ data: [{ id: "" }, { id: 42 }, { id: "ok" }] });
    expect(models.map((m) => m.id)).toEqual(["ok"]);
  });

  it("returns an empty list for a malformed payload", () => {
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse({})).toEqual([]);
    expect(parseModelsResponse({ data: "nope" })).toEqual([]);
  });
});

// ── isCatalogStale ────────────────────────────────────────────────────────────

describe("isCatalogStale", () => {
  const now = 1_000_000_000;

  it("treats a missing catalog as stale", () => {
    expect(isCatalogStale(null, now)).toBe(true);
  });

  it("treats the bundled fallback as stale so a live fetch is attempted", () => {
    expect(isCatalogStale({ models: BUNDLED_MODELS, fetchedAt: now, source: "bundled" }, now)).toBe(true);
  });

  it("keeps a fresh live catalog", () => {
    expect(isCatalogStale({ models: [], fetchedAt: now - 1000, source: "live" }, now)).toBe(false);
  });

  it("expires a live catalog past the TTL", () => {
    expect(isCatalogStale({ models: [], fetchedAt: now - CATALOG_TTL_MS - 1, source: "live" }, now)).toBe(true);
  });
});

// ── resolveModelId ────────────────────────────────────────────────────────────

describe("resolveModelId", () => {
  it("keeps a model that still exists", () => {
    expect(resolveModelId(BUNDLED_MODELS, "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("falls back to the default when the stored model was retired", () => {
    expect(resolveModelId(BUNDLED_MODELS, "claude-opus-3-retired")).toBe(DEFAULT_MODEL);
  });

  it("falls back to the newest model when the default is gone too", () => {
    const models: ModelInfo[] = [
      { id: "future-model", displayName: "Future", createdAt: "2027-01-01T00:00:00Z", maxOutputTokens: 1000, maxInputTokens: 1000, supportsImages: true, supportsEffort: false, supportsAdaptiveThinking: false },
    ];
    expect(resolveModelId(models, "gone")).toBe("future-model");
  });

  it("falls back to the default id when the catalog is empty", () => {
    expect(resolveModelId([], "gone")).toBe(DEFAULT_MODEL);
  });
});

// ── resolveMaxTokens ──────────────────────────────────────────────────────────

describe("resolveMaxTokens", () => {
  const thinker = findModel(BUNDLED_MODELS, "claude-opus-5")!;
  const nonThinker = findModel(BUNDLED_MODELS, "claude-haiku-4-5-20251001")!;

  it("adds thinking headroom so the answer is not starved", () => {
    // The bug this guards: Claude Opus 5 spent 1023 of 1024 tokens thinking and
    // returned no text at all.
    expect(resolveMaxTokens(1024, thinker)).toBe(1024 + THINKING_HEADROOM_TOKENS);
  });

  it("adds no headroom for a model that does not think", () => {
    expect(resolveMaxTokens(1024, nonThinker)).toBe(1024);
  });

  it("clamps 'Max' to the ceiling rather than the model's 128k limit", () => {
    expect(resolveMaxTokens(0, thinker)).toBe(MAX_OUTPUT_CEILING);
  });

  it("clamps a request above the ceiling, headroom included", () => {
    expect(resolveMaxTokens(999_999, thinker)).toBe(MAX_OUTPUT_CEILING);
    expect(resolveMaxTokens(MAX_OUTPUT_CEILING, thinker)).toBe(MAX_OUTPUT_CEILING);
  });

  it("respects a model whose limit is below the ceiling", () => {
    const small: ModelInfo = { ...thinker, id: "small", maxOutputTokens: 4096 };
    expect(resolveMaxTokens(0, small)).toBe(4096);
    expect(resolveMaxTokens(8000, small)).toBe(4096);
  });

  it("falls back to the ceiling for an unknown model", () => {
    expect(resolveMaxTokens(0, undefined)).toBe(MAX_OUTPUT_CEILING);
  });
});

// ── wordBudget ────────────────────────────────────────────────────────────────

describe("wordBudget", () => {
  it("converts the shipped default into a target the model can hit", () => {
    // Measured: 1024 answer tokens with a 341-word target finishes all six
    // sections and stops with end_turn instead of max_tokens.
    expect(wordBudget(1024)).toBe(Math.floor(1024 / TOKENS_PER_WORD));
  });

  it("returns null for 'Max', where the full answer already fits", () => {
    expect(wordBudget(0)).toBeNull();
    expect(wordBudget(MAX_OUTPUT_CEILING)).toBeNull();
  });

  it("returns null once the budget exceeds an unconstrained explanation", () => {
    // An unbudgeted six-section answer measured ~3,300 tokens.
    expect(wordBudget(4096)).toBeNull();
    expect(wordBudget(2048)).not.toBeNull();
  });

  it("keeps a floor so a tiny budget still asks for a usable answer", () => {
    expect(wordBudget(120)).toBe(120);
  });
});

// ── modelTier / describeModel ─────────────────────────────────────────────────

describe("modelTier", () => {
  it("classifies the known families", () => {
    expect(modelTier("claude-haiku-4-5-20251001")).toBe("fast");
    expect(modelTier("claude-sonnet-5")).toBe("balanced");
    expect(modelTier("claude-opus-5")).toBe("deep");
    expect(modelTier("claude-fable-5")).toBe("deep");
  });

  it("returns null for an unrecognized family so it still lists", () => {
    expect(modelTier("claude-something-new-6")).toBeNull();
  });
});

describe("describeModel", () => {
  it("describes a known family", () => {
    expect(describeModel(findModel(BUNDLED_MODELS, "claude-haiku-4-5-20251001")!)).toContain("Fastest");
  });

  it("describes an unknown family without pretending to know it", () => {
    const unknown: ModelInfo = { id: "claude-new-9", displayName: "New 9", createdAt: "", maxOutputTokens: 1000, maxInputTokens: 1000, supportsImages: true, supportsEffort: false, supportsAdaptiveThinking: false };
    expect(describeModel(unknown)).toContain("Released after this build");
  });
});

// ── bundled fallback ──────────────────────────────────────────────────────────

describe("BUNDLED_MODELS", () => {
  it("contains the default model, so a cold start always resolves", () => {
    expect(findModel(BUNDLED_MODELS, DEFAULT_MODEL)).toBeDefined();
  });
});
