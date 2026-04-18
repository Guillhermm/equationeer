import { useState, useEffect, useRef, useCallback } from "react";
import { marked } from "marked";
import type {
  ExplanationDepth,
  StreamMessage,
  ConversationMessage,
  HistoryEntry,
  PendingExplanation,
} from "../types/messages";
import {
  saveHistoryEntry,
  getHistoryEntries,
  toggleBookmark,
  deleteHistoryEntry,
  exportHistory,
  exportHistoryAsMarkdown,
} from "../utils/storage";

type View = "explanation" | "history";

export function SidePanel() {
  const [view, setView] = useState<View>("explanation");
  const [explanation, setExplanation] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [depth, setDepth] = useState<ExplanationDepth>("undergrad");
  const [currentMath, setCurrentMath] = useState("");
  const [currentPageTitle, setCurrentPageTitle] = useState("");
  const [currentPageUrl, setCurrentPageUrl] = useState("");
  const [isImage, setIsImage] = useState(false);
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [followUpInput, setFollowUpInput] = useState("");
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const explanationRef = useRef<HTMLDivElement>(null);
  const streamingTextRef = useRef("");
  // Keep a stable ref to depth so callbacks closed over state see the latest value
  const depthRef = useRef<ExplanationDepth>(depth);
  depthRef.current = depth;

  // ── Load settings ──────────────────────────────────────────────────────────

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
      if (chrome.runtime.lastError) return;
      if (settings?.defaultDepth) setDepth(settings.defaultDepth);
      if (settings?.theme) applyTheme(settings.theme);
    });
  }, []);

  // ── Pending explanation handshake ──────────────────────────────────────────
  // The content script stores a PendingExplanation in chrome.storage.session
  // and then opens the side panel. We read it here after we're mounted.

  const executePending = useCallback((pending: PendingExplanation) => {
    console.log("[EQ:SP] executing pending:", pending.kind);
    const d = depthRef.current;

    if (pending.kind === "math" && pending.math) {
      setCurrentMath(pending.math);
      setCurrentPageTitle(pending.pageTitle);
      setCurrentPageUrl(pending.pageUrl);
      setIsImage(false);
      setExplanation("");
      setError(null);
      setConversation([]);
      setCurrentEntryId(null);
      setIsStreaming(true);
      setView("explanation");
      streamingTextRef.current = "";

      chrome.runtime.sendMessage({
        type: "EXPLAIN_MATH",
        payload: {
          math: pending.math,
          surroundingText: pending.surroundingText ?? "",
          pageTitle: pending.pageTitle,
          pageUrl: pending.pageUrl,
          depth: d,
        },
      });
    } else if (pending.kind === "image" && pending.imageDataUrl) {
      setCurrentMath("[Image-based equation]");
      setCurrentPageTitle(pending.pageTitle);
      setCurrentPageUrl(pending.pageUrl);
      setIsImage(true);
      setExplanation("");
      setError(null);
      setConversation([]);
      setCurrentEntryId(null);
      setIsStreaming(true);
      setView("explanation");
      streamingTextRef.current = "";

      chrome.runtime.sendMessage({
        type: "EXPLAIN_IMAGE",
        payload: {
          imageDataUrl: pending.imageDataUrl,
          pageTitle: pending.pageTitle,
          pageUrl: pending.pageUrl,
          depth: d,
        },
      });
    }
  }, []);

  // On mount: check if there's already a pending request
  useEffect(() => {
    chrome.storage.session.get("equationeerPending", (result) => {
      const pending = result["equationeerPending"] as PendingExplanation | undefined;
      if (pending) {
        chrome.storage.session.remove("equationeerPending");
        executePending(pending);
      }
    });
  }, [executePending]);

  // While open: listen for new pending requests (user explains another equation)
  useEffect(() => {
    const handler = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "session") return;
      const newVal = changes["equationeerPending"]?.newValue as PendingExplanation | undefined;
      if (newVal) {
        chrome.storage.session.remove("equationeerPending");
        executePending(newVal);
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [executePending]);

  // ── Stream listener ────────────────────────────────────────────────────────

  const currentMathRef = useRef(currentMath);
  const currentPageTitleRef = useRef(currentPageTitle);
  const currentPageUrlRef = useRef(currentPageUrl);
  const currentEntryIdRef = useRef(currentEntryId);
  const conversationRef = useRef(conversation);
  const isImageRef = useRef(isImage);
  currentMathRef.current = currentMath;
  currentPageTitleRef.current = currentPageTitle;
  currentPageUrlRef.current = currentPageUrl;
  currentEntryIdRef.current = currentEntryId;
  conversationRef.current = conversation;
  isImageRef.current = isImage;

  useEffect(() => {
    const handler = (message: StreamMessage) => {
      if (message.type === "STREAM_CHUNK") {
        streamingTextRef.current += message.text;
        setExplanation(streamingTextRef.current);
      } else if (message.type === "STREAM_DONE") {
        // `explanation` was only the live streaming buffer — clear it now that the
        // completed message moves into `conversation` (the single source of truth).
        setExplanation("");
        setIsStreaming(false);
        streamingTextRef.current = "";

        const id = currentEntryIdRef.current ?? crypto.randomUUID();
        setCurrentEntryId(id);
        const nextConversation = [...conversationRef.current, { role: "assistant" as const, content: message.fullText }];
        const entry: HistoryEntry = {
          id,
          math: currentMathRef.current,
          explanation: message.fullText,
          depth: depthRef.current,
          pageTitle: currentPageTitleRef.current,
          pageUrl: currentPageUrlRef.current,
          timestamp: Date.now(),
          bookmarked: false,
          conversation: nextConversation,
          isImage: isImageRef.current,
        };
        saveHistoryEntry(entry);
        setConversation(nextConversation);
      } else if (message.type === "STREAM_ERROR") {
        console.error("[EQ:SP] stream error:", message.error);
        setError(message.error);
        setIsStreaming(false);
        streamingTextRef.current = "";
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (isStreaming && explanationRef.current) {
      explanationRef.current.scrollTop = explanationRef.current.scrollHeight;
    }
  }, [explanation, isStreaming]);

  // ── Follow-up ──────────────────────────────────────────────────────────────

  const sendFollowUp = () => {
    const q = followUpInput.trim();
    if (!q || isStreaming) return;

    const newConversation: ConversationMessage[] = [...conversation, { role: "user", content: q }];
    setConversation(newConversation);
    setFollowUpInput("");
    setIsStreaming(true);
    setExplanation("");
    streamingTextRef.current = "";

    chrome.runtime.sendMessage({
      type: "FOLLOW_UP",
      payload: {
        question: q,
        conversationHistory: newConversation,
        originalMath: currentMath,
        depth,
      },
    });
  };

  const startFresh = () => {
    setExplanation(""); setConversation([]); setCurrentEntryId(null);
    setError(null); setCurrentMath(""); setIsStreaming(false);
    streamingTextRef.current = "";
  };

  const loadHistory = async () => {
    setHistory(await getHistoryEntries());
    setView("history");
  };

  const renderMarkdown = (md: string) =>
    ({ __html: marked.parse(md, { async: false }) as string });

  const depthLabels: Record<ExplanationDepth, string> = {
    grad: "Grad", undergrad: "Undergrad", curious: "Curious",
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen bg-eq-bg-primary">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-eq-border bg-eq-bg-panel">
        <div className="flex items-center gap-2">
          <span className="text-eq-accent text-xl font-bold">&Sigma;</span>
          <h1 className="text-sm font-semibold text-eq-text-primary">Equationeer</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => view === "history" ? setView("explanation") : loadHistory()}
            className="px-2 py-1 text-xs rounded bg-eq-bg-secondary text-eq-text-secondary hover:text-eq-text-primary border border-eq-border transition-colors"
            aria-label={view === "history" ? "Back" : "View history"}
          >
            {view === "history" ? "Back" : "History"}
          </button>
          <button
            onClick={() => chrome.runtime.openOptionsPage()}
            className="p-1.5 rounded text-eq-text-secondary hover:text-eq-text-primary transition-colors"
            aria-label="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </header>

      {/* Depth control */}
      {view === "explanation" && (
        <div className="flex items-center gap-1 px-4 py-2 bg-eq-bg-secondary border-b border-eq-border">
          <span className="text-xs text-eq-text-secondary mr-2">Depth:</span>
          {(["grad", "undergrad", "curious"] as ExplanationDepth[]).map((d) => (
            <button
              key={d}
              onClick={() => setDepth(d)}
              className={`px-3 py-1 text-xs rounded-full transition-colors ${
                depth === d
                  ? "bg-eq-accent text-white"
                  : "bg-eq-bg-primary text-eq-text-secondary hover:text-eq-text-primary border border-eq-border"
              }`}
            >
              {depthLabels[d]}
            </button>
          ))}
        </div>
      )}

      {/* Main content */}
      <main ref={explanationRef} className="flex-1 overflow-y-auto px-4 py-4">
        {view === "history" ? (
          <HistoryView
            history={history}
            onSelect={(entry) => {
              setCurrentMath(entry.math);
              setExplanation("");
              setConversation(entry.conversation);
              setCurrentEntryId(entry.id);
              setCurrentPageTitle(entry.pageTitle);
              setCurrentPageUrl(entry.pageUrl);
              setIsImage(entry.isImage);
              setView("explanation");
            }}
            onToggleBookmark={async (id) => { await toggleBookmark(id); loadHistory(); }}
            onDelete={async (id) => { await deleteHistoryEntry(id); loadHistory(); }}
            onExportJson={async () => downloadFile(await exportHistory(), "equationeer-history.json", "application/json")}
            onExportMd={async () => downloadFile(await exportHistoryAsMarkdown(), "equationeer-history.md", "text/markdown")}
          />
        ) : !currentMath && !isStreaming && conversation.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {currentMath && !isImage && (
              <div className="mb-3 p-3 rounded-lg bg-eq-bg-secondary border border-eq-border">
                <p className="text-xs text-eq-text-secondary mb-1">Selected equation:</p>
                <p className="text-sm font-mono text-eq-text-math break-all">
                  {currentMath.slice(0, 200)}{currentMath.length > 200 && "..."}
                </p>
              </div>
            )}

            {conversation.length > 0 && (
              <div className="space-y-3 mb-3">
                {conversation.map((msg, i) => (
                  <div
                    key={i}
                    className={`p-3 rounded-lg ${
                      msg.role === "user"
                        ? "bg-eq-accent/10 border border-eq-accent/20"
                        : "bg-eq-bg-secondary border border-eq-border"
                    }`}
                  >
                    <p className="text-xs text-eq-text-secondary mb-1">
                      {msg.role === "user" ? "You" : "Equationeer"}
                    </p>
                    <div className="text-sm markdown-body" dangerouslySetInnerHTML={renderMarkdown(msg.content)} />
                  </div>
                ))}
              </div>
            )}

            {(isStreaming || explanation) && (
              <div className="bg-eq-bg-panel rounded-lg border border-eq-border p-4">
                {isStreaming && !explanation && <SkeletonLoader />}
                {explanation && (
                  <div className="text-sm markdown-body" dangerouslySetInnerHTML={renderMarkdown(explanation)} />
                )}
                {isStreaming && explanation && (
                  <span className="inline-block w-2 h-4 bg-eq-accent animate-pulse ml-0.5" />
                )}
              </div>
            )}

            {error && (
              <div className="mt-3 p-3 rounded-lg bg-eq-error/10 border border-eq-error/30">
                <p className="text-sm text-eq-error">{error}</p>
                <button
                  onClick={() => {
                    setError(null);
                    if (currentMath && !isImage) {
                      setIsStreaming(true);
                      setExplanation("");
                      streamingTextRef.current = "";
                      chrome.runtime.sendMessage({
                        type: "EXPLAIN_MATH",
                        payload: { math: currentMath, surroundingText: "", pageTitle: currentPageTitle, pageUrl: currentPageUrl, depth },
                      });
                    }
                  }}
                  className="mt-2 px-3 py-1 text-xs bg-eq-error/20 text-eq-error rounded hover:bg-eq-error/30 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {/* Follow-up */}
      {view === "explanation" && (currentMath || conversation.length > 0) && !isStreaming && (
        <footer className="px-4 py-3 border-t border-eq-border bg-eq-bg-panel">
          <div className="flex gap-2">
            <input
              type="text"
              value={followUpInput}
              onChange={(e) => setFollowUpInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendFollowUp()}
              placeholder="Ask a follow-up question..."
              className="flex-1 px-3 py-2 text-sm bg-eq-bg-secondary border border-eq-border rounded-lg text-eq-text-primary placeholder:text-eq-text-secondary/50 focus:outline-none focus:border-eq-accent transition-colors"
              aria-label="Follow-up question"
            />
            <button
              onClick={sendFollowUp}
              disabled={!followUpInput.trim()}
              className="px-3 py-2 text-sm bg-eq-accent text-white rounded-lg hover:bg-eq-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Send
            </button>
          </div>
          <button onClick={startFresh} className="mt-2 text-xs text-eq-text-secondary hover:text-eq-text-primary transition-colors">
            Start fresh
          </button>
        </footer>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <span className="text-5xl mb-4 text-eq-accent">&Sigma;</span>
      <h2 className="text-lg font-semibold text-eq-text-primary mb-2">Ready to explain</h2>
      <p className="text-sm text-eq-text-secondary mb-4 max-w-xs">
        Select any math equation on a webpage and click the{" "}
        <span className="font-mono text-eq-text-math">&Sigma; Explain</span> button,
        or press <kbd className="px-1.5 py-0.5 rounded bg-eq-bg-secondary border border-eq-border text-xs">Alt+E</kbd>.
      </p>
      <p className="text-xs text-eq-text-secondary/60">
        For PDFs and image-based equations, use Screenshot Mode from the toolbar popup.
      </p>
    </div>
  );
}

function SkeletonLoader() {
  return (
    <div className="space-y-3">
      <p className="text-xs text-eq-text-secondary animate-pulse">Consulting the math oracle...</p>
      <div className="skeleton-line w-3/4" />
      <div className="skeleton-line w-full" />
      <div className="skeleton-line w-5/6" />
      <div className="skeleton-line w-2/3 mt-4" />
      <div className="skeleton-line w-full" />
      <div className="skeleton-line w-4/5" />
    </div>
  );
}

function HistoryView({
  history, onSelect, onToggleBookmark, onDelete, onExportJson, onExportMd,
}: {
  history: HistoryEntry[];
  onSelect: (e: HistoryEntry) => void;
  onToggleBookmark: (id: string) => void;
  onDelete: (id: string) => void;
  onExportJson: () => void;
  onExportMd: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-eq-text-primary">History</h2>
        <div className="flex gap-2">
          <button onClick={onExportJson} className="px-2 py-1 text-xs rounded bg-eq-bg-secondary text-eq-text-secondary hover:text-eq-text-primary border border-eq-border transition-colors">Export JSON</button>
          <button onClick={onExportMd} className="px-2 py-1 text-xs rounded bg-eq-bg-secondary text-eq-text-secondary hover:text-eq-text-primary border border-eq-border transition-colors">Export MD</button>
        </div>
      </div>
      {history.length === 0 ? (
        <p className="text-sm text-eq-text-secondary text-center py-8">No explanations yet.</p>
      ) : (
        <div className="space-y-2">
          {history.map((entry) => (
            <div
              key={entry.id}
              className="p-3 rounded-lg bg-eq-bg-secondary border border-eq-border hover:border-eq-accent/30 transition-colors cursor-pointer group"
              onClick={() => onSelect(entry)}
            >
              <div className="flex items-start justify-between">
                <p className="text-xs font-mono text-eq-text-math truncate flex-1 mr-2">{entry.math.slice(0, 60)}</p>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={(e) => { e.stopPropagation(); onToggleBookmark(entry.id); }} className="p-1 text-xs" aria-label="Bookmark">{entry.bookmarked ? "★" : "☆"}</button>
                  <button onClick={(e) => { e.stopPropagation(); onDelete(entry.id); }} className="p-1 text-xs text-eq-error" aria-label="Delete">&times;</button>
                </div>
              </div>
              <p className="text-xs text-eq-text-secondary mt-1">
                {entry.pageTitle.slice(0, 40)} &middot; {new Date(entry.timestamp).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function downloadFile(content: string, filename: string, mime: string) {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([content], { type: mime })),
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

function applyTheme(t: "dark" | "light" | "system") {
  const resolved = t === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : t;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("light", resolved === "light");
}
