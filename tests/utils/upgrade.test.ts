/**
 * Upgrade safety: what a 1.0.0 install hits when it receives 1.1.0.
 *
 * Chrome pushes extension updates silently and existing users keep whatever is
 * already in chrome.storage.local and IndexedDB. Every assertion here is about
 * that pre-existing state meeting the new code.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IDBFactory } from "fake-indexeddb";
import { BUNDLED_MODELS, findModel, resolveMaxTokens, resolveModelId } from "../../src/utils/models";
import type { HistoryEntry } from "../../src/types/messages";

declare const chrome: {
  storage: { local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } };
};

/** Exactly the keys 1.0.0 wrote. No scope keys, no model catalog. */
const V1_SETTINGS = {
  apiKey: "sk-ant-existing",
  defaultDepth: "grad",
  theme: "light",
  onboardingCompleted: true,
  model: "claude-sonnet-4-6",
  maxTokens: 1500,
  language: "Portuguese",
};

/** Every model ID 1.0.0 could have stored, from its hardcoded union. */
const V1_MODEL_IDS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
];

let settings: typeof import("../../src/utils/settings");
let storage: typeof import("../../src/utils/storage");

beforeEach(async () => {
  (global as Record<string, unknown>).indexedDB = new IDBFactory();
  vi.resetModules();
  settings = await import("../../src/utils/settings");
  storage = await import("../../src/utils/storage");

  // Mirrors Chrome: keys absent from storage come back from the defaults object.
  chrome.storage.local.get.mockImplementation(
    (defaults: Record<string, unknown>, cb: (r: unknown) => void) => {
      const stored = V1_SETTINGS as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(defaults)) out[k] = k in stored ? stored[k] : v;
      cb(out);
    },
  );
  chrome.storage.local.set.mockImplementation((_d: unknown, cb?: () => void) => cb?.());
});

// ── Settings ──────────────────────────────────────────────────────────────────

describe("a 1.0.0 settings object meeting 1.1.0", () => {
  it("keeps every choice the user had already made", async () => {
    const s = await settings.getSettings();
    expect(s.apiKey).toBe("sk-ant-existing");
    expect(s.defaultDepth).toBe("grad");
    expect(s.theme).toBe("light");
    expect(s.onboardingCompleted).toBe(true);
    expect(s.model).toBe("claude-sonnet-4-6");
    expect(s.language).toBe("Portuguese");
  });

  it("keeps the old response length rather than forcing the new default", async () => {
    // 1.0.0 shipped 1500; 1.1.0 defaults to 1024. A stored value wins.
    const s = await settings.getSettings();
    expect(s.maxTokens).toBe(1500);
  });

  it("fills in the scope keys that did not exist in 1.0.0", async () => {
    const s = await settings.getSettings();
    expect(s.siteActivation).toBe("all");
    expect(s.tooltipScope).toBe("pdf");
    expect(s.siteAllowlist).toEqual([]);
  });

  it("gives the content script a usable scope with nothing stored", async () => {
    const scope = await settings.getScopeSettings();
    expect(scope).toEqual({ siteActivation: "all", tooltipScope: "pdf", siteAllowlist: [] });
  });

  it("does not re-run onboarding for an existing user", async () => {
    expect((await settings.getSettings()).onboardingCompleted).toBe(true);
  });

  it("has no cached model catalog yet, and says so instead of failing", async () => {
    expect(await settings.getCachedModelCatalog()).toBeNull();
  });
});

// ── Models ────────────────────────────────────────────────────────────────────

describe("a model ID stored by 1.0.0", () => {
  it("still resolves offline, before any catalog fetch", () => {
    // The bundled list is the cold-start fallback; a stored model missing from
    // it would be silently switched on first launch.
    for (const id of V1_MODEL_IDS) {
      expect(findModel(BUNDLED_MODELS, id), `${id} dropped from the bundled list`).toBeDefined();
      expect(resolveModelId(BUNDLED_MODELS, id)).toBe(id);
    }
  });

  it("produces a sane token budget for the old 1500 default", () => {
    const model = findModel(BUNDLED_MODELS, "claude-sonnet-4-6")!;
    const resolved = resolveMaxTokens(1500, model);
    expect(resolved).toBeGreaterThanOrEqual(1500);
    expect(resolved).toBeLessThanOrEqual(16000);
  });

  it("falls back rather than sending a retired ID to the API", () => {
    expect(resolveModelId(BUNDLED_MODELS, "claude-3-opus-20240229")).toBe("claude-opus-5");
  });
});

// ── History ───────────────────────────────────────────────────────────────────

describe("history written by 1.0.0", () => {
  /** The 1.0.0 HistoryEntry shape, unchanged in 1.1.0. */
  const legacyEntry: HistoryEntry = {
    id: "legacy-1",
    math: "E = mc^2",
    explanation: "## What This Represents\\nMass-energy equivalence.",
    depth: "undergrad",
    language: "English",
    pageTitle: "Old Paper",
    pageUrl: "https://example.com/paper",
    timestamp: 1_700_000_000_000,
    bookmarked: true,
    conversation: [{ role: "user", content: "why?" }],
    isImage: false,
  };

  it("survives the upgrade and reads back intact", async () => {
    await storage.saveHistoryEntry(legacyEntry);
    expect(await storage.getHistoryEntry("legacy-1")).toEqual(legacyEntry);
  });

  it("still exports", async () => {
    await storage.saveHistoryEntry(legacyEntry);
    expect(await storage.exportHistory()).toContain("legacy-1");
    expect(await storage.exportHistoryAsMarkdown()).toContain("E = mc^2");
  });
});

// ── Manifest ──────────────────────────────────────────────────────────────────

describe("manifest", () => {
  // vitest runs from the package root; import.meta.url is not a file URL under happy-dom.
  const manifest = JSON.parse(readFileSync(resolve("src/manifest.json"), "utf8"));

  it("requests no permission beyond what 1.0.0 already had", () => {
    // Widening permissions makes Chrome disable the extension until the user
    // re-approves it, which is the one thing that would actually break users.
    expect([...manifest.permissions].sort()).toEqual(
      ["activeTab", "contextMenus", "scripting", "sidePanel", "storage"],
    );
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  });

  it("bumps the version, or Chrome will not treat the build as an update", () => {
    const [major, minor] = manifest.version.split(".").map(Number);
    expect(major * 1000 + minor).toBeGreaterThan(1 * 1000 + 0);
  });
});
