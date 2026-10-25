/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        surface: token("surface"),
        subtle: token("subtle"),
        line: token("line"),
        "line-strong": token("line-strong"),
        fg: token("fg"),
        muted: token("muted"),
        faint: token("faint"),
        primary: token("primary"),
        warning: token("warning"),
        danger: token("danger"),
        info: token("info"),
        ink: token("ink"),
        node: token("node"),
      },
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["10.5px", { lineHeight: "14px" }],
        xs: ["11.5px", { lineHeight: "16px" }],
        sm: ["12.5px", { lineHeight: "18px" }],
        base: ["13.5px", { lineHeight: "20px" }],
      },
      boxShadow: {
        card: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)",
        pop: "0 12px 32px -8px rgba(16,24,40,0.18), 0 4px 10px -4px rgba(16,24,40,0.10)",
      },
      borderRadius: { xl: "10px", "2xl": "14px" },
      opacity: { 8: "0.08", 12: "0.12", 35: "0.35", 45: "0.45" },
      keyframes: {
        "slide-in": { from: { transform: "translateX(16px)", opacity: 0 }, to: { transform: "translateX(0)", opacity: 1 } },
        "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
        pulse2: { "0%,100%": { opacity: 1 }, "50%": { opacity: 0.45 } },
      },
      animation: {
        "slide-in": "slide-in 180ms ease-out",
        "fade-in": "fade-in 160ms ease-out",
        pulse2: "pulse2 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
