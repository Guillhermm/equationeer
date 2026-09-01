/**
 * Depth-level evaluation. Run with `npm run eval:depth`.
 *
 * Not part of `npm test`: it calls the real API and costs money, so it is
 * excluded from the default suite and skips when no key is present.
 *
 * What it guards: the promise each depth level makes about its prose. Before
 * the depth contracts landed, all three levels wrote at roughly the same
 * reading grade, and ELI-Curious scored *above* ELI-Undergrad on one case.
 * Prompt edits regress this silently, which is exactly what an eval is for.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { measure, type Metrics } from "../../tools/readability";
import { buildExplanationPrompt } from "../../src/utils/promptBuilder";
import {
  BUNDLED_MODELS,
  EXPLANATION_EFFORT,
  findModel,
  resolveMaxTokens,
  wordBudget,
} from "../../src/utils/models";
import type { ExplanationDepth } from "../../src/types/messages";

const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.VITE_ANTHROPIC_API_KEY ?? "";
const model = findModel(BUNDLED_MODELS, "claude-opus-5")!;
const ANSWER_TOKENS = 1024; // the shipped default

const CASES = [
  {
    name: "orbital transfer angle",
    math: "∆νH = ∆νspc + 2πW",
    title: "interplanetary-round-trip-mission-design-2004.pdf",
  },
  {
    name: "Bellman optimality",
    math: "V(s) = max_a [ R(s,a) + γ Σ_{s'} P(s'|s,a) V(s') ]",
    title: "Reinforcement Learning",
  },
];

const SECTIONS = [
  "## What This Represents",
  "## Term-by-Term Breakdown",
  "## The Intuition",
  "## Key Assumptions",
  "## Real-World Analogy",
  "## Related Concepts",
];

async function explain(math: string, title: string, depth: ExplanationDepth): Promise<string> {
  const system = buildExplanationPrompt({
    math, surroundingText: math, pageTitle: title, pageUrl: "",
    depth, language: "English", wordBudget: wordBudget(ANSWER_TOKENS),
  });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model.id,
      max_tokens: resolveMaxTokens(ANSWER_TOKENS, model),
      system,
      messages: [{ role: "user", content: math }],
      output_config: { effort: EXPLANATION_EFFORT },
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return (json.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
}

describe.skipIf(!apiKey)("depth levels produce the prose they promise", () => {
  const text = new Map<string, string>();
  const stats = new Map<string, Metrics>();
  const key = (c: string, d: string) => `${c}/${d}`;

  beforeAll(async () => {
    const jobs = CASES.flatMap((c) =>
      (["grad", "undergrad", "curious"] as ExplanationDepth[]).map(async (d) => {
        const md = await explain(c.math, c.title, d);
        text.set(key(c.name, d), md);
        stats.set(key(c.name, d), measure(md));
      }),
    );
    await Promise.all(jobs);
  }, 180_000);

  for (const c of CASES) {
    describe(c.name, () => {
      it("keeps all six sections at every level, as the renderer requires", () => {
        for (const d of ["grad", "undergrad", "curious"]) {
          const md = text.get(key(c.name, d))!;
          for (const heading of SECTIONS) expect(md, `${d} is missing ${heading}`).toContain(heading);
        }
      });

      it("reads easier as the level drops", () => {
        const grad = stats.get(key(c.name, "grad"))!;
        const under = stats.get(key(c.name, "undergrad"))!;
        const curious = stats.get(key(c.name, "curious"))!;

        // Margins absorb run-to-run variance; measured gaps are far wider.
        expect(under.fleschGrade, "undergrad should read easier than grad").toBeLessThan(grad.fleschGrade);
        expect(curious.fleschGrade + 1.5, "curious should read easier than undergrad")
          .toBeLessThan(under.fleschGrade);
      });

      it("keeps ELI-Curious genuinely accessible", () => {
        const m = stats.get(key(c.name, "curious"))!;
        // A general-audience newspaper sits near grade 8.
        expect(m.fleschGrade, `grade level ${m.fleschGrade}`).toBeLessThanOrEqual(8);
        expect(m.gunningFog, `fog index ${m.gunningFog}`).toBeLessThanOrEqual(10);
        expect(m.meanSentenceLen, `mean sentence ${m.meanSentenceLen} words`).toBeLessThanOrEqual(15);
        expect(m.complexWordPct, `${m.complexWordPct}% complex words`).toBeLessThanOrEqual(13);
      });

      it("still writes like an expert at ELI-Grad", () => {
        const m = stats.get(key(c.name, "grad"))!;
        expect(m.fleschGrade, "grad should stay technical").toBeGreaterThanOrEqual(11);
      });
    });
  }
});
