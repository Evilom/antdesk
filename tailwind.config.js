/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./fab.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: "rgba(10, 10, 15, 0.95)",
          card: "rgba(255, 255, 255, 0.06)",
          hover: "rgba(255, 255, 255, 0.10)",
          input: "rgba(255, 255, 255, 0.06)",
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
          secondary: "rgba(255, 255, 255, 0.55)",
          muted: "rgba(255, 255, 255, 0.35)",
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
      },
    },
  },
  plugins: [],
};
