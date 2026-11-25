"use client";

import React, { useEffect } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useLanguage, useT } from "@/lib/LanguageContext";

// The memorization page's windows (the passage, reviews, settings). Redone
// 2026-11-24 after the user found them too small on a laptop and broken (a
// dropdown's list was cut off inside the window): a wide card on a blurred,
// dimmed page; on a phone a sheet rising from the bottom. On a laptop the
// card doesn't scroll -- nothing in it gets clipped; only a phone's sheet
// scrolls.
export default function Dialog({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  // Kept in view at the bottom (the main button).
  footer?: React.ReactNode;
}) {
  const tx = useT();
  const { language } = useLanguage();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[200] flex items-end justify-center bg-black/55 backdrop-blur-[3px] sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        dir={language === "ar" ? "rtl" : "ltr"}
        className="flex max-h-[92dvh] w-full animate-slide-up flex-col rounded-t-[1.75rem] border border-border/70 bg-surface shadow-2xl sm:max-h-none sm:max-w-[40rem] sm:rounded-[1.75rem]"
      >
        <div className="flex items-start gap-3 px-5 pb-4 pt-5 sm:px-8 sm:pt-7">
          {icon && <span className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">{icon}</span>}
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-bold leading-tight text-foreground">{title}</h2>
            {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-me-1 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label={tx("إغلاق", "Kapat", "Close")}
          >
            <XMarkIcon className="h-6 w-6" />
          </button>
        </div>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:overflow-visible sm:px-8 sm:pb-7">{children}</div>
        {footer && <div className="border-t border-border/60 px-5 py-4 sm:px-8">{footer}</div>}
      </div>
    </div>
  );
}
