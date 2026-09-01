/**
 * Readability metrics for generated explanations.
 *
 * Used by `npm run eval:depth` to check that the three depth levels actually
 * produce the prose they promise. Dependency-free and deterministic, so the
 * only variable in the eval is the model output itself.
 *
 * Flesch-Kincaid and Gunning Fog both approximate US school grade level:
 * ~8 is a general-audience newspaper, ~13+ is undergraduate technical writing.
 */

export interface Metrics {
  words: number; sentences: number; meanSentenceLen: number;
  fleschGrade: number; gunningFog: number;
  complexWordPct: number; mathPer100: number; jargonPer100: number;
}

/** Terms that signal specialist vocabulary in this domain. */
const JARGON = [
  "phase", "angular", "frequency", "modulo", "modular", "principal value", "branch cut",
  "heliocentric", "synodic", "eccentricity", "anomaly", "ephemeris", "perturbation",
  "asymptotic", "eigen", "manifold", "topolog", "orthogonal", "linearize", "closed form",
  "boundary condition", "monotonic", "invariant", "parameteriz", "quantiz", "discretiz",
  "integrand", "differential", "derivative", "integral", "vector", "scalar", "matrix",
  "radian", "wavenumber", "amplitude", "damping", "resonance", "eigenvalue", "transcendental",
];

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return w ? 1 : 0;
  const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

/** Strip markdown scaffolding and math so prose is measured, not notation. */
function toProse(md: string): string {
  return md
    .replace(/^#{1,6}\s+.*$/gm, "")          // headings are fixed by the template
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]*\$/g, " ")
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, " ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[*_`>]/g, " ")
    .replace(/^\s*[-–—]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function measure(md: string): Metrics {
  const prose = toProse(md);
  const words = prose.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
  const sentences = prose.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().split(/\s+/).length > 2);
  const nWords = Math.max(words.length, 1);
  const nSent = Math.max(sentences.length, 1);
  const syl = words.reduce((a, w) => a + syllables(w), 0);
  const complex = words.filter((w) => syllables(w) >= 3).length;

  const wps = nWords / nSent;
  const spw = syl / nWords;
  const mathHits = (md.match(/\$[^$\n]*\$|\\[a-zA-Z]+/g) || []).length;
  const lower = md.toLowerCase();
  const jargonHits = JARGON.reduce((a, t) => a + (lower.split(t).length - 1), 0);

  return {
    words: nWords,
    sentences: nSent,
    meanSentenceLen: +wps.toFixed(1),
    fleschGrade: +(0.39 * wps + 11.8 * spw - 15.59).toFixed(1),
    gunningFog: +(0.4 * (wps + 100 * (complex / nWords))).toFixed(1),
    complexWordPct: +((100 * complex) / nWords).toFixed(1),
    mathPer100: +((100 * mathHits) / nWords).toFixed(1),
    jargonPer100: +((100 * jargonHits) / nWords).toFixed(1),
  };
}
