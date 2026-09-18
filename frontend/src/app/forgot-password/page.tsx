"use client";

import { useState } from "react";
import Link from "next/link";
import Navbar from "@/components/layout/Navbar";
import Spinner from "@/components/ui/Spinner";
import { useLanguage } from "@/lib/LanguageContext";
import { EnvelopeIcon, KeyIcon, ArrowLeftIcon } from "@heroicons/react/24/outline";

const INPUT_CLASSES =
  "w-full h-[52px] outline-none transition-all duration-300 rounded-xl border border-border bg-background shadow-sm hover:border-primary/40 hover:shadow-md text-sm font-medium focus:border-primary focus:ring-2 focus:ring-primary/20";

export default function ForgotPasswordPage() {
  const { language } = useLanguage();
  const isAr = language === "ar";
  const t = (ar: string, tr: string) => (isAr ? ar : tr);

  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(t("حدث خطأ، حاول مرة أخرى", "Bir hata oluştu, tekrar deneyin"));
        return;
      }
      setSent(true);
      setDevResetUrl(data?.devResetUrl ?? null);
    } catch {
      setError(t("خطأ في الاتصال", "Bağlantı hatası"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen bg-background transition-colors duration-300 overflow-hidden">
      <div className="pointer-events-none absolute -top-24 -left-24 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />
      <div className="pointer-events-none absolute top-1/3 -right-24 h-80 w-80 rounded-full bg-primary-dark/15 blur-3xl" />

      <Navbar />

      <main className="relative px-4 py-12 md:py-20 flex items-center justify-center min-h-[calc(100vh-6rem)]">
        <div className="w-full max-w-sm animate-fade-in">
          <div className="relative rounded-2xl border border-border bg-surface/90 backdrop-blur-sm shadow-lg p-8 pt-14">
            <div className="absolute -top-9 left-1/2 -translate-x-1/2 flex h-[72px] w-[72px] items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-dark shadow-lg ring-4 ring-surface">
              <KeyIcon className="h-9 w-9 text-white" />
            </div>

            <h1 className="text-2xl font-bold text-foreground mb-1.5 text-center">
              {t("نسيت كلمة المرور؟", "Şifreni mi Unuttun?")}
            </h1>
            <p className="text-sm text-muted text-center mb-7">
              {t("أدخل بريدك الإلكتروني وسنرسل لك رابط إعادة التعيين", "E-postanı gir, sana bir sıfırlama linki gönderelim")}
            </p>

            {error && (
              <div className="mb-4 rounded-xl border border-accent-red/30 bg-accent-red-bg/60 p-3 text-sm text-accent-red animate-fade-in">
                {error}
              </div>
            )}

            {sent ? (
              <div className="space-y-4 animate-fade-in">
                <div className="rounded-xl border border-accent-green/30 bg-accent-green-bg/40 p-4 text-sm text-foreground leading-relaxed">
                  {t(
                    "إذا كان هذا البريد مسجلاً لدينا، فسيصلك رابط لإعادة تعيين كلمة المرور.",
                    "Bu e-posta bize kayıtlıysa, şifre sıfırlama linki gönderildi."
                  )}
                </div>
                {devResetUrl && (
                  <div className="rounded-xl border border-accent-amber/30 bg-accent-amber-bg/30 p-4">
                    <p className="text-xs text-accent-amber mb-2">
                      {t(
                        "وضع تطوير -- لا يوجد بريد فعلي بعد، إليك الرابط مباشرة:",
                        "Dev mod -- henüz gerçek e-posta yok, linki doğrudan burada:"
                      )}
                    </p>
                    <a
                      href={devResetUrl}
                      className="block truncate rounded-lg bg-accent-amber/15 px-3 py-2 text-xs font-semibold text-accent-amber hover:bg-accent-amber/25 transition-colors"
                      dir="ltr"
                    >
                      {devResetUrl}
                    </a>
                  </div>
                )}
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4" dir={isAr ? "rtl" : "ltr"}>
                <div className="relative">
                  <EnvelopeIcon className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted" />
                  <input
                    type="email"
                    required
                    dir="ltr"
                    autoFocus
                    className={`${INPUT_CLASSES} pl-12 pr-4`}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary to-primary-dark px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading && <Spinner size="sm" className="border-white/40 border-t-white" />}
                  {t("إرسال رابط إعادة التعيين", "Sıfırlama Linki Gönder")}
                </button>
              </form>
            )}
          </div>

          <p className="mt-6 text-center text-sm text-muted">
            <Link href="/login" className="inline-flex items-center gap-1.5 text-primary font-semibold hover:underline">
              <ArrowLeftIcon className={`h-4 w-4 ${isAr ? "rotate-180" : ""}`} />
              {t("العودة لتسجيل الدخول", "Girişe geri dön")}
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
