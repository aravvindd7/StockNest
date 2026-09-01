/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: "#0F1B33", 2: "#16234a" },
        primary: { DEFAULT: "#1B5FBF", dark: "#144a99" },
        accent: "#0EA5E9",
        healthy: "#16A34A",
        low: "#F59E0B",
        out: "#DC2626",
        expired: "#7F1D1D",
        nearexpiry: "#EAB308",
      },
      fontFamily: {
        display: ["Sora", "sans-serif"],
        body: ["Inter", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
