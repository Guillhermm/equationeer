import { useState, useEffect, useRef, useCallback } from "react";
import { marked } from "marked";
import type {
  ExplanationDepth,
  StreamMessage,
  ConversationMessage,
  HistoryEntry,
} from "../types/messages";
import { saveHistoryEntry, getHistoryEntries, toggleBookmark, deleteHistoryEntry, exportHistory, exportHistoryAsMarkdown } from "../utils/storage";

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
  const [, setTheme] = useState<"dark" | "light">("dark");
  const explanationRef = useRef<HTMLDivElement>(null);
  const streamingTextRef = useRef("");

  // Load settings on mount
  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (settings) => {
      if (settings?.defaultDepth) setDepth(settings.defaultDepth);
      if (settings?.theme) {
        const t = settings.theme === "system"
          ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
          : settings.theme;
        setTheme(t);
        document.documentElement.classList.toggle("dark", t === "dark");
        document.documentElement.classList.toggle("light", t === "light");
      }
    });
  }, []);

  // Listen for streaming messages from background
  useEffect(() => {
    const handler = (message: StreamMessage) => {
      if (message.type === "STREAM_CHUNK") {
        streamingTextRef.current += message.text;
        setExplanation(streamingTextRef.current);
      } else if (message.type === "STREAM_DONE") {
        setExplanation(message.fullText);
        setIsStreaming(false);
        streamingTextRef.current = "";

        // Save to history
        const id = currentEntryId ?? crypto.randomUUID();
        setCurrentEntryId(id);

        const entry: HistoryEntry = {
          id,
          math: currentMath,
          explanation: message.fullText,
          depth,
          pageTitle: currentPageTitle,
          pageUrl: currentPageUrl,
          timestamp: Date.now(),
          bookmarked: false,
          conversation: [
            ...conversation,
            { role: "assistant", content: message.fullText },
          ],
          isImage,
        };
        saveHistoryEntry(entry);
        setConversation((prev) => [
          ...prev,
          { role: "assistant", content: message.fullText },
        ]);
      } else if (message.type === "STREAM_ERROR") {
        setError(message.error);
        setIsStreaming(false);
        streamingTextRef.current = "";
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [currentMath, currentPageTitle, currentPageUrl, currentEntryId, conversation, depth, isImage]);

  // Listen for explain requests from content script
  useEffect(() => {
    const handler = (message: { type: string; payload?: Record<string, unknown> }) => {
      if (message.type === "EXPLAIN_MATH" && message.payload) {
        startNewExplanation(
          message.payload.math as string,
          message.payload.pageTitle as string,
          message.payload.pageUrl as string,
          false,
        );
      }
      if (message.type === "EXPLAIN_IMAGE" && message.payload) {
        setCurrentMath("[Image-based equation]");
        setCurrentPageTitle(message.payload.pageTitle as string);
        setCurrentPageUrl(message.payload.pageUrl as string);
        setIsImage(true);
        setExplanation("");
        setError(null);
        setConversation([]);
        setCurrentEntryId(null);
        setIsStreaming(true);
        setView("explanation");
        streamingTextRef.current = "";
      }
      if (message.type === "CONTEXT_MENU_EXPLAIN" && message.payload) {
        const text = message.payload.text as string;
        if (text) {
          startNewExplanation(text, document.title, window.location.href, false);
        }
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [depth]);

  const startNewExplanation = useCallback(
    (math: string, pageTitle: string, pageUrl: string, img: boolean) => {
      setCurrentMath(math);
      setCurrentPageTitle(pageTitle);
      setCurrentPageUrl(pageUrl);
      setIsImage(img);
      setExplanation("");
      setError(null);
      setConversation([]);
      setCurrentEntryId(null);
      setIsStreaming(true);
      setView("explanation");
      streamingTextRef.current = "";
    },
    [],
  );

  // Auto-scroll during streaming
  useEffect(() => {
    if (isStreaming && explanationRef.current) {
      explanationRef.current.scrollTop = explanationRef.current.scrollHeight;
    }
  }, [explanation, isStreaming]);

  const sendFollowUp = () => {
    const q = followUpInput.trim();
    if (!q || isStreaming) return;

    const newConversation: ConversationMessage[] = [
      ...conversation,
      { role: "user", content: q },
    ];
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
    setExplanation("");
    setConversation([]);
    setCurrentEntryId(null);
    setError(null);
    setCurrentMath("");
    setIsStreaming(false);
    streamingTextRef.current = "";
  };

  const loadHistory = async () => {
    const entries = await getHistoryEntries();
    setHistory(entries);
    setView("history");
  };

  const renderMarkdown = (md: string) => {
    return { __html: marked.parse(md, { async: false }) as string };
  };

  const depthLabels: Record<ExplanationDepth, string> = {
    grad: "Grad",
    undergrad: "Undergrad",
    curious: "Curious",
  };

  return (
    <div className="flex flex-col h-screen bg-eq-bg-primary">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-eq-border bg-eq-bg-panel">
        <div className="flex items-center gap-2">
          <span className="text-eq-accent text-xl font-bold">&Sigma;</span>
          <h1 className="text-sm font-semibold text-eq-text-primary">
            Equationeer
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => (view === "history" ? setView("explanation") : loadHistory())}
            className="px-2 py-1 text-xs rounded bg-eq-bg-secondary text-eq-text-secondary hover:text-eq-text-primary border border-eq-border transition-colors"
            aria-label={view === "history" ? "Back to explanation" : "View history"}
          >
            {view === "history" ? "Back" : "History"}
          </button>
          <button
            onClick={() => chrome.runtime.openOptionsPage()}
            className="p-1.5 rounded text-eq-text-secondary hover:text-eq-text-primary transition-colors"
            aria-label="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.5 1L7.1 3.1C7.5 3.2 7.9 3.4 8.2 3.6L10.2 2.8L11.7 5.4L10 6.6C10 7 10 7.3 10 7.7L11.7 8.9L10.2 11.5L8.2 10.7C7.9 10.9 7.5 11.1 7.1 11.2L6.5 13.3H3.5L2.9 11.2C2.5 11.1 2.1 10.9 1.8 10.7L-.2 11.5L-1.7 8.9L0 7.7C0 7.3 0 7 0 6.6L-1.7 5.4L-.2 2.8L1.8 3.6C2.1 3.4 2.5 3.2 2.9 3.1L3.5 1H6.5Z" transform="translate(3 1)" stroke="currentColor" strokeWidth="1.2" fill="none"/><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
          </button>
        </div>
      </header>

      {/* Depth Control */}
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

      {/* Main Content */}
      <main ref={explanationRef} className="flex-1 overflow-y-auto px-4 py-4">
        {view === "history" ? (
          <HistoryView
            history={history}
            onSelect={(entry) => {
              setCurrentMath(entry.math);
              setExplanation(entry.explanation);
              setConversation(entry.conversation);
              setCurrentEntryId(entry.id);
              setCurrentPageTitle(entry.pageTitle);
              setCurrentPageUrl(entry.pageUrl);
              setIsImage(entry.isImage);
              setView("explanation");
            }}
            onToggleBookmark={async (id) => {
              await toggleBookmark(id);
              loadHistory();
            }}
            onDelete={async (id) => {
              await deleteHistoryEntry(id);
              loadHistory();
            }}
            onExportJson={async () => {
              const json = await exportHistory();
              downloadFile(json, "equationeer-history.json", "application/json");
            }}
            onExportMd={async () => {
              const md = await exportHistoryAsMarkdown();
              downloadFile(md, "equationeer-history.md", "text/markdown");
            }}
          />
        ) : !currentMath && !isStreaming && !explanation ? (
          <EmptyState />
        ) : (
          <>
            {/* Current math display */}
            {currentMath && !isImage && (
              <div className="mb-3 p-3 rounded-lg bg-eq-bg-secondary border border-eq-border">
                <p className="text-xs text-eq-text-secondary mb-1">Selected equation:</p>
                <p className="text-sm font-mono text-eq-text-math break-all">
                  {currentMath.slice(0, 200)}
                  {currentMath.length > 200 && "..."}
                </p>
              </div>
            )}

            {/* Conversation history */}
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
                    <div
                      className="text-sm markdown-body"
                      dangerouslySetInnerHTML={renderMarkdown(msg.content)}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Streaming/current explanation */}
            {(isStreaming || explanation) && (
              <div className="bg-eq-bg-panel rounded-lg border border-eq-border p-4">
                {isStreaming && !explanation && <SkeletonLoader />}
                {explanation && (
                  <div
                    className="text-sm markdown-body"
                    dangerouslySetInnerHTML={renderMarkdown(explanation)}
                  />
                )}
                {isStreaming && explanation && (
                  <span className="inline-block w-2 h-4 bg-eq-accent animate-pulse ml-0.5" />
                )}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mt-3 p-3 rounded-lg bg-eq-error/10 border border-eq-error/30">
                <p className="text-sm text-eq-error">{error}</p>
                <button
                  onClick={() => {
                    setError(null);
                    if (currentMath) {
                      setIsStreaming(true);
                      setExplanation("");
                      streamingTextRef.current = "";
                      chrome.runtime.sendMessage({
                        type: "EXPLAIN_MATH",
                        payload: {
                          math: currentMath,
                          surroundingText: "",
                          pageTitle: currentPageTitle,
                          pageUrl: currentPageUrl,
                          depth,
                        },
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

      {/* Follow-up input */}
      {view === "explanation" && (currentMath || explanation) && !isStreaming && (
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
          <button
            onClick={startFresh}
            className="mt-2 text-xs text-eq-text-secondary hover:text-eq-text-primary transition-colors"
          >
            Start fresh
          </button>
        </footer>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6">
      <span className="text-5xl mb-4 text-eq-accent">&Sigma;</span>
      <h2 className="text-lg font-semibold text-eq-text-primary mb-2">
        Ready to explain
      </h2>
      <p className="text-sm text-eq-text-secondary mb-4 max-w-xs">
        Select any math equation on a webpage and click the{" "}
        <span className="font-mono text-eq-text-math">&Sigma; Explain</span>{" "}
        button, or press <kbd className="px-1.5 py-0.5 rounded bg-eq-bg-secondary border border-eq-border text-xs">Alt+E</kbd>.
      </p>
      <p className="text-xs text-eq-text-secondary/60">
        You can also use the screenshot mode from the extension popup to capture image-based equations.
      </p>
    </div>
  );
}

function SkeletonLoader() {
  return (
    <div className="space-y-3">
      <p className="text-xs text-eq-text-secondary animate-pulse">
        Consulting the math oracle...
      </p>
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
  history,
  onSelect,
  onToggleBookmark,
  onDelete,
  onExportJson,
  onExportMd,
}: {
  history: HistoryEntry[];
  onSelect: (entry: HistoryEntry) => void;
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
          <button
            onClick={onExportJson}
            className="px-2 py-1 text-xs rounded bg-eq-bg-secondary text-eq-text-secondary hover:text-eq-text-primary border border-eq-border transition-colors"
          >
            Export JSON
          </button>
          <button
            onClick={onExportMd}
            className="px-2 py-1 text-xs rounded bg-eq-bg-secondary text-eq-text-secondary hover:text-eq-text-primary border border-eq-border transition-colors"
          >
            Export MD
          </button>
        </div>
      </div>

      {history.length === 0 ? (
        <p className="text-sm text-eq-text-secondary text-center py-8">
          No explanations yet. Select an equation to get started.
        </p>
      ) : (
        <div className="space-y-2">
          {history.map((entry) => (
            <div
              key={entry.id}
              className="p-3 rounded-lg bg-eq-bg-secondary border border-eq-border hover:border-eq-accent/30 transition-colors cursor-pointer group"
              onClick={() => onSelect(entry)}
            >
              <div className="flex items-start justify-between">
                <p className="text-xs font-mono text-eq-text-math truncate flex-1 mr-2">
                  {entry.math.slice(0, 60)}
                </p>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleBookmark(entry.id);
                    }}
                    className="p-1 text-xs"
                    aria-label="Toggle bookmark"
                  >
                    {entry.bookmarked ? "\u2605" : "\u2606"}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(entry.id);
                    }}
                    className="p-1 text-xs text-eq-error"
                    aria-label="Delete"
                  >
                    &times;
                  </button>
                </div>
              </div>
              <p className="text-xs text-eq-text-secondary mt-1">
                {entry.pageTitle.slice(0, 40)} &middot;{" "}
                {new Date(entry.timestamp).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function downloadFile(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
