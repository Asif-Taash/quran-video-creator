"use client";

import * as React from "react";
import { useLanguage } from "@/lib/LanguageContext";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

type Props = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // Red destructive styling (delete-a-video, delete-an-account) vs the
  // neutral/primary styling for anything else this ends up guarding later.
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

// Generic replacement for the browser's native confirm() -- that one can't
// be restyled at all (see the "localhost:3000 says" screenshot report), so
// every destructive confirmation in the app should go through this instead,
// matching DeleteAccountDialog's same overlay/card conventions.
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = true,
  onConfirm,
  onClose,
}: Props) {
  const { language } = useLanguage();
  const isAr = language === "ar";
  const t = (ar: string, tr: string) => (isAr ? ar : tr);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        dir={isAr ? "rtl" : "ltr"}
        className="w-full max-w-sm animate-fade-in rounded-2xl border border-border bg-surface p-6 shadow-lg"
      >
        <div className="mb-4 flex items-start gap-3">
          <span
            className={`rounded-full p-2 ${danger ? "bg-accent-red-bg/60 text-accent-red" : "bg-primary/10 text-primary"}`}
          >
            <ExclamationTriangleIcon className="w-6 h-6" />
          </span>
          <h2 id="confirm-dialog-title" className="text-lg font-bold text-foreground pt-1.5">
            {title}
          </h2>
        </div>

        <p className="text-sm text-foreground leading-relaxed">{message}</p>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-surface-2"
          >
            {cancelLabel ?? t("إلغاء", "İptal")}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className={
              danger
                ? "rounded-lg bg-accent-red px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:opacity-90"
                : "rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
            }
          >
            {confirmLabel ?? t("تأكيد", "Onayla")}
          </button>
        </div>
      </div>
    </div>
  );
}
