"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="w-9 h-9" />;
  }

  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="p-2 rounded-full text-foreground hover:bg-surface transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
      aria-label="Toggle Dark Mode"
    >
      {theme === "dark" ? (
        <SunIcon className="w-5 h-5 text-primary" />
      ) : (
        <MoonIcon className="w-5 h-5 text-foreground/70" />
      )}
    </button>
  );
}
