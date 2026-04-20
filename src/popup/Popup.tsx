import { useState, useEffect } from "react";

export function Popup() {
  const [hasApiKey, setHasApiKey] = useState(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
      if (settings?.apiKey) setHasApiKey(true);
      if (settings?.theme) {
        const t = settings.theme === "system"
          ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
          : settings.theme;
        document.documentElement.classList.toggle("dark", t === "dark");
        document.documentElement.classList.toggle("light", t === "light");
      }
    });
  }, []);

  const openSidePanel = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.sidePanel.open({ tabId: tabs[0].id });
      }
    });
  };

  const activateScreenshot = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "ACTIVATE_SCREENSHOT" });
        window.close();
      }
    });
  };

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
            className="w-full px-3 py-2.5 text-sm font-medium bg-eq-accent text-white rounded-lg hover:bg-eq-accent-hover transition-colors"
          >
            Open Explanation Panel
          </button>
          <p className="text-xs text-eq-text-secondary/60 mt-1.5 px-1">
            Highlight any math on a webpage or text-based PDF, then click the &ldquo;&Sigma;&thinsp;Explain&rdquo; button that appears.
          </p>
        </div>

        <div>
          <button
            onClick={activateScreenshot}
            className="w-full px-3 py-2.5 text-sm font-medium bg-eq-bg-secondary text-eq-text-primary border border-eq-border rounded-lg hover:border-eq-accent/30 transition-colors"
          >
            Screenshot Mode
          </button>
          <p className="text-xs text-eq-text-secondary/60 mt-1.5 px-1">
            For image-based equations. Open the PDF in Chrome first, then draw a rectangle over the equation.
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
