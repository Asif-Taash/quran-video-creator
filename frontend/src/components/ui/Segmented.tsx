import React from "react";

// One look for every "pick one of these" row (2026-11-20): the audio
// source, the video's shape, its quality. The chosen one is a raised card
// inside a soft tray.
export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  dir,
}: {
  options: { value: T; label: React.ReactNode; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  dir?: "rtl" | "ltr";
}) {
  return (
    <div className="flex gap-1 rounded-xl bg-primary/[0.06] p-1 ring-1 ring-inset ring-primary/10" role="radiogroup" dir={dir}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg font-medium transition-all duration-200 ${
              size === "sm" ? "px-2 py-1.5 text-xs" : "px-3 py-2.5 text-sm"
            } ${
              active
                ? "bg-surface text-primary-dark shadow-sm ring-1 ring-primary/25 dark:text-primary-light"
                : "text-muted-foreground hover:bg-surface/60 hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
