import type { ExplanationDepth } from "../types/messages";

/**
 * Depth is an output contract, not an audience label.
 *
 * A one-line description of the reader ("assume a smart non-specialist") does
 * not survive contact with the rest of the prompt: the six section headings and
 * "be precise, never be vague" both pull toward technical prose, so all three
 * levels came out at roughly the same reading grade. Measured before this
 * change, ELI-Curious scored Gunning Fog 14.0 with the same share of complex
 * words as ELI-Grad. Each level now constrains vocabulary, sentence length and
 * notation explicitly.
 *
 * The six sections stay: depth shifts how they are written, never whether they
 * appear. See the `explanation-format` skill.
 */
const DEPTH_CONTRACTS: Record<ExplanationDepth, string> = {
  grad: `Audience: a graduate student working in this field.
- Use technical vocabulary freely. Do not define standard terms.
- Standard notation is expected; reference related results by name.
- Prioritize density: say the non-obvious thing rather than the definitional one.`,

  undergrad: `Audience: solid calculus and linear algebra, but new to this subfield.
- Define any term beyond first-year calculus and linear algebra the first time it appears.
- Notation is fine, but name each symbol in words as well as in symbols.
- Keep sentences under about 20 words.`,

  curious: `Audience: a sharp person with no training in this field. Clarity beats completeness.
- Write so a bright 15-year-old could follow it. Short sentences, averaging under 15 words. Everyday words.
- Never use a specialist term without explaining it in plain words in the same sentence. If a term can be avoided entirely, avoid it.
- Never explain a hard idea using another hard idea.
- In the term-by-term breakdown, say what each symbol MEANS in ordinary words first. No formula manipulation, no stacks of subscripts.
- Write the assumptions as plain sentences about when this stops working.
- The real-world analogy is required here, and it comes from ordinary life, not from another branch of mathematics.`,
};

/** Last-word reinforcement: the closing instruction is what the model reads most recently. */
const DEPTH_REMINDER: Record<ExplanationDepth, string> = {
  grad: "Assume expertise; do not pad with definitions.",
  undergrad: "Define the unfamiliar terms you use, and keep sentences short.",
  curious:
    "Above all: plain words, short sentences, and no unexplained jargon. If you catch yourself writing a technical term, either replace it with everyday language or explain it right there.",
};

function languageInstruction(language: string): string {
  if (!language || language === "English") return "";
  return `\n\nIMPORTANT: Write your entire response in ${language}. All section headings and explanations must be in ${language}.`;
}

/**
 * The model cannot see `max_tokens`, so the budget has to be said out loud or
 * the answer is simply guillotined at the ceiling.
 */
function lengthBudget(words: number | null | undefined, sectioned = true): string {
  if (!words) return "";
  const tail = sectioned
    ? " Be concise in every section; finishing all six sections briefly is better than running out of room mid-explanation."
    : " Be concise.";
  return `\n<length_budget>\nKeep the entire response under ${words} words.${tail}\n</length_budget>\n`;
}

function domainHint(pageUrl: string): string {
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, "");
    if (host) return `\n<page_domain>${host}</page_domain>`;
  } catch {
    // invalid URL — skip
  }
  return "";
}

export function buildExplanationPrompt(params: {
  math: string;
  surroundingText: string;
  documentText?: string;
  pageTitle: string;
  pageUrl?: string;
  depth: ExplanationDepth;
  language?: string;
  wordBudget?: number | null;
}): string {
  const { math, surroundingText, documentText, pageTitle, pageUrl = "", depth, language = "English" } = params;
  const docSection = documentText
    ? `\n\n<document_excerpt>\n${documentText}\n</document_excerpt>\n\nUse the document excerpt to understand the notation, variables, and domain context specific to this paper or article. Let it inform every section of your explanation.`
    : "";
  return `You are Equationeer, an expert mathematical educator specializing in making advanced mathematics deeply intuitive.

The user is reading a research paper or technical document and has selected the following mathematical expression:

<equation>
${math.slice(0, 2000)}
</equation>

<surrounding_context>
${surroundingText.slice(0, 500)}
</surrounding_context>

<document_title>
${pageTitle}
</document_title>${domainHint(pageUrl)}${docSection}

<explanation_depth>
${DEPTH_CONTRACTS[depth]}
</explanation_depth>
${lengthBudget(params.wordBudget)}
Provide a structured explanation with these exact sections:

## What This Represents
[One clear sentence describing the big picture]

## Term-by-Term Breakdown
[For each symbol, variable, operator — explain its role in THIS specific context, not generically]

## The Intuition
[What is the mathematical intuition? Use concrete reasoning. What does this model/equation actually "do"?]

## Key Assumptions
[What must be true for this equation to hold?]

## Real-World Analogy
[Only if genuinely helpful — a grounded analogy that illuminates, not oversimplifies]

## Related Concepts
[2-3 related mathematical ideas, formatted as: **Concept Name** — one line description]

Be precise. Be genuinely helpful. Never be vague. If the equation is ambiguous without more context, say so and explain both interpretations.

${DEPTH_REMINDER[depth]}${languageInstruction(language)}`;
}

export function buildImageExplanationPrompt(params: {
  pageTitle: string;
  pageUrl?: string;
  depth: ExplanationDepth;
  language?: string;
  wordBudget?: number | null;
}): string {
  const { pageTitle, pageUrl = "", depth, language = "English" } = params;
  return `You are Equationeer, an expert mathematical educator specializing in making advanced mathematics deeply intuitive.

The user is reading a document titled "${pageTitle}" and has captured a screenshot of a mathematical equation or formula.${domainHint(pageUrl)}

<explanation_depth>
${DEPTH_CONTRACTS[depth]}
</explanation_depth>
${lengthBudget(params.wordBudget)}
Look at the image carefully. Identify the mathematical expression(s) shown, then provide a structured explanation with these exact sections:

## What This Represents
[One clear sentence describing the big picture]

## Term-by-Term Breakdown
[For each symbol, variable, operator — explain its role in THIS specific context, not generically]

## The Intuition
[What is the mathematical intuition? Use concrete reasoning. What does this model/equation actually "do"?]

## Key Assumptions
[What must be true for this equation to hold?]

## Real-World Analogy
[Only if genuinely helpful — a grounded analogy that illuminates, not oversimplifies]

## Related Concepts
[2-3 related mathematical ideas, formatted as: **Concept Name** — one line description]

Be precise. Be genuinely helpful. Never be vague. If the equation is ambiguous without more context, say so and explain both interpretations.

${DEPTH_REMINDER[depth]}${languageInstruction(language)}`;
}

export function buildFollowUpPrompt(params: {
  originalMath: string;
  depth: ExplanationDepth;
  language?: string;
  wordBudget?: number | null;
}): string {
  const { originalMath, depth, language = "English" } = params;
  return `You are Equationeer, an expert mathematical educator. The user previously asked about this equation:

<equation>
${originalMath.slice(0, 2000)}
</equation>

<explanation_depth>
${DEPTH_CONTRACTS[depth]}
</explanation_depth>
${lengthBudget(params.wordBudget, false)}
Continue the conversation. Answer their follow-up question precisely and helpfully. Stay focused on the mathematics.

${DEPTH_REMINDER[depth]}${languageInstruction(language)}`;
}
