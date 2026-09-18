import type { Config } from "tailwindcss";

// Tailwind can only honor a "/NN" opacity modifier (e.g. bg-primary/20) on a
// custom color when the color resolves to a bare "R G B" triplet at build
// time -- a plain `var(--primary)` string pointing at a "#hex" value can't
// be parsed for opacity, so Tailwind silently drops the whole utility
// instead of generating it (no rule, no error). Every color below is a
// small function wrapping its matching "-rgb" triplet variable (defined
// alongside the hex ones in globals.css) so both `bg-primary` and
// `bg-primary/20` actually produce CSS.
type OpacityFn = (helpers: { opacityValue?: string }) => string;

function withOpacity(rgbVar: string): OpacityFn {
  return ({ opacityValue }) =>
    opacityValue !== undefined ? `rgb(var(${rgbVar}) / ${opacityValue})` : `rgb(var(${rgbVar}))`;
}

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
        background: withOpacity("--background-rgb"),
        foreground: withOpacity("--foreground-rgb"),
        primary: {
          DEFAULT: withOpacity("--primary-rgb"),
          dark: withOpacity("--primary-dark-rgb"),
          light: withOpacity("--primary-light-rgb"),
        },
        surface: {
          DEFAULT: withOpacity("--surface-rgb"),
          2: withOpacity("--surface-2-rgb"),
        },
        border: {
          DEFAULT: withOpacity("--border-rgb"),
          strong: withOpacity("--border-strong-rgb"),
        },
        muted: withOpacity("--foreground-muted-rgb"),
        subtle: withOpacity("--foreground-subtle-rgb"),
        // Fix for ThemeToggle 'text-textDark' usage → now properly mapped
        textDark: withOpacity("--foreground-rgb"),
        // Semantic status colors -- dark-mode-safe (each has a :root and a
        // .dark value in globals.css), used instead of raw Tailwind
        // palette classes (red-500, amber-500, emerald-500, ...) which
        // don't adapt to the theme and clash with the gold identity.
        "accent-green": {
          DEFAULT: withOpacity("--accent-green-rgb"),
          bg: withOpacity("--accent-green-bg-rgb"),
        },
        "accent-red": {
          DEFAULT: withOpacity("--accent-red-rgb"),
          bg: withOpacity("--accent-red-bg-rgb"),
        },
        "accent-amber": {
          DEFAULT: withOpacity("--accent-amber-rgb"),
          bg: withOpacity("--accent-amber-bg-rgb"),
        },
        // Tailwind's own Config type doesn't model color-as-function (the
        // opacityValue callback form) even though it's fully supported at
        // build time -- cast needed to satisfy the type checker only.
      } as any,
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
