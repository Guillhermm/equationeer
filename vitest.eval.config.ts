import { defineConfig } from "vitest/config";

/**
 * Evaluation suite: calls the real Anthropic API, so it is deliberately kept
 * out of `npm test`. Run with `npm run eval:depth`.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/eval/**/*.eval.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
