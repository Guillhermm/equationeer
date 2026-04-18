import { openDB, type IDBPDatabase } from "idb";
import type { AppSettings, HistoryEntry } from "../types/messages";

const DB_NAME = "equationeer";
const DB_VERSION = 1;
const HISTORY_STORE = "history";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          const store = db.createObjectStore(HISTORY_STORE, { keyPath: "id" });
          store.createIndex("timestamp", "timestamp");
          store.createIndex("bookmarked", "bookmarked");
        }
      },
    });
  }
  return dbPromise;
}

export async function saveHistoryEntry(entry: HistoryEntry): Promise<void> {
  const db = await getDb();
  await db.put(HISTORY_STORE, entry);
}

export async function getHistoryEntries(): Promise<HistoryEntry[]> {
  const db = await getDb();
  const entries = await db.getAllFromIndex(HISTORY_STORE, "timestamp");
  return entries.reverse();
}

export async function getHistoryEntry(
  id: string,
): Promise<HistoryEntry | undefined> {
  const db = await getDb();
  return db.get(HISTORY_STORE, id);
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(HISTORY_STORE, id);
}

export async function toggleBookmark(id: string): Promise<boolean> {
  const db = await getDb();
  const entry = await db.get(HISTORY_STORE, id);
  if (!entry) return false;
  entry.bookmarked = !entry.bookmarked;
  await db.put(HISTORY_STORE, entry);
  return entry.bookmarked;
}

export async function updateConversation(
  id: string,
  conversation: HistoryEntry["conversation"],
): Promise<void> {
  const db = await getDb();
  const entry = await db.get(HISTORY_STORE, id);
  if (!entry) return;
  entry.conversation = conversation;
  await db.put(HISTORY_STORE, entry);
}

export async function exportHistory(): Promise<string> {
  const entries = await getHistoryEntries();
  return JSON.stringify(entries, null, 2);
}

export async function exportHistoryAsMarkdown(): Promise<string> {
  const entries = await getHistoryEntries();
  return entries
    .map(
      (e) =>
        `# ${e.math.slice(0, 80)}\n\n**Page:** ${e.pageTitle}\n**Date:** ${new Date(e.timestamp).toLocaleDateString()}\n**Depth:** ${e.depth}\n\n${e.explanation}\n\n---\n`,
    )
    .join("\n");
}

const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  defaultDepth: "undergrad",
  theme: "dark",
  onboardingCompleted: false,
  model: "claude-sonnet-4-6",
  maxTokens: 1500,
  language: "English",
};

export async function getSettings(): Promise<AppSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (result) => {
      resolve(result as AppSettings);
    });
  });
}

export async function saveSettings(
  partial: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = await getSettings();
  const updated = { ...current, ...partial };
  return new Promise((resolve) => {
    chrome.storage.local.set(updated, () => {
      resolve(updated);
    });
  });
}
