"use client";

import { useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import Navbar from "@/components/layout/Navbar";
import Spinner from "@/components/ui/Spinner";
import { useLanguage } from "@/lib/LanguageContext";
import { EyeIcon, EyeSlashIcon, LockClosedIcon } from "@heroicons/react/24/outline";

const INPUT_CLASSES =
  "w-full h-[52px] outline-none transition-all duration-300 rounded-xl border border-border bg-background shadow-sm hover:border-primary/40 hover:shadow-md text-sm font-medium focus:border-primary focus:ring-2 focus:ring-primary/20";
const MIN_PASSWORD_LENGTH = 8;

function ResetPasswordForm() {
  const { language } = useLanguage();
  const isAr = language === "ar";
  const t = (ar: string, tr: string) => (isAr ? ar : tr);
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const errorMessage = (code: string) => {
    if (code === "invalid_or_expired_token") {
      return t("الرابط غير صالح أو منتهي الصلاحية، اطلب رابطاً جديداً", "Link geçersiz veya süresi dolmuş, yeni bir link isteyin");
    }
    if (code === "weak_password") {
      return t(`كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل`, `Şifre en az ${MIN_PASSWORD_LENGTH} karakter olmalı`);
    }
    return t("حدث خطأ، حاول مرة أخرى", "Bir hata oluştu, tekrar deneyin");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError(t("كلمتا المرور غير متطابقتين", "Şifreler eşleşmiyor"));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(errorMessage(data.error));
        return;
      }
      setDone(true);
      setTimeout(() => router.push("/login"), 2500);
    } catch {
      setError(errorMessage("network"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative rounded-2xl border border-border bg-surface/90 backdrop-blur-sm shadow-lg p-8 pt-14">
      <div className="absolute -top-9 left-1/2 -translate-x-1/2 flex h-[72px] w-[72px] items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-dark shadow-lg ring-4 ring-surface">
        <LockClosedIcon className="h-9 w-9 text-white" />
      </div>

      <h1 className="text-2xl font-bold text-foreground mb-1.5 text-center">
        {t("تعيين كلمة مرور جديدة", "Yeni Şifre Belirle")}
      </h1>
      <p className="text-sm text-muted text-center mb-7">
        {t("اختر كلمة مرور جديدة لحسابك", "Hesabın için yeni bir şifre seç")}
      </p>

      {!token && (
        <div className="mb-4 rounded-xl border border-accent-red/30 bg-accent-red-bg/60 p-3 text-sm text-accent-red">
          {t("الرابط غير صالح -- تأكد من فتحه كاملاً من رسالتك", "Link geçersiz -- linki tam olarak açtığınızdan emin olun")}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-xl border border-accent-red/30 bg-accent-red-bg/60 p-3 text-sm text-accent-red animate-fade-in">
          {error}
        </div>
      )}

      {done ? (
        <div className="rounded-xl border border-accent-green/30 bg-accent-green-bg/40 p-4 text-sm text-foreground leading-relaxed animate-fade-in">
          {t("تم تغيير كلمة المرور بنجاح. جاري تحويلك لتسجيل الدخول...", "Şifre başarıyla değiştirildi. Girişe yönlendiriliyorsunuz...")}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4" dir={isAr ? "rtl" : "ltr"}>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              required
              minLength={MIN_PASSWORD_LENGTH}
              disabled={!token}
              dir="ltr"
              placeholder={t("كلمة المرور الجديدة", "Yeni şifre")}
              className={`${INPUT_CLASSES} pl-4 pr-12`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer p-1 text-muted transition-colors hover:text-foreground"
            >
              {showPassword ? <EyeSlashIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
            </button>
          </div>
          <input
            type={showPassword ? "text" : "password"}
            required
            disabled={!token}
            dir="ltr"
            placeholder={t("تأكيد كلمة المرور", "Şifreyi onayla")}
            className={INPUT_CLASSES}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />

          <button
            type="submit"
            disabled={loading || !token}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary to-primary-dark px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading && <Spinner size="sm" className="border-white/40 border-t-white" />}
            {t("تعيين كلمة المرور", "Şifreyi Belirle")}
          </button>
        </form>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  const { language } = useLanguage();
  const isAr = language === "ar";

  return (
    <div className="relative min-h-screen bg-background transition-colors duration-300 overflow-hidden">
      <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />
      <div className="pointer-events-none absolute top-1/3 -left-24 h-80 w-80 rounded-full bg-primary-dark/15 blur-3xl" />

      <Navbar />

      <main className="relative px-4 py-12 md:py-20 flex items-center justify-center min-h-[calc(100vh-6rem)]">
        <div className="w-full max-w-sm animate-fade-in">
          <Suspense fallback={<div className="h-64" />}>
            <ResetPasswordForm />
          </Suspense>
          <p className="mt-6 text-center text-sm text-muted">
            <Link href="/login" className="text-primary font-semibold hover:underline">
              {isAr ? "العودة لتسجيل الدخول" : "Girişe geri dön"}
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
