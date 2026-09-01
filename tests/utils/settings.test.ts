import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ModelCatalog } from "../../src/utils/models";

// chrome is set up as a global mock in tests/setup.ts
declare const chrome: {
  storage: {
    local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  };
};

let settingsModule: typeof import("../../src/utils/settings");

beforeEach(async () => {
  vi.resetModules();
  settingsModule = await import("../../src/utils/settings");
});

/** chrome.storage.local.get(defaults, cb) resolves missing keys from `defaults`. */
function mockStorage(stored: Record<string, unknown> = {}) {
  chrome.storage.local.get.mockImplementation(
    (defaults: Record<string, unknown>, callback: (r: unknown) => void) => {
      callback({ ...defaults, ...stored });
    },
  );
  chrome.storage.local.set.mockImplementation((_data: unknown, callback?: () => void) => {
    callback?.();
  });
}

// ── getSettings ───────────────────────────────────────────────────────────────

describe("getSettings", () => {
  it("returns defaults when storage is empty", async () => {
    mockStorage();
    const settings = await settingsModule.getSettings();
    expect(settings.defaultDepth).toBe("undergrad");
    expect(settings.theme).toBe("dark");
    expect(settings.maxTokens).toBe(1024);
    expect(settings.language).toBe("English");
  });

  it("defaults to active everywhere with the hover pill limited to PDFs", async () => {
    mockStorage();
    const settings = await settingsModule.getSettings();
    expect(settings.siteActivation).toBe("all");
    expect(settings.tooltipScope).toBe("pdf");
    expect(settings.siteAllowlist).toEqual([]);
  });

  it("returns stored values over defaults", async () => {
    mockStorage({ apiKey: "sk-test", onboardingCompleted: true, siteActivation: "pdf" });
    const settings = await settingsModule.getSettings();
    expect(settings.apiKey).toBe("sk-test");
    expect(settings.siteActivation).toBe("pdf");
  });
});

// ── saveSettings ──────────────────────────────────────────────────────────────

describe("saveSettings", () => {
  it("merges the patch over current settings", async () => {
    mockStorage();
    const result = await settingsModule.saveSettings({
      apiKey: "new-key",
      theme: "light",
      model: "claude-sonnet-5",
    });
    expect(result.apiKey).toBe("new-key");
    expect(result.theme).toBe("light");
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.defaultDepth).toBe("undergrad"); // unchanged
    expect(chrome.storage.local.set).toHaveBeenCalled();
  });

  it("persists the allowlist", async () => {
    mockStorage({ siteAllowlist: ["arxiv.org"] });
    const result = await settingsModule.saveSettings({ siteAllowlist: ["arxiv.org", "example.com"] });
    expect(result.siteAllowlist).toEqual(["arxiv.org", "example.com"]);
  });
});

// ── getScopeSettings ──────────────────────────────────────────────────────────

describe("getScopeSettings", () => {
  it("reads only the scope keys, so the content script skips the rest", async () => {
    mockStorage({ siteActivation: "allowlist", siteAllowlist: ["arxiv.org"] });
    const scope = await settingsModule.getScopeSettings();
    expect(scope).toEqual({
      siteActivation: "allowlist",
      tooltipScope: "pdf",
      siteAllowlist: ["arxiv.org"],
    });
    const requestedKeys = Object.keys(chrome.storage.local.get.mock.calls[0][0] as object);
    expect(requestedKeys.sort()).toEqual(["siteActivation", "siteAllowlist", "tooltipScope"]);
  });
});

// ── model catalog cache ───────────────────────────────────────────────────────

describe("model catalog cache", () => {
  const catalog: ModelCatalog = {
    models: [{ id: "claude-opus-5", displayName: "Claude Opus 5", createdAt: "2026-07-24T00:00:00Z", maxOutputTokens: 128000, maxInputTokens: 1000000, supportsImages: true, supportsEffort: true, supportsAdaptiveThinking: true }],
    fetchedAt: 1_700_000_000_000,
    source: "live",
  };

  it("returns null when nothing is cached", async () => {
    mockStorage();
    expect(await settingsModule.getCachedModelCatalog()).toBeNull();
  });

  it("round-trips a catalog", async () => {
    mockStorage({ modelCatalog: catalog });
    expect(await settingsModule.getCachedModelCatalog()).toEqual(catalog);

    await settingsModule.setCachedModelCatalog(catalog);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      { modelCatalog: catalog },
      expect.any(Function),
    );
  });
});
