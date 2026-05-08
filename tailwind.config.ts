import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Catppuccin Mocha palette to match the rest of the suite
        bg: "#1e1e2e",
        panel: "#181825",
        surface: "#313244",
        surfaceHover: "#45475a",
        fg: "#cdd6f4",
        muted: "#6c7086",
        accent: "#89b4fa",
        ok: "#a6e3a1",
        warn: "#f9e2af",
        alert: "#f38ba8",
      },
      fontFamily: {
        sans: ["Helvetica", "Arial", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
