import { describe, it, expect, beforeEach, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { HistoryEntry } from "../../src/types/messages";

// chrome is set up as a global mock in tests/setup.ts
declare const chrome: {
  storage: {
    local: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  };
};

let storage: typeof import("../../src/utils/storage");

beforeEach(async () => {
  // Fresh IDB factory ensures each test starts with an empty database
  (global as Record<string, unknown>).indexedDB = new IDBFactory();
  vi.resetModules();
  storage = await import("../../src/utils/storage");
});

function makeEntry(id: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    math: `f(x)=${id}`,
    explanation: `Explanation ${id}`,
    depth: "undergrad",
    pageTitle: "Test Page",
    pageUrl: "https://example.com",
    timestamp: Date.now(),
    bookmarked: false,
    conversation: [],
    isImage: false,
    ...overrides,
  };
}

// ── saveHistoryEntry / getHistoryEntries ──────────────────────────────────────

describe("saveHistoryEntry + getHistoryEntries", () => {
  it("saves and retrieves a single entry", async () => {
    const entry = makeEntry("1");
    await storage.saveHistoryEntry(entry);
    const entries = await storage.getHistoryEntries();
    expect(entries.some((e) => e.id === "1")).toBe(true);
  });

  it("returns entries in reverse timestamp order", async () => {
    const old = makeEntry("old", { timestamp: 1000 });
    const newer = makeEntry("newer", { timestamp: 2000 });
    await storage.saveHistoryEntry(old);
    await storage.saveHistoryEntry(newer);
    const entries = await storage.getHistoryEntries();
    const ids = entries.map((e) => e.id);
    expect(ids.indexOf("newer")).toBeLessThan(ids.indexOf("old"));
  });

  it("overwrites an entry with same id on re-save", async () => {
    const entry = makeEntry("dup");
    await storage.saveHistoryEntry(entry);
    await storage.saveHistoryEntry({ ...entry, explanation: "Updated" });
    const all = await storage.getHistoryEntries();
    const found = all.filter((e) => e.id === "dup");
    expect(found).toHaveLength(1);
    expect(found[0].explanation).toBe("Updated");
  });
});

// ── deleteHistoryEntry ────────────────────────────────────────────────────────

describe("deleteHistoryEntry", () => {
  it("removes the entry from history", async () => {
    const entry = makeEntry("del-1");
    await storage.saveHistoryEntry(entry);
    await storage.deleteHistoryEntry("del-1");
    const entries = await storage.getHistoryEntries();
    expect(entries.some((e) => e.id === "del-1")).toBe(false);
  });

  it("does not throw when deleting non-existent id", async () => {
    await expect(storage.deleteHistoryEntry("ghost-id")).resolves.not.toThrow();
  });
});

// ── toggleBookmark ────────────────────────────────────────────────────────────

describe("toggleBookmark", () => {
  it("bookmarks an unbookmarked entry", async () => {
    const entry = makeEntry("bm-1", { bookmarked: false });
    await storage.saveHistoryEntry(entry);
    const result = await storage.toggleBookmark("bm-1");
    expect(result).toBe(true);
    const updated = await storage.getHistoryEntries();
    expect(updated.find((e) => e.id === "bm-1")?.bookmarked).toBe(true);
  });

  it("unbookmarks a bookmarked entry", async () => {
    const entry = makeEntry("bm-2", { bookmarked: true });
    await storage.saveHistoryEntry(entry);
    const result = await storage.toggleBookmark("bm-2");
    expect(result).toBe(false);
  });

  it("returns false for non-existent id", async () => {
    const result = await storage.toggleBookmark("missing");
    expect(result).toBe(false);
  });
});

// ── getHistoryEntry ───────────────────────────────────────────────────────────

describe("getHistoryEntry", () => {
  it("returns the entry by id", async () => {
    const entry = makeEntry("get-1");
    await storage.saveHistoryEntry(entry);
    const result = await storage.getHistoryEntry("get-1");
    expect(result?.id).toBe("get-1");
  });

  it("returns undefined for unknown id", async () => {
    const result = await storage.getHistoryEntry("does-not-exist");
    expect(result).toBeUndefined();
  });
});

// ── updateConversation ────────────────────────────────────────────────────────

describe("updateConversation", () => {
  it("updates conversation on an existing entry", async () => {
    const entry = makeEntry("upd-1");
    await storage.saveHistoryEntry(entry);
    const newConv = [{ role: "user" as const, content: "What is this?" }];
    await storage.updateConversation("upd-1", newConv);
    const updated = await storage.getHistoryEntry("upd-1");
    expect(updated?.conversation).toEqual(newConv);
  });

  it("does nothing for unknown id", async () => {
    await expect(storage.updateConversation("ghost", [])).resolves.not.toThrow();
  });
});

// ── exportHistory ─────────────────────────────────────────────────────────────

describe("exportHistory", () => {
  it("exports valid JSON", async () => {
    await storage.saveHistoryEntry(makeEntry("exp-1"));
    const json = await storage.exportHistory();
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json) as HistoryEntry[];
    expect(parsed.some((e) => e.id === "exp-1")).toBe(true);
  });
});

// ── exportHistoryAsMarkdown ───────────────────────────────────────────────────

describe("exportHistoryAsMarkdown", () => {
  it("contains the equation in the output", async () => {
    await storage.saveHistoryEntry(makeEntry("md-1", { math: "E=mc^2" }));
    const md = await storage.exportHistoryAsMarkdown();
    expect(md).toContain("E=mc^2");
  });

  it("contains the explanation", async () => {
    await storage.saveHistoryEntry(makeEntry("md-2", { explanation: "Energy-mass equivalence" }));
    const md = await storage.exportHistoryAsMarkdown();
    expect(md).toContain("Energy-mass equivalence");
  });

  it("returns empty string when history is empty", async () => {
    const md = await storage.exportHistoryAsMarkdown();
    expect(md.trim()).toBe("");
  });
});

// ── getSettings / saveSettings ────────────────────────────────────────────────

describe("getSettings", () => {
  it("returns default settings when storage is empty", async () => {
    chrome.storage.local.get.mockImplementation((_keys, callback) => {
      callback({ apiKey: "", defaultDepth: "undergrad", theme: "dark", onboardingCompleted: false });
    });
    const settings = await storage.getSettings();
    expect(settings.defaultDepth).toBe("undergrad");
    expect(settings.theme).toBe("dark");
  });

  it("returns stored api key", async () => {
    chrome.storage.local.get.mockImplementation((_keys, callback) => {
      callback({ apiKey: "sk-test", defaultDepth: "undergrad", theme: "dark", onboardingCompleted: true });
    });
    const settings = await storage.getSettings();
    expect(settings.apiKey).toBe("sk-test");
  });
});

describe("saveSettings", () => {
  it("calls chrome.storage.local.set with merged settings", async () => {
    chrome.storage.local.get.mockImplementation((_keys, callback) => {
      callback({ apiKey: "", defaultDepth: "undergrad", theme: "dark", onboardingCompleted: false });
    });
    chrome.storage.local.set.mockImplementation((_data, callback) => {
      callback?.();
    });

    const result = await storage.saveSettings({ apiKey: "new-key", theme: "light" });
    expect(result.apiKey).toBe("new-key");
    expect(result.theme).toBe("light");
    expect(result.defaultDepth).toBe("undergrad"); // unchanged
    expect(chrome.storage.local.set).toHaveBeenCalled();
  });
});
