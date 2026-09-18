"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Navbar from "@/components/layout/Navbar";
import Spinner from "@/components/ui/Spinner";
import { useLanguage } from "@/lib/LanguageContext";
import { EyeIcon, EyeSlashIcon, EnvelopeIcon, LockClosedIcon, UserPlusIcon, CheckCircleIcon } from "@heroicons/react/24/outline";

const INPUT_CLASSES =
  "w-full h-[52px] outline-none transition-all duration-300 rounded-xl border border-border bg-background shadow-sm hover:border-primary/40 hover:shadow-md text-sm font-medium focus:border-primary focus:ring-2 focus:ring-primary/20";

const MIN_PASSWORD_LENGTH = 8;

export default function SignupPage() {
  const { language } = useLanguage();
  const isAr = language === "ar";
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const errorMessage = (code: string) => {
    if (code === "invalid_email") {
      return isAr ? "البريد الإلكتروني غير صالح" : "Geçersiz e-posta adresi";
    }
    if (code === "weak_password") {
      return isAr ? "كلمة المرور يجب أن تكون 8 أحرف على الأقل" : "Şifre en az 8 karakter olmalı";
    }
    if (code === "email_taken") {
      return isAr ? "هذا البريد الإلكتروني مستخدم بالفعل" : "Bu e-posta zaten kayıtlı";
    }
    return isAr ? "حدث خطأ، حاول مرة أخرى" : "Bir hata oluştu, tekrar deneyin";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorMessage(data.error));
        return;
      }
      router.push("/?tab=gallery");
      router.refresh();
    } catch {
      setError(errorMessage("network"));
    } finally {
      setLoading(false);
    }
  };

  const passwordLongEnough = password.length >= MIN_PASSWORD_LENGTH;

  return (
    <div className="relative min-h-screen bg-background transition-colors duration-300 overflow-hidden">
      {/* Decorative glow blobs -- pure CSS, matches the app's existing
          glow-primary/gradient-gold visual language elsewhere. */}
      <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />
      <div className="pointer-events-none absolute top-1/3 -left-24 h-80 w-80 rounded-full bg-primary-dark/15 blur-3xl" />

      <Navbar />

      <main className="relative px-4 py-12 md:py-20 flex items-center justify-center min-h-[calc(100vh-6rem)]">
        <div className="w-full max-w-sm animate-fade-in">
          <div className="relative rounded-2xl border border-border bg-surface/90 backdrop-blur-sm shadow-lg p-8 pt-14">
            <div className="absolute -top-9 left-1/2 -translate-x-1/2 flex h-[72px] w-[72px] items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary-dark shadow-lg ring-4 ring-surface">
              <UserPlusIcon className="h-9 w-9 text-white" />
            </div>

            <h1 className="text-2xl font-bold text-foreground mb-1.5 text-center">
              {isAr ? "إنشاء حساب جديد" : "Yeni Hesap Oluştur"}
            </h1>
            <p className="text-sm text-muted text-center mb-7">
              {isAr ? "ابدأ في إنشاء فيديوهاتك مجاناً" : "Videolarınızı ücretsiz oluşturmaya başlayın"}
            </p>

            {error && (
              <div className="mb-4 rounded-xl border border-accent-red/30 bg-accent-red-bg/60 p-3 text-sm text-accent-red animate-fade-in">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4" dir={isAr ? "rtl" : "ltr"}>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  {isAr ? "البريد الإلكتروني" : "E-posta"}
                </label>
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
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">
                  {isAr ? "كلمة المرور" : "Şifre"}
                </label>
                <div className="relative">
                  <LockClosedIcon className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted" />
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                    dir="ltr"
                    className={`${INPUT_CLASSES} pl-12 pr-12`}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    aria-label={
                      showPassword
                        ? isAr ? "إخفاء كلمة المرور" : "Şifreyi gizle"
                        : isAr ? "إظهار كلمة المرور" : "Şifreyi göster"
                    }
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer p-1 text-muted transition-colors hover:text-foreground"
                  >
                    {showPassword ? <EyeSlashIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                  </button>
                </div>
                <p className={`flex items-center gap-1.5 text-xs transition-colors ${passwordLongEnough ? "text-accent-green" : "text-muted"}`}>
                  <CheckCircleIcon className="h-3.5 w-3.5" />
                  {isAr ? "8 أحرف على الأقل" : "En az 8 karakter"}
                </p>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-primary to-primary-dark px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-105 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading && <Spinner size="sm" className="border-white/40 border-t-white" />}
                {isAr ? "إنشاء حساب" : "Kayıt Ol"}
              </button>
            </form>
          </div>

          <p className="mt-6 text-center text-sm text-muted">
            {isAr ? "لديك حساب بالفعل؟" : "Zaten hesabın var mı?"}{" "}
            <Link href="/login" className="text-primary font-semibold hover:underline">
              {isAr ? "تسجيل الدخول" : "Giriş Yap"}
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
