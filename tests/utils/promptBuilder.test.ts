import { describe, it, expect } from "vitest";
import {
  buildExplanationPrompt,
  buildImageExplanationPrompt,
  buildFollowUpPrompt,
} from "../../src/utils/promptBuilder";

describe("buildExplanationPrompt", () => {
  const base = {
    math: "E = mc^2",
    surroundingText: "Einstein's famous equation",
    pageTitle: "Physics 101",
    depth: "undergrad" as const,
  };

  it("includes the equation in the prompt", () => {
    expect(buildExplanationPrompt(base)).toContain("E = mc^2");
  });

  it("includes surrounding context", () => {
    expect(buildExplanationPrompt(base)).toContain("Einstein's famous equation");
  });

  it("includes page title", () => {
    expect(buildExplanationPrompt(base)).toContain("Physics 101");
  });

  it("includes correct depth label for grad", () => {
    const p = buildExplanationPrompt({ ...base, depth: "grad" });
    expect(p).toContain("ELI-Grad");
  });

  it("includes correct depth label for undergrad", () => {
    expect(buildExplanationPrompt(base)).toContain("ELI-Undergrad");
  });

  it("includes correct depth label for curious", () => {
    const p = buildExplanationPrompt({ ...base, depth: "curious" });
    expect(p).toContain("ELI-Curious");
  });

  it("truncates math longer than 2000 chars", () => {
    const longMath = "x".repeat(3000);
    const p = buildExplanationPrompt({ ...base, math: longMath });
    // The equation section must only contain 2000 chars of math
    expect(p).toContain("x".repeat(2000));
    expect(p).not.toContain("x".repeat(2001));
  });

  it("truncates surroundingText longer than 500 chars", () => {
    const longCtx = "a".repeat(700);
    const p = buildExplanationPrompt({ ...base, surroundingText: longCtx });
    expect(p).toContain("a".repeat(500));
    expect(p).not.toContain("a".repeat(501));
  });

  it("includes all required section headers", () => {
    const p = buildExplanationPrompt(base);
    expect(p).toContain("## What This Represents");
    expect(p).toContain("## Term-by-Term Breakdown");
    expect(p).toContain("## The Intuition");
    expect(p).toContain("## Key Assumptions");
    expect(p).toContain("## Real-World Analogy");
    expect(p).toContain("## Related Concepts");
  });

  it("returns a string", () => {
    expect(typeof buildExplanationPrompt(base)).toBe("string");
  });

  it("includes language instruction when not English", () => {
    const p = buildExplanationPrompt({ ...base, language: "Portuguese" });
    expect(p).toContain("Portuguese");
    expect(p).toContain("IMPORTANT");
  });

  it("does not include language instruction for English", () => {
    const p = buildExplanationPrompt({ ...base, language: "English" });
    expect(p).not.toContain("IMPORTANT");
  });

  it("includes domain hint when pageUrl is valid", () => {
    const p = buildExplanationPrompt({ ...base, pageUrl: "https://arxiv.org/abs/1234" });
    expect(p).toContain("arxiv.org");
  });

  it("omits domain hint for empty pageUrl", () => {
    const p = buildExplanationPrompt({ ...base, pageUrl: "" });
    expect(p).not.toContain("page_domain");
  });

  it("includes documentText in prompt when provided", () => {
    const p = buildExplanationPrompt({ ...base, documentText: "This is the full document context." });
    expect(p).toContain("document_excerpt");
    expect(p).toContain("This is the full document context.");
  });

  it("omits document_excerpt when documentText is not provided", () => {
    const p = buildExplanationPrompt({ ...base });
    expect(p).not.toContain("document_excerpt");
  });
});

describe("buildImageExplanationPrompt", () => {
  it("includes the page title", () => {
    const p = buildImageExplanationPrompt({ pageTitle: "ML Paper", depth: "grad" });
    expect(p).toContain("ML Paper");
  });

  it("includes depth label", () => {
    expect(buildImageExplanationPrompt({ pageTitle: "t", depth: "curious" })).toContain("ELI-Curious");
  });

  it("includes all section headers", () => {
    const p = buildImageExplanationPrompt({ pageTitle: "t", depth: "undergrad" });
    expect(p).toContain("## What This Represents");
    expect(p).toContain("## Related Concepts");
  });

  it("mentions screenshot/image", () => {
    const p = buildImageExplanationPrompt({ pageTitle: "t", depth: "grad" });
    expect(p.toLowerCase()).toMatch(/image|screenshot/);
  });

  it("includes language instruction when not English", () => {
    const p = buildImageExplanationPrompt({ pageTitle: "t", depth: "grad", language: "Spanish" });
    expect(p).toContain("Spanish");
  });

  it("includes domain hint for valid pageUrl", () => {
    const p = buildImageExplanationPrompt({ pageTitle: "t", depth: "grad", pageUrl: "https://nature.com/article" });
    expect(p).toContain("nature.com");
  });
});

describe("buildFollowUpPrompt", () => {
  it("includes the original math", () => {
    const p = buildFollowUpPrompt({ originalMath: "∫f(x)dx", depth: "grad" });
    expect(p).toContain("∫f(x)dx");
  });

  it("truncates originalMath at 2000 chars", () => {
    const long = "y".repeat(3000);
    const p = buildFollowUpPrompt({ originalMath: long, depth: "grad" });
    expect(p).toContain("y".repeat(2000));
    expect(p).not.toContain("y".repeat(2001));
  });

  it("includes depth label", () => {
    expect(buildFollowUpPrompt({ originalMath: "x", depth: "undergrad" })).toContain("ELI-Undergrad");
  });

  it("instructs to continue conversation", () => {
    const p = buildFollowUpPrompt({ originalMath: "x", depth: "grad" });
    expect(p.toLowerCase()).toContain("conversation");
  });
});
