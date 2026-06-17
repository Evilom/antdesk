/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./fab.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "rgba(10, 10, 15, 0.95)",
          card: "var(--bg-card)",
          hover: "var(--bg-hover)",
          input: "var(--bg-input)",
          elevated: "var(--bg-card-elevated)",
          pressed: "var(--bg-pressed)",
          glass: "var(--glass-surface)",
        },
        accent: {
          blue: "#0a84ff",
          green: "#30d158",
          red: "#ff453a",
          orange: "#ff9f0a",
          yellow: "#ffd60a",
          purple: "#bf5af2",
          pink: "#ff375f",
        },
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          muted: "var(--text-muted)",
          faint: "var(--text-faint)",
        },
        border: {
          card: "var(--border-card)",
          hover: "var(--border-hover)",
          focus: "var(--border-focus)",
          subtle: "var(--border-subtle)",
          separator: "var(--border-separator)",
        },
      },
      borderRadius: {
        card: "16px",
        button: "12px",
        input: "10px",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Display",
          "SF Pro Text",
          "system-ui",
          "sans-serif",
        ],
        mono: ["SF Mono", "Menlo", "monospace"],
      },
      spacing: {
        "4.5": "18px",
      },
    },
  },
  plugins: [],
};
