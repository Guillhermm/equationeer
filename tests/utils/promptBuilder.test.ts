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

  it("includes the grad contract", () => {
    const p = buildExplanationPrompt({ ...base, depth: "grad" });
    expect(p).toContain("a graduate student working in this field");
  });

  it("includes the undergrad contract", () => {
    expect(buildExplanationPrompt(base)).toContain("solid calculus and linear algebra");
  });

  it("includes the curious contract", () => {
    const p = buildExplanationPrompt({ ...base, depth: "curious" });
    expect(p).toContain("no training in this field");
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

  it("includes the depth contract", () => {
    expect(buildImageExplanationPrompt({ pageTitle: "t", depth: "curious" })).toContain("no training in this field");
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

  it("includes the depth contract", () => {
    expect(buildFollowUpPrompt({ originalMath: "x", depth: "undergrad" })).toContain("solid calculus and linear algebra");
  });

  it("instructs to continue conversation", () => {
    const p = buildFollowUpPrompt({ originalMath: "x", depth: "grad" });
    expect(p.toLowerCase()).toContain("conversation");
  });
});

// ── length budget ─────────────────────────────────────────────────────────────

describe("length budget", () => {
  const base = {
    math: "E = mc^2",
    surroundingText: "context",
    pageTitle: "Paper",
    depth: "undergrad" as const,
  };

  it("states the budget in the prompt, since max_tokens is invisible to the model", () => {
    const prompt = buildExplanationPrompt({ ...base, wordBudget: 341 });
    expect(prompt).toContain("<length_budget>");
    expect(prompt).toContain("under 341 words");
  });

  it("omits the block when the budget is generous", () => {
    expect(buildExplanationPrompt({ ...base, wordBudget: null })).not.toContain("<length_budget>");
    expect(buildExplanationPrompt(base)).not.toContain("<length_budget>");
  });

  it("carries the budget into image and follow-up prompts", () => {
    expect(buildImageExplanationPrompt({ pageTitle: "P", depth: "undergrad", wordBudget: 200 }))
      .toContain("under 200 words");
    expect(buildFollowUpPrompt({ originalMath: "x", depth: "undergrad", wordBudget: 200 }))
      .toContain("under 200 words");
  });
});

// ── depth contracts ───────────────────────────────────────────────────────────

/**
 * The eval in tests/eval measures the prose that comes back. These assert the
 * cheap half: that the constraint reaches the model at all.
 */
describe("depth contracts", () => {
  const base = {
    math: "E = mc^2",
    surroundingText: "context",
    pageTitle: "Paper",
  };

  it("tells ELI-Curious to avoid unexplained jargon and keep sentences short", () => {
    const prompt = buildExplanationPrompt({ ...base, depth: "curious" });
    expect(prompt).toContain("under 15 words");
    expect(prompt).toContain("Never use a specialist term without explaining it");
    expect(prompt).toContain("Never explain a hard idea using another hard idea");
  });

  it("lets ELI-Grad use technical vocabulary freely", () => {
    const prompt = buildExplanationPrompt({ ...base, depth: "grad" });
    expect(prompt).toContain("Use technical vocabulary freely");
    expect(prompt).not.toContain("under 15 words");
  });

  it("asks ELI-Undergrad to define terms beyond first-year mathematics", () => {
    const prompt = buildExplanationPrompt({ ...base, depth: "undergrad" });
    expect(prompt).toContain("first-year calculus and linear algebra");
  });

  it("repeats the constraint at the end, where recency helps most", () => {
    const prompt = buildExplanationPrompt({ ...base, depth: "curious" });
    const tail = prompt.slice(-400);
    expect(tail).toContain("plain words, short sentences");
  });

  it("keeps all six section headings at every depth, as the renderer requires", () => {
    const sections = [
      "## What This Represents",
      "## Term-by-Term Breakdown",
      "## The Intuition",
      "## Key Assumptions",
      "## Real-World Analogy",
      "## Related Concepts",
    ];
    for (const depth of ["grad", "undergrad", "curious"] as const) {
      const prompt = buildExplanationPrompt({ ...base, depth });
      for (const s of sections) expect(prompt, `${depth} lost ${s}`).toContain(s);
    }
  });

  it("carries the depth contract into image and follow-up prompts", () => {
    expect(buildImageExplanationPrompt({ pageTitle: "P", depth: "curious" }))
      .toContain("Never explain a hard idea using another hard idea");
    expect(buildFollowUpPrompt({ originalMath: "x", depth: "curious" }))
      .toContain("plain words, short sentences");
  });
});
