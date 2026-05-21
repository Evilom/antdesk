/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./fab.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        glass: {
          bg: "rgba(255, 255, 255, 0.03)",
          card: "rgba(255, 255, 255, 0.06)",
          "card-hover": "rgba(255, 255, 255, 0.08)",
          input: "rgba(255, 255, 255, 0.06)",
          "input-focus": "rgba(255, 255, 255, 0.08)",
          border: "rgba(255, 255, 255, 0.08)",
          "border-light": "rgba(255, 255, 255, 0.05)",
        },
        accent: {
          blue: "#007AFF",
          green: "#34C759",
          red: "#FF3B30",
          orange: "#FF9500",
          yellow: "#FFCC00",
          purple: "#AF52DE",
          teal: "#5AC8FA",
        },
        text: {
          primary: "#ffffff",
          secondary: "rgba(255, 255, 255, 0.5)",
          muted: "rgba(255, 255, 255, 0.35)",
        },
        bg: {
          base: "#0a0a0f",
          card: "rgba(255, 255, 255, 0.06)",
          hover: "rgba(255, 255, 255, 0.08)",
          input: "rgba(255, 255, 255, 0.06)",
        },
      },
      borderRadius: {
        card: "16px",
        button: "12px",
        input: "10px",
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "BlinkMacSystemFont", "SF Pro Display", "SF Pro Text", "sans-serif"],
      },
      boxShadow: {
        card: "0 2px 20px rgba(0, 0, 0, 0.2)",
        "card-hover": "0 4px 30px rgba(0, 0, 0, 0.3)",
        fab: "0 4px 20px rgba(0, 122, 255, 0.4)",
        soft: "0 2px 10px rgba(0, 0, 0, 0.15)",
        glass: "0 8px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
      },
      backdropBlur: {
        glass: "20px",
        heavy: "40px",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
      transitionTimingFunction: {
        DEFAULT: "ease",
      },
    },
  },
  plugins: [],
};
