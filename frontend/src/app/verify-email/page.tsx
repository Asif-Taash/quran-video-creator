"use client";

import { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Navbar from "@/components/layout/Navbar";
import Spinner from "@/components/ui/Spinner";
import { useLanguage } from "@/lib/LanguageContext";
import { CheckBadgeIcon, XCircleIcon } from "@heroicons/react/24/outline";

type Status = "verifying" | "success" | "error";

function VerifyEmailContent() {
  const { language } = useLanguage();
  const isAr = language === "ar";
  const t = (ar: string, tr: string) => (isAr ? ar : tr);
  const token = useSearchParams().get("token") ?? "";

  const [status, setStatus] = useState<Status>(token ? "verifying" : "error");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        if (!cancelled) setStatus(res.ok ? "success" : "error");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="relative rounded-2xl border border-border bg-surface/90 backdrop-blur-sm shadow-lg p-8 pt-14 text-center">
      <div
        className={`absolute -top-9 left-1/2 -translate-x-1/2 flex h-[72px] w-[72px] items-center justify-center rounded-full shadow-lg ring-4 ring-surface ${
          status === "error" ? "bg-gradient-to-br from-accent-red to-accent-red/80" : "bg-gradient-to-br from-primary to-primary-dark"
        }`}
      >
        {status === "verifying" && <Spinner size="md" className="border-white/40 border-t-white" />}
        {status === "success" && <CheckBadgeIcon className="h-9 w-9 text-white" />}
        {status === "error" && <XCircleIcon className="h-9 w-9 text-white" />}
      </div>

      {status === "verifying" && (
        <>
          <h1 className="text-xl font-bold text-foreground mb-1.5">{t("جاري التأكيد...", "Doğrulanıyor...")}</h1>
        </>
      )}
      {status === "success" && (
        <>
          <h1 className="text-xl font-bold text-foreground mb-1.5">{t("تم تأكيد بريدك الإلكتروني", "E-postanız doğrulandı")}</h1>
          <p className="text-sm text-muted">{t("شكراً لتأكيد حسابك.", "Hesabınızı doğruladığınız için teşekkürler.")}</p>
        </>
      )}
      {status === "error" && (
        <>
          <h1 className="text-xl font-bold text-foreground mb-1.5">{t("تعذر تأكيد البريد", "E-posta doğrulanamadı")}</h1>
          <p className="text-sm text-muted">
            {t("الرابط غير صالح أو منتهي الصلاحية -- اطلب رابطاً جديداً من صفحة الحساب.", "Link geçersiz veya süresi dolmuş -- hesap sayfasından yeni bir link isteyin.")}
          </p>
        </>
      )}

      <Link
        href="/account"
        className="mt-6 inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-primary to-primary-dark px-5 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-105"
      >
        {t("الذهاب إلى الحساب", "Hesaba git")}
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="relative min-h-screen bg-background transition-colors duration-300 overflow-hidden">
      <div className="pointer-events-none absolute -top-24 -left-24 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />
      <div className="pointer-events-none absolute top-1/3 -right-24 h-80 w-80 rounded-full bg-primary-dark/15 blur-3xl" />

      <Navbar />

      <main className="relative px-4 py-12 md:py-20 flex items-center justify-center min-h-[calc(100vh-6rem)]">
        <div className="w-full max-w-sm animate-fade-in">
          <Suspense fallback={<div className="h-64" />}>
            <VerifyEmailContent />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
