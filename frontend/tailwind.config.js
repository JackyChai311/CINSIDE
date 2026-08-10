/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "var(--brand-50, #eef2ff)",
          100: "var(--brand-100, #e0e7ff)",
          300: "var(--brand-300, #a5b4fc)",
          400: "var(--brand-400, #818cf8)",
          500: "var(--brand-500, #6366f1)",
          600: "var(--brand-600, #4f46e5)",
          700: "var(--brand-700, #4338ca)",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "'PingFang SC'",
          "'Hiragino Sans GB'",
          "'Microsoft YaHei UI'",
          "'Microsoft YaHei'",
          "'Noto Sans CJK SC'",
          "'Source Han Sans SC'",
          "Roboto",
          "sans-serif",
        ],
        display: [
          "-apple-system",
          "BlinkMacSystemFont",
          "'SF Pro Display'",
          "'Segoe UI'",
          "'PingFang SC'",
          "'Hiragino Sans GB'",
          "'Microsoft YaHei UI'",
          "Roboto",
          "sans-serif",
        ],
        mono: ["'JetBrains Mono'", "'SF Mono'", "Consolas", "monospace"],
      },
      animation: {
        "fade-in": "fadeIn .25s ease-out",
        "slide-up": "slideUp .3s ease-out",
        "pulse-soft": "pulseSoft 2s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: ".5" },
        },
      },
    },
  },
  plugins: [],
};
