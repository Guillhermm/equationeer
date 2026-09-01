import { useState, useEffect } from "react";
import { marked } from "marked";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { AppSettings, ExplanationDepth } from "../types/messages";
import {
  BUNDLED_MODELS,
  DEFAULT_MODEL,
  MAX_OUTPUT_CEILING,
  describeModel,
  findModel,
  type ModelCatalog,
} from "../utils/models";
import { DEFAULT_SETTINGS } from "../utils/settings";
import { normalizeHost, type ActivationScope, type TooltipScope } from "../utils/siteScope";

function renderLatex(text: string): string {
  const render = (math: string, displayMode: boolean, fallback: string): string => {
    try {
      return katex.renderToString(math.trim(), { displayMode, throwOnError: false, output: "html" });
    } catch {
      return fallback;
    }
  };
  let result = text;
  result = result.replace(
    /\\begin\{(equation|align|aligned|gather|multline|eqnarray)\*?\}([\s\S]+?)\\end\{(?:equation|align|aligned|gather|multline|eqnarray)\*?\}/g,
    (match) => render(match, true, match),
  );
  result = result.replace(/\\\[([\s\S]+?)\\\]/g, (match, math: string) => render(math, true, match));
  result = result.replace(/\$\$([\s\S]+?)\$\$/g, (match, math: string) => render(math, true, match));
  result = result.replace(/\\\((.+?)\\\)/gs, (match, math: string) => render(math, false, match));
  result = result.replace(/\$([^$\n]+?)\$/g, (match, math: string) => render(math, false, match));
  return result;
}

function renderMarkdown(md: string): { __html: string } {
  return { __html: marked.parse(renderLatex(md), { async: false }) as string };
}

const MOCK_EXPLANATION = `## What This Represents
This is the Euler identity, widely considered the most beautiful equation in mathematics. It links five fundamental constants: $e$, $i$, $\\pi$, $1$, and $0$.

## Term-by-Term Breakdown
- **e** \u2014 Euler's number ($\\approx 2.718$), the base of natural logarithms
- **i** \u2014 The imaginary unit, defined as $\\sqrt{-1}$
- **\u03C0** \u2014 Pi ($\\approx 3.14159$), the ratio of a circle's circumference to its diameter
- **+1** \u2014 The multiplicative identity
- **= 0** \u2014 The additive identity

## The Intuition
Imagine walking along the unit circle in the complex plane. Starting at $1$, if you rotate by $\\pi$ radians (half a full turn), you arrive at $-1$. Adding $1$ gives $0$. The equation encodes this geometric fact algebraically.

## Key Assumptions
Relies on the extension of the exponential function to complex numbers via the Taylor series.

## Related Concepts
- **Euler's Formula** \u2014 The general form: $e^{ix} = \\cos(x) + i \\cdot \\sin(x)$
- **Complex Plane** \u2014 The 2D number system where real and imaginary parts form axes
- **Taylor Series** \u2014 The infinite polynomial expansion that connects $e^x$ to trig functions`;

const ACTIVATION_OPTIONS: { value: ActivationScope; label: string; desc: string }[] = [
  { value: "pdf", label: "PDFs only", desc: "Every other page behaves as if the extension were not installed" },
  { value: "allowlist", label: "PDFs + chosen sites", desc: "Add a site from the toolbar popup, or below" },
  { value: "all", label: "All pages", desc: "Equationeer attaches everywhere" },
];

const TOOLTIP_OPTIONS: { value: TooltipScope; label: string; desc: string }[] = [
  { value: "pdf", label: "PDFs only", desc: "The pill appears when reading a PDF" },
  { value: "all", label: "Everywhere active", desc: "The pill appears on every page Equationeer runs on" },
  { value: "off", label: "Never", desc: "Use the right-click menu instead of a hover button" },
];

const MAX_TOKEN_OPTIONS = [512, 1024, 1500, 2048, 0] as const;
const tokenLabel = (n: number) => n === 0 ? "Max" : String(n);

const LANGUAGES = [
  "English", "Portuguese", "Spanish", "French", "German",
  "Italian", "Chinese", "Japanese", "Korean", "Arabic",
];

export function Options() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [newSite, setNewSite] = useState("");
  const [step, setStep] = useState(0);
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [keyValid, setKeyValid] = useState<boolean | null>(null);
  const [showMockDemo, setShowMockDemo] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (s: AppSettings) => {
      if (s) {
        setSettings(s);
        if (s.onboardingCompleted) setStep(99);
      }
      applyTheme(s?.theme ?? "dark");
    });
    chrome.runtime.sendMessage({ type: "GET_MODELS" }, (c: ModelCatalog) => {
      if (c?.models?.length) setCatalog(c);
    });
  }, []);

  const refreshModels = () => {
    setRefreshingModels(true);
    chrome.runtime.sendMessage({ type: "GET_MODELS", payload: { force: true } }, (c: ModelCatalog) => {
      setRefreshingModels(false);
      if (c?.models?.length) setCatalog(c);
    });
  };

  const addSite = () => {
    const host = normalizeHost(newSite);
    if (!host || settings.siteAllowlist.includes(host)) { setNewSite(""); return; }
    setSettings((s) => ({ ...s, siteAllowlist: [...s.siteAllowlist, host].sort() }));
    setNewSite("");
  };

  const removeSite = (host: string) => {
    setSettings((s) => ({ ...s, siteAllowlist: s.siteAllowlist.filter((h) => h !== host) }));
  };

  const applyTheme = (t: string) => {
    const resolved = t === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : t;
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.classList.toggle("light", resolved === "light");
  };

  const saveAndUpdate = (partial: Partial<AppSettings>) => {
    const updated = { ...settings, ...partial };
    setSettings(updated);
    chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", payload: partial });
    if (partial.theme) applyTheme(partial.theme);
  };

  const validateKey = async () => {
    setValidating(true);
    setKeyValid(null);
    chrome.runtime.sendMessage(
      { type: "VALIDATE_API_KEY", payload: { apiKey: settings.apiKey } },
      (res: { valid: boolean }) => {
        setValidating(false);
        setKeyValid(res?.valid ?? false);
        if (res?.valid) {
          saveAndUpdate({ apiKey: settings.apiKey });
          // The catalog needs a key; the first fetch on install had none.
          refreshModels();
        }
      },
    );
  };

  const finishOnboarding = () => {
    saveAndUpdate({ onboardingCompleted: true });
    setStep(99);
  };

  const handleSave = () => {
    saveAndUpdate(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Onboarding mode
  if (step < 99 && !settings.onboardingCompleted) {
    return (
      <div className="min-h-screen bg-eq-bg-primary flex items-center justify-center p-8">
        <div className="max-w-md w-full">
          <div className="text-center mb-8">
            <span className="text-6xl text-eq-accent">&Sigma;</span>
            <h1 className="text-2xl font-semibold text-eq-text-primary mt-3">Welcome to Equationeer</h1>
            <p className="text-sm text-eq-text-secondary mt-1">Your math explanation companion</p>
          </div>

          <div className="flex items-center justify-center gap-2 mb-8">
            {[0, 1, 2, 3, 4].map((s) => (
              <div key={s} className={`h-1.5 rounded-full transition-all ${s <= step ? "bg-eq-accent w-8" : "bg-eq-border w-4"}`} />
            ))}
          </div>

          <div className="bg-eq-bg-panel rounded-xl border border-eq-border p-6">
            {step === 0 && (
              <div>
                <h2 className="text-lg font-semibold text-eq-text-primary mb-2">Step 1: API Key</h2>
                <p className="text-sm text-eq-text-secondary mb-4">
                  Enter your Anthropic API key. Stored locally, never shared except with the Claude API.
                </p>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={settings.apiKey}
                    onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                    placeholder="sk-ant-..."
                    className="w-full px-3 py-2.5 text-sm bg-eq-bg-secondary border border-eq-border rounded-lg text-eq-text-primary placeholder:text-eq-text-secondary/40 focus:outline-none focus:border-eq-accent pr-20"
                  />
                  <button onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-eq-text-secondary hover:text-eq-text-primary">
                    {showKey ? "Hide" : "Show"}
                  </button>
                </div>
                <button onClick={validateKey} disabled={!settings.apiKey || validating} className="mt-3 w-full px-3 py-2 text-sm bg-eq-accent text-white rounded-lg hover:bg-eq-accent-hover disabled:opacity-40 transition-colors">
                  {validating ? "Validating..." : "Validate Key"}
                </button>
                {keyValid === true && <p className="mt-2 text-sm text-eq-success flex items-center gap-1"><span>&#x2714;</span> Key is valid</p>}
                {keyValid === false && <p className="mt-2 text-sm text-eq-error">Invalid key. Please check and try again.</p>}
                <button onClick={() => setStep(1)} disabled={keyValid !== true} className="mt-4 w-full px-3 py-2 text-sm bg-eq-bg-secondary text-eq-text-primary border border-eq-border rounded-lg hover:border-eq-accent/30 disabled:opacity-40 transition-colors">
                  Next
                </button>
              </div>
            )}

            {step === 1 && (
              <div>
                <h2 className="text-lg font-semibold text-eq-text-primary mb-2">Step 2: Explanation Depth</h2>
                <p className="text-sm text-eq-text-secondary mb-4">Choose your default level. You can change this anytime.</p>
                <div className="space-y-2">
                  {([["grad", "ELI-Grad", "For grad students in the field"], ["undergrad", "ELI-Undergrad", "Solid calculus/linear algebra background"], ["curious", "ELI-Curious", "Smart non-specialist, intuitive language"]] as [ExplanationDepth, string, string][]).map(([value, label, desc]) => (
                    <label key={value} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${settings.defaultDepth === value ? "border-eq-accent bg-eq-accent/5" : "border-eq-border hover:border-eq-accent/30"}`}>
                      <input type="radio" name="depth" value={value} checked={settings.defaultDepth === value} onChange={() => saveAndUpdate({ defaultDepth: value })} className="mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-eq-text-primary">{label}</p>
                        <p className="text-xs text-eq-text-secondary">{desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
                <button onClick={() => setStep(2)} className="mt-4 w-full px-3 py-2 text-sm bg-eq-accent text-white rounded-lg hover:bg-eq-accent-hover transition-colors">Next</button>
              </div>
            )}

            {step === 2 && (
              <div>
                <h2 className="text-lg font-semibold text-eq-text-primary mb-2">Step 3: Theme</h2>
                <div className="flex gap-2">
                  {(["dark", "light", "system"] as const).map((t) => (
                    <button key={t} onClick={() => saveAndUpdate({ theme: t })} className={`flex-1 px-3 py-2.5 text-sm rounded-lg border capitalize transition-colors ${settings.theme === t ? "border-eq-accent bg-eq-accent/10 text-eq-text-primary" : "border-eq-border text-eq-text-secondary hover:border-eq-accent/30"}`}>
                      {t}
                    </button>
                  ))}
                </div>
                <button onClick={() => setStep(3)} className="mt-4 w-full px-3 py-2 text-sm bg-eq-accent text-white rounded-lg hover:bg-eq-accent-hover transition-colors">Next</button>
              </div>
            )}

            {step === 3 && (
              <div>
                <h2 className="text-lg font-semibold text-eq-text-primary mb-2">Step 4: Where It Runs</h2>
                <p className="text-sm text-eq-text-secondary mb-4">
                  Equationeer stays out of the way by default: it only wakes up on PDFs. Widen it here or in Settings at any time.
                </p>
                <div className="space-y-2">
                  {ACTIVATION_OPTIONS.map(({ value, label, desc }) => (
                    <label key={value} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${settings.siteActivation === value ? "border-eq-accent bg-eq-accent/5" : "border-eq-border hover:border-eq-accent/30"}`}>
                      <input type="radio" name="onboarding-activation" value={value} checked={settings.siteActivation === value} onChange={() => saveAndUpdate({ siteActivation: value })} className="mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-eq-text-primary">{label}</p>
                        <p className="text-xs text-eq-text-secondary">{desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
                <button onClick={() => setStep(4)} className="mt-4 w-full px-3 py-2 text-sm bg-eq-accent text-white rounded-lg hover:bg-eq-accent-hover transition-colors">Next</button>
              </div>
            )}

            {step === 4 && (
              <div>
                <h2 className="text-lg font-semibold text-eq-text-primary mb-2">Step 5: Try It Out</h2>
                <p className="text-sm text-eq-text-secondary mb-4">Here's what an explanation looks like:</p>
                <div className="mb-4 p-3 rounded-lg bg-eq-bg-secondary border border-eq-border">
                  <p className="text-xs text-eq-text-secondary mb-1">Selected equation:</p>
                  <div
                    className="overflow-x-auto"
                    dangerouslySetInnerHTML={{ __html: renderLatex("$e^{i\\pi} + 1 = 0$") }}
                  />
                </div>
                {!showMockDemo ? (
                  <button onClick={() => setShowMockDemo(true)} className="w-full px-3 py-2.5 text-sm bg-eq-accent text-white rounded-lg hover:bg-eq-accent-hover transition-colors">
                    &Sigma; Explain (Demo)
                  </button>
                ) : (
                  <div className="mt-3 p-4 rounded-lg bg-eq-bg-panel border border-eq-border max-h-64 overflow-y-auto">
                    <div className="text-sm markdown-body" dangerouslySetInnerHTML={renderMarkdown(MOCK_EXPLANATION)} />
                  </div>
                )}
                <button onClick={finishOnboarding} className="mt-4 w-full px-3 py-2 text-sm bg-eq-accent text-white rounded-lg hover:bg-eq-accent-hover transition-colors">
                  Done, Start Using Equationeer
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Settings mode (post-onboarding)
  const models = catalog?.models ?? BUNDLED_MODELS;
  const modelStillAvailable = Boolean(findModel(models, settings.model));
  const catalogNote = catalog?.source === "live"
    ? `Updated ${new Date(catalog.fetchedAt).toLocaleDateString()}`
    : "Built-in list. Add a valid API key to read the live one";

  return (
    <div className="min-h-screen bg-eq-bg-primary p-8">
      <div className="max-w-lg mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <span className="text-3xl text-eq-accent">&Sigma;</span>
          <h1 className="text-xl font-semibold text-eq-text-primary">Equationeer Settings</h1>
        </div>

        <div className="space-y-6">
          {/* API Key */}
          <section className="bg-eq-bg-panel rounded-xl border border-eq-border p-5">
            <h2 className="text-sm font-semibold text-eq-text-primary mb-3">API Key</h2>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={settings.apiKey}
                onChange={(e) => setSettings((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder="sk-ant-..."
                className="w-full px-3 py-2 text-sm bg-eq-bg-secondary border border-eq-border rounded-lg text-eq-text-primary placeholder:text-eq-text-secondary/40 focus:outline-none focus:border-eq-accent pr-16"
              />
              <button onClick={() => setShowKey(!showKey)} className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-eq-text-secondary hover:text-eq-text-primary">
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
            <p className="mt-2 text-xs text-eq-text-secondary">Stored locally in Chrome. Never shared except with the Anthropic API.</p>
          </section>

          {/* Where it runs */}
          <section className="bg-eq-bg-panel rounded-xl border border-eq-border p-5">
            <h2 className="text-sm font-semibold text-eq-text-primary mb-1">Where Equationeer Runs</h2>
            <p className="text-xs text-eq-text-secondary mb-3">
              By default Equationeer stays out of the way everywhere except PDFs.
            </p>

            <p className="text-xs font-medium text-eq-text-primary mb-2">Active on</p>
            <div className="space-y-2">
              {ACTIVATION_OPTIONS.map(({ value, label, desc }) => (
                <label key={value} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${settings.siteActivation === value ? "border-eq-accent bg-eq-accent/5" : "border-eq-border hover:border-eq-accent/30"}`}>
                  <input type="radio" name="activation" value={value} checked={settings.siteActivation === value} onChange={() => setSettings((s) => ({ ...s, siteActivation: value }))} className="mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-eq-text-primary">{label}</p>
                    <p className="text-xs text-eq-text-secondary">{desc}</p>
                  </div>
                </label>
              ))}
            </div>

            {settings.siteActivation === "allowlist" && (
              <div className="mt-3 pt-3 border-t border-eq-border">
                <p className="text-xs font-medium text-eq-text-primary mb-2">Allowed sites</p>
                <div className="flex gap-2">
                  <input
                    value={newSite}
                    onChange={(e) => setNewSite(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addSite(); }}
                    placeholder="arxiv.org"
                    className="flex-1 px-3 py-2 text-sm bg-eq-bg-secondary border border-eq-border rounded-lg text-eq-text-primary placeholder:text-eq-text-secondary/40 focus:outline-none focus:border-eq-accent"
                  />
                  <button onClick={addSite} className="px-3 py-2 text-sm rounded-lg border border-eq-border text-eq-text-primary hover:border-eq-accent/40 transition-colors">
                    Add
                  </button>
                </div>
                {settings.siteAllowlist.length === 0 ? (
                  <p className="mt-2 text-xs text-eq-text-secondary/60">No sites yet. Subdomains of an entry are included.</p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {settings.siteAllowlist.map((host) => (
                      <li key={host} className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-md bg-eq-bg-secondary border border-eq-border">
                        <span className="text-xs text-eq-text-primary truncate">{host}</span>
                        <button onClick={() => removeSite(host)} aria-label={`Remove ${host}`} className="text-xs text-eq-text-secondary hover:text-eq-error transition-colors">
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="mt-4 pt-3 border-t border-eq-border">
              <p className="text-xs font-medium text-eq-text-primary mb-2">Hover &ldquo;&Sigma; Explain&rdquo; button</p>
              <div className="space-y-2">
                {TOOLTIP_OPTIONS.map(({ value, label, desc }) => (
                  <label key={value} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${settings.tooltipScope === value ? "border-eq-accent bg-eq-accent/5" : "border-eq-border hover:border-eq-accent/30"}`}>
                    <input type="radio" name="tooltip" value={value} checked={settings.tooltipScope === value} onChange={() => setSettings((s) => ({ ...s, tooltipScope: value }))} className="mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-eq-text-primary">{label}</p>
                      <p className="text-xs text-eq-text-secondary">{desc}</p>
                    </div>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-eq-text-secondary/60">
                The pill never appears on a page Equationeer is not active on.
              </p>
            </div>
          </section>

          {/* Model */}
          <section className="bg-eq-bg-panel rounded-xl border border-eq-border p-5">
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="text-sm font-semibold text-eq-text-primary">Claude Model</h2>
              <button
                onClick={refreshModels}
                disabled={refreshingModels}
                className="px-2 py-1 text-xs rounded-md border border-eq-border text-eq-text-secondary hover:text-eq-text-primary hover:border-eq-accent/40 disabled:opacity-40 transition-colors"
              >
                {refreshingModels ? "Refreshing…" : "Refresh list"}
              </button>
            </div>
            <p className="text-xs text-eq-text-secondary mb-3">
              Read live from the Anthropic Models API with your key, newest first, so new models appear here without updating the extension.
            </p>
            <div className="space-y-2">
              {models.map((m) => (
                <label key={m.id} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${settings.model === m.id ? "border-eq-accent bg-eq-accent/5" : "border-eq-border hover:border-eq-accent/30"}`}>
                  <input type="radio" name="model" value={m.id} checked={settings.model === m.id} onChange={() => setSettings((s) => ({ ...s, model: m.id }))} className="mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-eq-text-primary">{m.displayName}</p>
                    <p className="text-xs text-eq-text-secondary">{describeModel(m)}</p>
                    <p className="text-xs text-eq-text-secondary/50 mt-0.5 truncate">
                      {m.id}
                      {m.supportsImages ? "" : " · no image input, Screenshot Mode unavailable"}
                    </p>
                  </div>
                </label>
              ))}
            </div>
            {!modelStillAvailable && (
              <p className="mt-2 text-xs text-eq-error">
                The selected model ({settings.model}) is not in the current list. Pick another, or Equationeer falls back to {DEFAULT_MODEL}.
              </p>
            )}
            <p className="mt-2 text-xs text-eq-text-secondary/60">
              {catalogNote} · Pricing at console.anthropic.com
            </p>
          </section>

          {/* Max Tokens */}
          <section className="bg-eq-bg-panel rounded-xl border border-eq-border p-5">
            <h2 className="text-sm font-semibold text-eq-text-primary mb-1">Response Length</h2>
            <p className="text-xs text-eq-text-secondary mb-3">Maximum tokens per explanation. Lower = cheaper &amp; faster; &ldquo;Max&rdquo; uses the model&rsquo;s limit, capped at {MAX_OUTPUT_CEILING.toLocaleString()}.</p>
            <div className="flex gap-2">
              {MAX_TOKEN_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => setSettings((s) => ({ ...s, maxTokens: n }))}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${settings.maxTokens === n ? "border-eq-accent bg-eq-accent/10 text-eq-text-primary" : "border-eq-border text-eq-text-secondary hover:border-eq-accent/30"}`}
                >
                  {tokenLabel(n)}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-eq-text-secondary/60">
              Selected: {settings.maxTokens === 0 ? `Max (${MAX_OUTPUT_CEILING.toLocaleString()} tokens)` : `${settings.maxTokens} tokens`}
            </p>
          </section>

          {/* Default Depth */}
          <section className="bg-eq-bg-panel rounded-xl border border-eq-border p-5">
            <h2 className="text-sm font-semibold text-eq-text-primary mb-3">Default Explanation Depth</h2>
            <div className="flex gap-2">
              {(["grad", "undergrad", "curious"] as ExplanationDepth[]).map((d) => (
                <button key={d} onClick={() => setSettings((s) => ({ ...s, defaultDepth: d }))} className={`flex-1 px-3 py-2 text-sm rounded-lg border capitalize transition-colors ${settings.defaultDepth === d ? "border-eq-accent bg-eq-accent/10 text-eq-text-primary" : "border-eq-border text-eq-text-secondary hover:border-eq-accent/30"}`}>
                  {d}
                </button>
              ))}
            </div>
          </section>

          {/* Language */}
          <section className="bg-eq-bg-panel rounded-xl border border-eq-border p-5">
            <h2 className="text-sm font-semibold text-eq-text-primary mb-1">Response Language</h2>
            <p className="text-xs text-eq-text-secondary mb-3">Claude will write explanations in the selected language.</p>
            <select
              value={settings.language}
              onChange={(e) => setSettings((s) => ({ ...s, language: e.target.value }))}
              className="w-full px-3 py-2 text-sm bg-eq-bg-secondary border border-eq-border rounded-lg text-eq-text-primary focus:outline-none focus:border-eq-accent"
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </section>

          {/* Theme */}
          <section className="bg-eq-bg-panel rounded-xl border border-eq-border p-5">
            <h2 className="text-sm font-semibold text-eq-text-primary mb-3">Theme</h2>
            <div className="flex gap-2">
              {(["dark", "light", "system"] as const).map((t) => (
                <button key={t} onClick={() => setSettings((s) => ({ ...s, theme: t }))} className={`flex-1 px-3 py-2 text-sm rounded-lg border capitalize transition-colors ${settings.theme === t ? "border-eq-accent bg-eq-accent/10 text-eq-text-primary" : "border-eq-border text-eq-text-secondary hover:border-eq-accent/30"}`}>
                  {t}
                </button>
              ))}
            </div>
          </section>

          <button onClick={handleSave} className="w-full px-4 py-2.5 text-sm font-medium bg-eq-accent text-white rounded-lg hover:bg-eq-accent-hover transition-colors">
            {saved ? "Saved!" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
