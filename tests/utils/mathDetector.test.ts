import { describe, it, expect } from "vitest";
import { isMathContent, stripHtml, getSurroundingText } from "../../src/utils/mathDetector";

describe("isMathContent", () => {
  it("returns false for empty string", () => {
    expect(isMathContent("")).toBe(false);
  });

  it("returns false for very short text", () => {
    expect(isMathContent("ab")).toBe(false);
  });

  it("detects LaTeX inline math", () => {
    expect(isMathContent("$E = mc^2$")).toBe(true);
  });

  it("detects LaTeX display math", () => {
    expect(isMathContent("$$\\frac{a}{b} = c$$")).toBe(true);
  });

  it("detects \\frac command", () => {
    expect(isMathContent("\\frac{d}{dx}f(x)")).toBe(true);
  });

  it("detects \\sum command", () => {
    expect(isMathContent("\\sum_{i=1}^{n} x_i")).toBe(true);
  });

  it("detects \\int command", () => {
    expect(isMathContent("\\int_0^\\infty e^{-x} dx")).toBe(true);
  });

  it("detects Unicode math operators", () => {
    expect(isMathContent("∑ xᵢ ∈ ℝ")).toBe(true);
  });

  it("detects Greek letters combined with math operators", () => {
    // α is not in the math operator range, but ≈ is — together they score ≥ 2
    expect(isMathContent("α + β ≈ γ")).toBe(true);
  });

  it("detects superscript notation", () => {
    // Short text with a superscript pattern should still qualify
    expect(isMathContent("x^2")).toBe(true);
  });

  it("detects subscript notation with digit", () => {
    // _{digit} pattern matches; string is also <20 chars so score≥1 suffices
    expect(isMathContent("x_1 + x_2")).toBe(true);
  });

  it("detects equation with operators", () => {
    expect(isMathContent("a = b + c * d")).toBe(true);
  });

  it("returns false for plain prose", () => {
    expect(isMathContent("The quick brown fox jumps over the lazy dog.")).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(isMathContent("   ")).toBe(false);
  });

  it("detects \\begin{equation}", () => {
    expect(isMathContent("\\begin{equation}x=y\\end{equation}")).toBe(true);
  });

  it("detects ∀ quantifier", () => {
    expect(isMathContent("∀x ∈ ℝ")).toBe(true);
  });

  it("returns true for short text with one math indicator", () => {
    // text.length < 20 && score >= 1 → true
    expect(isMathContent("y = x²")).toBe(true);
  });
});

describe("getSurroundingText", () => {
  function makeFakeSelection(containerText: string, selectedText: string, useTextNode = false): Selection {
    const div = document.createElement("div");
    div.textContent = containerText;
    document.body.appendChild(div);

    const textNode = div.firstChild as Text;
    const range = document.createRange();
    if (useTextNode && textNode) {
      range.selectNodeContents(textNode);
    } else {
      range.selectNodeContents(div);
    }

    const fakeSel = {
      getRangeAt: () => ({
        commonAncestorContainer: useTextNode ? textNode : div,
      }),
      toString: () => selectedText,
    } as unknown as Selection;

    document.body.removeChild(div);
    return fakeSel;
  }

  it("returns surrounding text around the selected substring", () => {
    const text = "The integral ∫f(x)dx measures the area under the curve.";
    const sel = makeFakeSelection(text, "∫f(x)dx");
    const result = getSurroundingText(sel);
    expect(result).toContain("∫f(x)dx");
    expect(result).toContain("integral");
  });

  it("works when container is a text node", () => {
    const text = "E = mc^2 represents energy-mass equivalence.";
    const sel = makeFakeSelection(text, "mc^2", true);
    const result = getSurroundingText(sel);
    expect(result).toContain("mc^2");
  });

  it("returns up to 500 chars when selected text not found in container", () => {
    const longText = "x".repeat(600);
    const sel = {
      getRangeAt: () => ({
        commonAncestorContainer: Object.assign(document.createElement("div"), { textContent: longText }),
      }),
      toString: () => "NOT_PRESENT",
    } as unknown as Selection;
    const result = getSurroundingText(sel);
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("returns empty string when text node has no parent (orphaned)", () => {
    // Simulate a text node detached from any parent element
    const orphanedText = document.createTextNode("orphaned text");
    // parentElement is null since it's not in the DOM
    const sel = {
      getRangeAt: () => ({ commonAncestorContainer: orphanedText }),
      toString: () => "orphaned",
    } as unknown as Selection;
    const result = getSurroundingText(sel);
    expect(result).toBe("");
  });
});

describe("stripHtml", () => {
  it("removes HTML tags", () => {
    expect(stripHtml("<p>Hello</p>")).toBe("Hello");
  });

  it("removes nested tags", () => {
    expect(stripHtml("<div><span>Math: <b>x²</b></span></div>")).toBe("Math: x²");
  });

  it("returns plain text unchanged", () => {
    expect(stripHtml("E = mc^2")).toBe("E = mc^2");
  });

  it("handles empty string", () => {
    expect(stripHtml("")).toBe("");
  });

  it("strips script tags", () => {
    const result = stripHtml("<script>alert('xss')</script>hello");
    expect(result).not.toContain("<script>");
    expect(result).toContain("hello");
  });
});
