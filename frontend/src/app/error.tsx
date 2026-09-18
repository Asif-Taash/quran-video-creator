"use client";

import { useEffect } from "react";
import Navbar from "@/components/layout/Navbar";
import { useLanguage } from "@/lib/LanguageContext";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { language } = useLanguage();
  const isArabic = language === "ar";

  useEffect(() => {
    console.error("[App Error]", error);
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col bg-background transition-colors duration-300">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="animate-fade-in relative overflow-hidden max-w-md w-full text-center bg-surface border border-primary/10 rounded-2xl p-8 shadow-lg">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-accent-red via-primary to-accent-red" />
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-accent-red-bg/60 text-accent-red">
            <ExclamationTriangleIcon className="h-7 w-7" />
          </div>
          <h1 className="text-lg font-semibold text-foreground mb-2">
            {isArabic ? "حدث خطأ غير متوقع" : "Beklenmeyen bir hata oluştu"}
          </h1>
          <p className="text-sm text-muted-foreground mb-6">
            {isArabic
              ? "نعتذر عن الإزعاج. يمكنك المحاولة مرة أخرى."
              : "Rahatsızlık için özür dileriz. Tekrar deneyebilirsiniz."}
          </p>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-primary to-primary-dark px-6 py-2.5 text-sm font-semibold text-white shadow-lg transition-all hover:shadow-primary/25"
          >
            {isArabic ? "إعادة المحاولة" : "Tekrar dene"}
          </button>
        </div>
      </main>
    </div>
  );
}
