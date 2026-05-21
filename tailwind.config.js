/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./fab.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "#0f0f17",
          card: "#1a1a2e",
          hover: "#252540",
          input: "#16162a",
        },
        accent: {
          purple: "#6366f1",
          green: "#22c55e",
          red: "#ef4444",
          yellow: "#eab308",
          blue: "#3b82f6",
        },
        text: {
          primary: "#e2e8f0",
          secondary: "#94a3b8",
          muted: "#64748b",
        },
      },
      borderRadius: {
        card: "12px",
        button: "8px",
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "sans-serif"],
      },
      boxShadow: {
        panel: "0 4px 24px rgba(0,0,0,0.3)",
        fab: "0 2px 12px rgba(0,0,0,0.4)",
      },
    },
  },
  plugins: [],
};
