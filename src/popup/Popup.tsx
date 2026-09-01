import { useState, useEffect, useCallback } from "react";
import type { AppSettings } from "../types/messages";

/** Only what the popup needs: whether Screenshot Mode can run on this tab. */
interface PageScope {
  active: boolean;
}

export function Popup() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [scope, setScope] = useState<PageScope | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);

  const loadScope = useCallback((id: number) => {
    chrome.tabs.sendMessage(id, { type: "GET_SCOPE" }, (response?: PageScope) => {
      // No content script on this page (chrome:// pages, the Web Store, …).
      if (chrome.runtime.lastError || !response) setScope(null);
      else setScope(response);
    });
  }, []);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (s: AppSettings) => {
      if (!s) return;
      setSettings(s);
      const t = s.theme === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : s.theme;
      document.documentElement.classList.toggle("dark", t === "dark");
      document.documentElement.classList.toggle("light", t === "light");
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs[0]?.id;
      if (id === undefined) return;
      setTabId(id);
      loadScope(id);
    });
  }, [loadScope]);

  const openSidePanel = () => {
    if (tabId !== null) chrome.sidePanel.open({ tabId });
  };

  const activateScreenshot = () => {
    if (tabId === null) return;
    chrome.tabs.sendMessage(tabId, { type: "ACTIVATE_SCREENSHOT" });
    window.close();
  };

  const hasApiKey = Boolean(settings?.apiKey);
  const active = scope?.active ?? false;

  return (
    <div className="w-72 p-4 bg-eq-bg-primary">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-eq-accent text-2xl font-bold">&Sigma;</span>
        <h1 className="text-base font-semibold text-eq-text-primary">
          Equationeer
        </h1>
      </div>

      {!hasApiKey && (
        <div className="mb-3 p-2.5 rounded-lg bg-eq-error/10 border border-eq-error/30">
          <p className="text-xs text-eq-error">
            API key not set.{" "}
            <button
              onClick={() => chrome.runtime.openOptionsPage()}
              className="underline hover:text-eq-error/80"
            >
              Set it in options
            </button>
          </p>
        </div>
      )}

      <div className="space-y-3">
        <div>
          <button
            onClick={openSidePanel}
            disabled={tabId === null}
            className="w-full px-3 py-2.5 text-sm font-medium bg-eq-accent text-white rounded-lg hover:bg-eq-accent-hover disabled:opacity-40 transition-colors"
          >
            Open Explanation Panel
          </button>
          <p className="text-xs text-eq-text-secondary/60 mt-1.5 px-1">
            On a web page, highlight math and click the &ldquo;&Sigma;&thinsp;Explain&rdquo; pill. In Chrome&rsquo;s PDF viewer, use the &Sigma; button in the corner, or right-click a selection.
          </p>
        </div>

        <div>
          <button
            onClick={activateScreenshot}
            disabled={!active}
            className="w-full px-3 py-2.5 text-sm font-medium bg-eq-bg-secondary text-eq-text-primary border border-eq-border rounded-lg hover:border-eq-accent/30 disabled:opacity-40 transition-colors"
          >
            Screenshot Mode
          </button>
          <p className="text-xs text-eq-text-secondary/60 mt-1.5 px-1">
            {active
              ? "Draw a rectangle over any equation, including anything rendered as an image."
              : "Available once Equationeer is turned on for this page."}
          </p>
        </div>

        <button
          onClick={() => chrome.runtime.openOptionsPage()}
          className="w-full px-3 py-2 text-xs text-eq-text-secondary hover:text-eq-text-primary transition-colors"
        >
          Settings
        </button>
      </div>
    </div>
  );
}
