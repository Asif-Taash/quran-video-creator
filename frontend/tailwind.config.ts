import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "var(--primary)",
          dark: "var(--primary-dark)",
          light: "var(--primary-light)",
        },
        surface: {
          DEFAULT: "var(--surface)",
          2: "var(--surface-2)",
        },
        border: {
          DEFAULT: "var(--border)",
          strong: "var(--border-strong)",
        },
        muted: "var(--foreground-muted)",
        subtle: "var(--foreground-subtle)",
        // Fix for ThemeToggle 'text-textDark' usage → now properly mapped
        textDark: "var(--foreground)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        arabic: ["var(--font-amiri)", "Amiri", "Georgia", "serif"],
        // Authentic KFGQPC Uthman Taha Naskh — Madinah Mushaf style
        uthmani: ["var(--font-uthmani)", "KFGQPC Uthman Taha Naskh", "Amiri Quran", "Scheherazade New", "Noto Naskh Arabic", "serif"],
        quran: ["var(--font-uthmani)", "KFGQPC Uthman Taha Naskh", "Amiri Quran", "Scheherazade New", "Noto Naskh Arabic", "serif"],
      },
      boxShadow: {
        soft: "var(--shadow)",
        sm: "var(--shadow-sm)",
        lg: "var(--shadow-lg)",
        glow: "var(--shadow-glow)",
        "glow-lg": "0 0 40px rgb(var(--primary-rgb) / 0.35)",
        "inner-soft": "inset 0 2px 8px 0 rgb(0 0 0 / 0.04)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
      },
      transitionTimingFunction: {
        spring: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      animation: {
        shimmer: "shimmer 1.5s infinite",
        "fade-in": "fadeIn 0.4s ease-out both",
        "slide-up": "slideUp 0.5s cubic-bezier(0.22, 1, 0.36, 1) both",
        "pulse-glow": "pulseGlow 3s ease-in-out infinite",
        "spin-slow": "spin 3s linear infinite",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        fadeIn: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        slideUp: {
          from: { opacity: "0", transform: "translateY(24px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        pulseGlow: {
          "0%, 100%": { boxShadow: "0 0 20px rgb(194 155 77 / 0.2)" },
          "50%": { boxShadow: "0 0 40px rgb(194 155 77 / 0.4)" },
        },
      },
      screens: {
        xs: "375px",
        "3xl": "1920px",
      },
    },
  },
  plugins: [],
};

export default config;
