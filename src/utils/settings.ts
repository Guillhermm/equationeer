/**
 * `chrome.storage.local` settings and the cached model catalog.
 *
 * Kept separate from storage.ts (IndexedDB history) so the content script can
 * read scope settings without bundling `idb`.
 */

import type { AppSettings } from "../types/messages";
import type { ModelCatalog } from "./models";
import { DEFAULT_MODEL } from "./models";
import type { ScopeSettings } from "./siteScope";

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  defaultDepth: "undergrad",
  theme: "dark",
  onboardingCompleted: false,
  model: DEFAULT_MODEL,
  maxTokens: 1024,
  language: "English",
  // Available everywhere, but silent: the hover pill is limited to PDFs, so an
  // ordinary page looks untouched until you ask for something.
  siteActivation: "all",
  tooltipScope: "pdf",
  siteAllowlist: [],
};

const CATALOG_KEY = "modelCatalog";

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

/** Just the scope keys, which is all the content script needs on every page load. */
export async function getScopeSettings(): Promise<ScopeSettings> {
  const { siteActivation, tooltipScope, siteAllowlist } = DEFAULT_SETTINGS;
  return new Promise((resolve) => {
    chrome.storage.local.get({ siteActivation, tooltipScope, siteAllowlist }, (result) => {
      resolve(result as ScopeSettings);
    });
  });
}

export async function getCachedModelCatalog(): Promise<ModelCatalog | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [CATALOG_KEY]: null }, (result) => {
      resolve((result?.[CATALOG_KEY] as ModelCatalog) ?? null);
    });
  });
}

export async function setCachedModelCatalog(catalog: ModelCatalog): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CATALOG_KEY]: catalog }, () => resolve());
  });
}
