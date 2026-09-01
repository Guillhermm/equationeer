import { describe, it, expect } from "vitest";
import {
  detectPdf,
  hostMatches,
  isAllowlisted,
  isExtensionActive,
  isOpaquePdfViewer,
  isPdfUrl,
  isTooltipActive,
  normalizeHost,
  type PageContext,
  type ScopeSettings,
} from "../../src/utils/siteScope";

const pdfOnly: ScopeSettings = { siteActivation: "pdf", tooltipScope: "pdf", siteAllowlist: [] };
const pdfPage: PageContext = { isPdf: true, hostname: "arxiv.org" };
const webPage: PageContext = { isPdf: false, hostname: "example.com" };

// ── isPdfUrl ──────────────────────────────────────────────────────────────────

describe("isPdfUrl", () => {
  it("matches a .pdf path", () => {
    expect(isPdfUrl("https://arxiv.org/pdf/2401.12345.pdf")).toBe(true);
  });

  it("ignores query string and fragment", () => {
    expect(isPdfUrl("https://example.com/paper.pdf?download=1#page=3")).toBe(true);
  });

  it("rejects a .pdf substring that is not the path suffix", () => {
    expect(isPdfUrl("https://example.com/pdf/viewer?file=a.pdf")).toBe(false);
  });

  it("matches local files", () => {
    expect(isPdfUrl("file:///Users/me/paper.PDF")).toBe(true);
  });

  it("falls back to a regex for unparseable input", () => {
    expect(isPdfUrl("not a url paper.pdf")).toBe(true);
    expect(isPdfUrl("not a url at all")).toBe(false);
  });
});

// ── detectPdf ─────────────────────────────────────────────────────────────────

function fakeDoc(contentType: string, html = ""): Document {
  const doc = document.implementation.createHTMLDocument("test");
  Object.defineProperty(doc, "contentType", { value: contentType, configurable: true });
  doc.body.innerHTML = html;
  return doc;
}

describe("detectPdf", () => {
  it("detects Chrome's PDF viewer by content type, extension-less URL included", () => {
    expect(detectPdf(fakeDoc("application/pdf"), "https://arxiv.org/pdf/2401.12345")).toBe(true);
  });

  it("detects a PDF by URL when the content type is unhelpful", () => {
    expect(detectPdf(fakeDoc("text/html"), "https://example.com/paper.pdf")).toBe(true);
  });

  it("detects an embedded PDF plugin", () => {
    const doc = fakeDoc("text/html", '<embed type="application/pdf" src="a">');
    expect(detectPdf(doc, "https://example.com/reader")).toBe(true);
  });

  it("detects a PDF.js viewer", () => {
    const doc = fakeDoc("text/html", '<div id="viewer" class="pdfViewer"></div>');
    expect(detectPdf(doc, "https://example.com/reader")).toBe(true);
  });

  it("returns false for an ordinary page", () => {
    expect(detectPdf(fakeDoc("text/html", "<p>hello</p>"), "https://example.com/")).toBe(false);
  });

  it("returns false when querySelector throws", () => {
    const doc = fakeDoc("text/html");
    doc.querySelector = () => { throw new Error("detached"); };
    expect(detectPdf(doc, "https://example.com/")).toBe(false);
  });
});

// ── isOpaquePdfViewer ─────────────────────────────────────────────────────────

describe("isOpaquePdfViewer", () => {
  it("flags Chrome's built-in viewer, where selection is unreachable", () => {
    expect(isOpaquePdfViewer(fakeDoc("application/pdf"))).toBe(true);
  });

  it("does not flag a PDF.js viewer, which is ordinary DOM", () => {
    const doc = fakeDoc("text/html", '<div id="viewer" class="pdfViewer"></div>');
    expect(isOpaquePdfViewer(doc)).toBe(false);
    // Still a PDF for scope purposes, so it keeps the pill.
    expect(detectPdf(doc, "https://example.com/reader")).toBe(true);
  });

  it("does not flag an ordinary page", () => {
    expect(isOpaquePdfViewer(fakeDoc("text/html"))).toBe(false);
  });
});

// ── normalizeHost ─────────────────────────────────────────────────────────────

describe("normalizeHost", () => {
  it("extracts the host from a full URL", () => {
    expect(normalizeHost("https://www.ArXiv.org/abs/2401.12345")).toBe("arxiv.org");
  });

  it("accepts a bare host", () => {
    expect(normalizeHost("  Example.COM  ")).toBe("example.com");
  });

  it("strips a port and a trailing dot", () => {
    expect(normalizeHost("http://example.com.:8080/x")).toBe("example.com");
  });

  it("keeps localhost", () => {
    expect(normalizeHost("http://localhost:5173/")).toBe("localhost");
  });

  it("returns empty for file URLs", () => {
    expect(normalizeHost("file:///Users/me/paper.pdf")).toBe("");
  });

  it("returns empty for empty or hostless input", () => {
    expect(normalizeHost("")).toBe("");
    expect(normalizeHost("nodots")).toBe("");
  });
});

// ── allowlist matching ────────────────────────────────────────────────────────

describe("hostMatches / isAllowlisted", () => {
  it("matches the host itself and its subdomains", () => {
    expect(hostMatches("arxiv.org", "arxiv.org")).toBe(true);
    expect(hostMatches("arxiv.org", "export.arxiv.org")).toBe(true);
  });

  it("does not match a lookalike suffix", () => {
    expect(hostMatches("arxiv.org", "notarxiv.org")).toBe(false);
  });

  it("does not match empty values", () => {
    expect(hostMatches("", "arxiv.org")).toBe(false);
    expect(hostMatches("arxiv.org", "")).toBe(false);
  });

  it("scans the whole list", () => {
    expect(isAllowlisted(["a.com", "arxiv.org"], "export.arxiv.org")).toBe(true);
    expect(isAllowlisted(["a.com"], "b.com")).toBe(false);
  });
});

// ── activation ────────────────────────────────────────────────────────────────

describe("isExtensionActive", () => {
  it("defaults to PDFs only", () => {
    expect(isExtensionActive(pdfOnly, pdfPage)).toBe(true);
    expect(isExtensionActive(pdfOnly, webPage)).toBe(false);
  });

  it("allows everything in 'all' mode", () => {
    const all: ScopeSettings = { ...pdfOnly, siteActivation: "all" };
    expect(isExtensionActive(all, webPage)).toBe(true);
  });

  it("allows PDFs plus allowlisted hosts in 'allowlist' mode", () => {
    const s: ScopeSettings = { siteActivation: "allowlist", tooltipScope: "pdf", siteAllowlist: ["example.com"] };
    expect(isExtensionActive(s, webPage)).toBe(true);
    expect(isExtensionActive(s, { isPdf: true, hostname: "other.com" })).toBe(true);
    expect(isExtensionActive(s, { isPdf: false, hostname: "other.com" })).toBe(false);
  });
});

// ── tooltip ───────────────────────────────────────────────────────────────────

describe("isTooltipActive", () => {
  it("shows on PDFs by default", () => {
    expect(isTooltipActive(pdfOnly, pdfPage)).toBe(true);
    expect(isTooltipActive(pdfOnly, webPage)).toBe(false);
  });

  it("never shows on a page the extension is not active on", () => {
    const s: ScopeSettings = { siteActivation: "pdf", tooltipScope: "all", siteAllowlist: [] };
    expect(isTooltipActive(s, webPage)).toBe(false);
  });

  it("shows everywhere active when tooltipScope is 'all'", () => {
    const s: ScopeSettings = { siteActivation: "all", tooltipScope: "all", siteAllowlist: [] };
    expect(isTooltipActive(s, webPage)).toBe(true);
  });

  it("stays off on PDFs when tooltipScope is 'off'", () => {
    const s: ScopeSettings = { siteActivation: "all", tooltipScope: "off", siteAllowlist: [] };
    expect(isTooltipActive(s, pdfPage)).toBe(false);
  });

  it("stays PDF-limited on an active non-PDF site", () => {
    const s: ScopeSettings = { siteActivation: "all", tooltipScope: "pdf", siteAllowlist: [] };
    expect(isTooltipActive(s, webPage)).toBe(false);
    expect(isTooltipActive(s, pdfPage)).toBe(true);
  });
});
