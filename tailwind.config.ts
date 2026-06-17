import type { Config } from "tailwindcss";

// Themeable palette — values come from CSS custom properties defined in
// src/index.css. The channel-triple form keeps Tailwind's `/opacity`
// modifiers working (e.g. bg-mauve/5 → rgb(var(--c-mauve) / 0.05)).
// Mirrors ndisc.
const c = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: c("--c-bg"),
        panel: c("--c-panel"),
        surface: c("--c-surface"),
        surfaceHover: c("--c-surface-hover"),
        fg: c("--c-fg"),
        muted: c("--c-muted"),
        accent: c("--c-accent"),
        digital: c("--c-digital"),
        ok: c("--c-ok"),
        warn: c("--c-warn"),
        alert: c("--c-alert"),
        mauve: c("--c-mauve"),
        auburn: c("--c-auburn"),
      },
      fontFamily: {
        sans: ["Helvetica", "Arial", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
