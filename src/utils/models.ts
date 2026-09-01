/**
 * The model catalog.
 *
 * Model IDs are not hardcoded into the UI. The list comes from Anthropic's
 * Models API (`GET /v1/models`), fetched with the user's own key and cached in
 * `chrome.storage.local`, so a model released after this build ships shows up
 * in Settings without a new extension version. The bundled list below is only
 * a cold-start fallback: it is used before the first successful fetch, or when
 * the network call fails.
 */

export interface ModelInfo {
  id: string;
  displayName: string;
  /** ISO 8601 release date, used to sort newest first. */
  createdAt: string;
  maxOutputTokens: number;
  maxInputTokens: number;
  /** Screenshot mode needs this: a model without it cannot read a clipped equation. */
  supportsImages: boolean;
  /** `output_config.effort` is rejected with a 400 by models without it (Haiku 4.5). */
  supportsEffort: boolean;
  /** Adaptive thinking spends output tokens before any answer text is written. */
  supportsAdaptiveThinking: boolean;
}

export interface ModelCatalog {
  models: ModelInfo[];
  fetchedAt: number;
  source: "live" | "bundled";
}

export const DEFAULT_MODEL = "claude-opus-5";

/** Refetch the catalog when the cached copy is older than this. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling applied to the "Max" response-length option. Current models allow
 * 128k output tokens, which is far past any explanation and would make a
 * mis-click expensive.
 */
export const MAX_OUTPUT_CEILING = 16000;

/**
 * Thinking is billed out of `max_tokens`, so the user's response-length setting
 * is treated as the *answer* budget and this is added on top for models that
 * think. Without it Claude Opus 5 spends the entire budget reasoning and the
 * panel shows nothing: measured 1023 of 1024 tokens on a single equation.
 */
export const THINKING_HEADROOM_TOKENS = 1024;

/**
 * Measured on real explanations: math-heavy markdown with LaTeX costs ~2.65
 * output tokens per word, roughly double plain prose. Rounded up for margin.
 */
export const TOKENS_PER_WORD = 3;

/**
 * An unconstrained six-section explanation measured ~3,300 answer tokens, so a
 * budget at or above this does not need a length instruction at all.
 */
const UNCONSTRAINED_ANSWER_TOKENS = 4096;

/**
 * Words to aim for, given the user's answer-token budget, or null when the
 * budget is generous enough that the model should just write the full answer.
 *
 * `max_tokens` is an enforced ceiling the model cannot see: left to itself it
 * plans a full explanation and gets cut off mid-sentence. Telling it the budget
 * up front is what actually makes the answer fit.
 */
export function wordBudget(answerTokens: number): number | null {
  if (answerTokens <= 0 || answerTokens >= UNCONSTRAINED_ANSWER_TOKENS) return null;
  return Math.max(120, Math.floor(answerTokens / TOKENS_PER_WORD));
}

/**
 * Effort for explanation requests. These are short, single-turn answers
 * streamed while the user waits, so the depth `high` buys is not worth the
 * latency or the tokens it takes from the answer.
 */
export const EXPLANATION_EFFORT = "low";

/** Cold-start fallback. Verified against GET /v1/models on 2026-08-31. */
export const BUNDLED_MODELS: ModelInfo[] = [
  { id: "claude-opus-5", displayName: "Claude Opus 5", createdAt: "2026-07-24T00:00:00Z", maxOutputTokens: 128000, maxInputTokens: 1000000, supportsImages: true, supportsEffort: true, supportsAdaptiveThinking: true },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", createdAt: "2026-06-29T00:00:00Z", maxOutputTokens: 128000, maxInputTokens: 1000000, supportsImages: true, supportsEffort: true, supportsAdaptiveThinking: true },
  { id: "claude-fable-5", displayName: "Claude Fable 5", createdAt: "2026-06-07T00:00:00Z", maxOutputTokens: 128000, maxInputTokens: 1000000, supportsImages: true, supportsEffort: true, supportsAdaptiveThinking: true },
  { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", createdAt: "2026-05-28T00:00:00Z", maxOutputTokens: 128000, maxInputTokens: 1000000, supportsImages: true, supportsEffort: true, supportsAdaptiveThinking: true },
  // Selectable in 1.0.0, so a stored value must still resolve offline.
  { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", createdAt: "2026-04-14T00:00:00Z", maxOutputTokens: 128000, maxInputTokens: 1000000, supportsImages: true, supportsEffort: true, supportsAdaptiveThinking: true },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", createdAt: "2026-02-17T00:00:00Z", maxOutputTokens: 128000, maxInputTokens: 1000000, supportsImages: true, supportsEffort: true, supportsAdaptiveThinking: true },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", createdAt: "2025-10-15T00:00:00Z", maxOutputTokens: 64000, maxInputTokens: 200000, supportsImages: true, supportsEffort: false, supportsAdaptiveThinking: false },
];

interface RawModel {
  id?: unknown;
  display_name?: unknown;
  created_at?: unknown;
  max_tokens?: unknown;
  max_input_tokens?: unknown;
  capabilities?: {
    image_input?: { supported?: unknown };
    effort?: { supported?: unknown };
    thinking?: { types?: { adaptive?: { supported?: unknown } } };
  };
}

/**
 * Map a `GET /v1/models` payload to ModelInfo, newest first.
 * Unknown or malformed entries are dropped rather than trusted.
 */
export function parseModelsResponse(payload: unknown): ModelInfo[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const models: ModelInfo[] = [];
  for (const raw of data as RawModel[]) {
    if (typeof raw?.id !== "string" || !raw.id) continue;
    models.push({
      id: raw.id,
      displayName: typeof raw.display_name === "string" ? raw.display_name : raw.id,
      createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
      maxOutputTokens: typeof raw.max_tokens === "number" ? raw.max_tokens : MAX_OUTPUT_CEILING,
      maxInputTokens: typeof raw.max_input_tokens === "number" ? raw.max_input_tokens : 0,
      supportsImages: raw.capabilities?.image_input?.supported !== false,
      // Default false: sending `effort` to a model without it is a hard 400.
      supportsEffort: raw.capabilities?.effort?.supported === true,
      supportsAdaptiveThinking:
        raw.capabilities?.thinking?.types?.adaptive?.supported === true,
    });
  }
  return models.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function isCatalogStale(catalog: ModelCatalog | null, now = Date.now()): boolean {
  if (!catalog || catalog.source !== "live") return true;
  return now - catalog.fetchedAt > CATALOG_TTL_MS;
}

export function findModel(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find((m) => m.id === id);
}

/**
 * The model to actually use. A stored ID that has since been retired falls back
 * to the default, then to the newest model the catalog knows about.
 */
export function resolveModelId(models: ModelInfo[], storedId: string): string {
  if (findModel(models, storedId)) return storedId;
  if (findModel(models, DEFAULT_MODEL)) return DEFAULT_MODEL;
  return models[0]?.id ?? DEFAULT_MODEL;
}

/**
 * `setting` is the user's *answer* budget; 0 means "as much as the model
 * allows". Models that think get THINKING_HEADROOM_TOKENS added on top, since
 * thinking is spent from the same allowance. Always clamped to the ceiling.
 */
export function resolveMaxTokens(setting: number, model: ModelInfo | undefined): number {
  const ceiling = Math.min(model?.maxOutputTokens ?? MAX_OUTPUT_CEILING, MAX_OUTPUT_CEILING);
  if (setting <= 0) return ceiling;
  const headroom = model?.supportsAdaptiveThinking ? THINKING_HEADROOM_TOKENS : 0;
  return Math.min(setting + headroom, ceiling);
}

/**
 * Rough speed/depth hint for the Settings list, derived from the family name in
 * the ID. Returns null for families this build has never heard of, which is the
 * point: an unknown future model still lists, just without a badge.
 */
export function modelTier(id: string): "fast" | "balanced" | "deep" | null {
  const name = id.toLowerCase();
  if (name.includes("haiku")) return "fast";
  if (name.includes("sonnet")) return "balanced";
  if (name.includes("opus") || name.includes("fable") || name.includes("mythos")) return "deep";
  return null;
}

const TIER_DESCRIPTION: Record<"fast" | "balanced" | "deep", string> = {
  fast: "Fastest and cheapest, for quick lookups",
  balanced: "Balanced quality and cost",
  deep: "Most capable: deepest explanations, highest cost",
};

export function describeModel(model: ModelInfo): string {
  const tier = modelTier(model.id);
  return tier ? TIER_DESCRIPTION[tier] : "Released after this build; capabilities read live from the API";
}
