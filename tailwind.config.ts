import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx,html}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        eq: {
          "bg-primary": "#0f1117",
          "bg-secondary": "#1a1d27",
          "bg-panel": "#161924",
          accent: "#6c8eff",
          "accent-hover": "#8ba4ff",
          "text-primary": "#e8eaf0",
          "text-secondary": "#8b90a0",
          "text-math": "#ffd580",
          border: "#2a2d3e",
          success: "#4ade80",
          error: "#f87171",
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
