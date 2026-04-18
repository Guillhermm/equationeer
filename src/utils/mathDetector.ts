const MATH_PATTERNS = [
  /\\(?:frac|sqrt|sum|prod|int|lim|infty|partial|nabla|Delta|alpha|beta|gamma|theta|lambda|sigma|omega|phi|psi|mu|pi|epsilon|delta|zeta|eta|kappa|rho|tau|chi|xi)\b/,
  /\\(?:begin|end)\{(?:equation|align|matrix|bmatrix|pmatrix|cases)\}/,
  /\$[^$]+\$/,
  /\$\$[^$]+\$\$/,
  /\\[[(][^)\]]+\\[\])]/,
  /[=<>]\s*[\d\w]+\s*[+\-*/^]/,
  /\b[a-zA-Z]\s*[=]\s*[^,\s]{2,}/,
  /[\u2200-\u22FF]/,         // Mathematical Operators
  /[\u2190-\u21FF]/,         // Arrows
  /[\u2100-\u214F]/,         // Letterlike Symbols
  /[\u2070-\u209F]/,         // Superscripts and Subscripts
  /[∑∏∫∂∇√∞±×÷≤≥≠≈∈∉⊂⊃∪∩∧∨¬∀∃∅]/,
  /\^{?\d+}?/,              // Superscripts like x^2 or x^{n}
  /_{?\d+}?/,               // Subscripts like x_i or x_{ij}
];

const MIN_MATH_SCORE = 2;

export function isMathContent(text: string): boolean {
  if (!text || text.trim().length < 3) return false;

  let score = 0;
  for (const pattern of MATH_PATTERNS) {
    if (pattern.test(text)) {
      score++;
    }
  }

  // Strong indicators that almost certainly mean math
  if (/\$[^$]+\$/.test(text) || /\\frac|\\sum|\\int/.test(text)) {
    return true;
  }

  // If short text, require fewer matches
  if (text.length < 20 && score >= 1) return true;
  return score >= MIN_MATH_SCORE;
}

export function stripHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent ?? "";
}

export function getSurroundingText(selection: Selection): string {
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;

  const element =
    container.nodeType === Node.TEXT_NODE
      ? container.parentElement
      : (container as Element);

  if (!element) return "";

  const fullText = element.textContent ?? "";
  const selectedText = selection.toString();
  const idx = fullText.indexOf(selectedText);

  if (idx === -1) return fullText.slice(0, 500);

  const start = Math.max(0, idx - 250);
  const end = Math.min(fullText.length, idx + selectedText.length + 250);
  return fullText.slice(start, end);
}
