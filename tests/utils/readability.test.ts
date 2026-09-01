import { describe, it, expect } from "vitest";
import { measure } from "../../tools/readability";

/**
 * The depth eval's thresholds only mean something if the metric behaves. These
 * pin the direction and the markdown stripping.
 */
describe("measure", () => {
  const simple =
    "The cat sat on the mat. The dog ran fast. Birds fly high. We ate lunch. It was good.";
  const dense =
    "The asymptotic characterization presupposes uniform convergence throughout the parameterized manifold, whereupon subsequent linearization demonstrates equivalence between corresponding eigenvalue decompositions.";

  it("scores plain prose far below dense technical prose", () => {
    expect(measure(simple).fleschGrade).toBeLessThan(measure(dense).fleschGrade);
    expect(measure(simple).gunningFog).toBeLessThan(measure(dense).gunningFog);
    expect(measure(simple).complexWordPct).toBeLessThan(measure(dense).complexWordPct);
  });

  it("puts everyday prose in the general-audience band", () => {
    const m = measure(simple);
    expect(m.fleschGrade).toBeLessThanOrEqual(8);
    expect(m.meanSentenceLen).toBeLessThanOrEqual(15);
  });

  it("ignores the fixed section headings, which every level shares", () => {
    const withHeadings = `## What This Represents\n\n${simple}\n\n## The Intuition\n\n${simple}`;
    expect(measure(withHeadings).fleschGrade).toBeCloseTo(measure(`${simple} ${simple}`).fleschGrade, 0);
  });

  it("measures prose, not notation, but counts notation separately", () => {
    const withMath = `The value $\\alpha$ is small. ${simple}`;
    expect(measure(withMath).mathPer100).toBeGreaterThan(0);
    expect(measure(simple).mathPer100).toBe(0);
  });

  it("counts domain jargon", () => {
    expect(measure("The eigenvalue is orthogonal to the manifold.").jargonPer100).toBeGreaterThan(0);
    expect(measure(simple).jargonPer100).toBe(0);
  });

  it("does not divide by zero on empty input", () => {
    const m = measure("");
    expect(Number.isFinite(m.fleschGrade)).toBe(true);
    expect(Number.isFinite(m.gunningFog)).toBe(true);
  });
});
