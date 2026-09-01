/**
 * Where Equationeer is allowed to run.
 *
 * Two independent decisions, deliberately kept apart:
 *
 *  - `siteActivation`: whether the extension attaches to the page at all
 *    (selection listener, screenshot overlay, context menu entry).
 *  - `tooltipScope`: whether the floating "Σ Explain" pill appears on selection.
 *    Bounded by activation: the pill can never show on a page the extension
 *    is not active on.
 *
 * Defaults: active everywhere, pill on PDFs only, so an ordinary page looks
 * untouched while the right-click menu is still there when you want it.
 */

export type ActivationScope = "pdf" | "allowlist" | "all";
export type TooltipScope = "pdf" | "all" | "off";

export interface ScopeSettings {
  siteActivation: ActivationScope;
  tooltipScope: TooltipScope;
  siteAllowlist: string[];
}

/** What we know about the page being evaluated. */
export interface PageContext {
  isPdf: boolean;
  /** Bare hostname, lowercased, `www.` stripped. Empty for `file://` and opaque origins. */
  hostname: string;
  /** Chrome's built-in PDF viewer, where the selection pill cannot work. */
  opaqueViewer?: boolean;
}

const PDF_EMBED_SELECTOR =
  'embed[type="application/pdf"], object[type="application/pdf"], #viewer.pdfViewer, .pdfViewer';

/** True when the URL's path names a PDF, ignoring query string and fragment. */
export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return /\.pdf(?:[?#]|$)/i.test(url);
  }
}

/**
 * Detect a PDF from the live document.
 *
 * Chrome's built-in viewer reports `application/pdf` as the content type of the
 * top-level document, which covers most cases including extension-less URLs
 * such as arxiv.org/pdf/2401.12345. The URL and embed checks catch PDFs shown
 * through a plugin document or a PDF.js viewer.
 */
export function detectPdf(doc: Document, url: string): boolean {
  if (doc.contentType === "application/pdf") return true;
  if (isPdfUrl(url)) return true;
  try {
    return doc.querySelector(PDF_EMBED_SELECTOR) !== null;
  } catch {
    return false;
  }
}

/**
 * Chrome's built-in PDF viewer renders the document inside a frame owned by
 * another extension (chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai). No
 * content script can be injected there, and neither selection nor mouse events
 * reach the top-level document, so a selection-following pill is impossible on
 * these pages. They get a fixed launcher button instead.
 *
 * A PDF rendered by a page's own PDF.js viewer is ordinary DOM and reports
 * text/html, so it keeps the normal pill.
 */
export function isOpaquePdfViewer(doc: Document): boolean {
  return doc.contentType === "application/pdf";
}

/**
 * Reduce a pasted URL or a bare host to a comparable hostname.
 * Returns "" for anything without a usable host, including `file://`.
 */
export function normalizeHost(input: string): string {
  const raw = input.trim().toLowerCase();
  if (!raw) return "";

  let host = raw;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol === "file:") return "";
    host = parsed.hostname;
  } catch {
    host = raw.split("/")[0].split("?")[0].split("#")[0];
  }

  host = host.replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "");
  // A host has to contain a dot (or be localhost) to be worth storing.
  if (!host || (!host.includes(".") && host !== "localhost")) return "";
  return host;
}

/** An allowlist entry matches its own host and every subdomain of it. */
export function hostMatches(entry: string, hostname: string): boolean {
  if (!entry || !hostname) return false;
  return hostname === entry || hostname.endsWith(`.${entry}`);
}

export function isAllowlisted(allowlist: string[], hostname: string): boolean {
  return allowlist.some((entry) => hostMatches(entry, hostname));
}

/** Whether Equationeer attaches to this page at all. */
export function isExtensionActive(settings: ScopeSettings, ctx: PageContext): boolean {
  switch (settings.siteActivation) {
    case "all":
      return true;
    case "allowlist":
      return ctx.isPdf || isAllowlisted(settings.siteAllowlist, ctx.hostname);
    case "pdf":
    default:
      return ctx.isPdf;
  }
}

/** Whether the floating Explain pill appears on this page. */
export function isTooltipActive(settings: ScopeSettings, ctx: PageContext): boolean {
  if (!isExtensionActive(settings, ctx)) return false;
  if (settings.tooltipScope === "off") return false;
  if (settings.tooltipScope === "all") return true;
  return ctx.isPdf;
}
