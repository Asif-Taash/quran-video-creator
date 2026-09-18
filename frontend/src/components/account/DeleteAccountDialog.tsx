"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useLanguage } from "@/lib/LanguageContext";
import Spinner from "@/components/ui/Spinner";
import { EyeIcon, EyeSlashIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";

const INPUT_CLASSES =
  "w-full h-[50px] outline-none transition-all duration-300 rounded-xl border border-border bg-background shadow-sm hover:border-primary/30 hover:shadow-md text-sm font-medium focus:border-primary focus:ring-1 focus:ring-primary px-4";

type Step = "warning" | "password" | "confirm";

type Props = {
  open: boolean;
  email: string;
  onClose: () => void;
};

export default function DeleteAccountDialog({ open, email, onClose }: Props) {
  const { language } = useLanguage();
  const isAr = language === "ar";
  const router = useRouter();

  const [step, setStep] = React.useState<Step>("warning");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [keyword, setKeyword] = React.useState("");
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dialogRef = React.useRef<HTMLDivElement>(null);

  const t = (tr: string, ar: string) => (isAr ? ar : tr);

  React.useEffect(() => {
    if (open) {
      setStep("warning");
      setPassword("");
      setShowPassword(false);
      setKeyword("");
      setAcknowledged(false);
      setLoading(false);
      setError(null);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, loading, onClose]);

  if (!open) return null;

  const verifyPassword = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, verifyOnly: true }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error === "invalid_password") {
          setError(t("Şifre hatalı", "كلمة المرور غير صحيحة"));
        } else if (data.error === "not_authenticated") {
          setError(t("Oturum sona erdi", "انتهت الجلسة"));
        } else {
          setError(t("Bir hata oluştu, tekrar deneyin", "حدث خطأ، حاول مرة أخرى"));
        }
        return;
      }
      setStep("confirm");
    } catch {
      setError(t("Bağlantı hatası, tekrar deneyin", "خطأ في الاتصال، حاول مرة أخرى"));
    } finally {
      setLoading(false);
    }
  };

  const deleteAccount = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error === "invalid_password") {
          setError(t("Şifre hatalı", "كلمة المرور غير صحيحة"));
        } else if (data.error === "not_authenticated") {
          setError(t("Oturum sona erdi", "انتهت الجلسة"));
        } else {
          setError(t("Bir hata oluştu, tekrar deneyin", "حدث خطأ، حاول مرة أخرى"));
        }
        return;
      }
      onClose();
      router.push("/?deleted=1");
      router.refresh();
    } catch {
      setError(t("Bağlantı hatası, tekrar deneyin", "خطأ في الاتصال، حاول مرة أخرى"));
    } finally {
      setLoading(false);
    }
  };

  const confirmReady = keyword === "DELETE" && acknowledged;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !loading) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        dir={isAr ? "rtl" : "ltr"}
        className="w-full max-w-md animate-fade-in rounded-2xl border border-border bg-surface p-6 shadow-lg"
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="rounded-full bg-accent-red-bg/60 p-2 text-accent-red">
            <ExclamationTriangleIcon className="w-6 h-6" />
          </span>
          <div>
            <h2 id="delete-account-title" className="text-lg font-bold text-foreground">
              {t("Hesabı sil", "حذف الحساب")}
            </h2>
            <p className="text-sm text-muted" dir="ltr">
              {email}
            </p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-accent-red/30 bg-accent-red-bg/60 p-3 text-sm text-accent-red">
            {error}
          </div>
        )}

        {step === "warning" && (
          <>
            <p className="text-sm text-foreground leading-relaxed">
              {t(
                "Hesabınızı kalıcı olarak silmek üzeresiniz. Bu işlem geri alınamaz ve galeri videolarınız dahil tüm verileriniz kaybolur.",
                "أنت على وشك حذف حسابك نهائياً. لا يمكن التراجع عن هذه العملية وستفقد جميع بياناتك بما في ذلك فيديوهات المعرض."
              )}
            </p>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-surface-2"
              >
                {t("İptal", "إلغاء")}
              </button>
              <button
                type="button"
                onClick={() => setStep("password")}
                className="rounded-lg border border-accent-red/50 bg-accent-red-bg/30 px-5 py-2.5 text-sm font-semibold text-accent-red transition-colors hover:bg-accent-red/10"
              >
                {t("Devam Et", "متابعة")}
              </button>
            </div>
          </>
        )}

        {step === "password" && (
          <>
            <label className="mb-2 block text-sm font-medium text-foreground">
              {t("Kimliğinizi doğrulamak için şifrenizi girin", "أدخل كلمة المرور للتحقق من هويتك")}
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                dir="ltr"
                autoFocus
                className={`${INPUT_CLASSES} pl-4 pr-12`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && password && !loading) verifyPassword();
                }}
              />
              <button
                type="button"
                aria-label={showPassword ? t("Şifreyi gizle", "إخفاء كلمة المرور") : t("Şifreyi göster", "إظهار كلمة المرور")}
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer p-1 text-muted transition-colors hover:text-foreground"
              >
                {showPassword ? <EyeSlashIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
              </button>
            </div>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={loading}
                onClick={() => setStep("warning")}
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                {t("Geri", "رجوع")}
              </button>
              <button
                type="button"
                disabled={!password || loading}
                onClick={verifyPassword}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-accent-red/50 bg-accent-red-bg/30 px-5 py-2.5 text-sm font-semibold text-accent-red transition-colors hover:bg-accent-red/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading && <Spinner size="sm" className="border-accent-red/25 border-t-accent-red" />}
                {t("Doğrula", "تحقق")}
              </button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <p className="text-sm text-foreground leading-relaxed">
              {t(
                "Bu işlem geri alınamaz. Onaylamak için aşağıya DELETE yazın ve kutucuğu işaretleyin.",
                "لا يمكن التراجع عن هذه العملية. اكتب DELETE أدناه وحدد المربع للتأكيد."
              )}
            </p>
            <input
              type="text"
              required
              dir="ltr"
              autoFocus
              placeholder="DELETE"
              className={`${INPUT_CLASSES} mt-4 pl-4 pr-12`}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && confirmReady && !loading) deleteAccount();
              }}
            />
            <label className="mt-4 flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border text-accent-red focus:ring-accent-red"
              />
              <span className="text-sm text-foreground">
                {t(
                  "Hesabımın ve tüm verilerimin kalıcı olarak silineceğini anlıyorum.",
                  "أفهم أن حسابي وجميع بياناتي سيتم حذفها نهائياً."
                )}
              </span>
            </label>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                disabled={loading}
                onClick={() => setStep("password")}
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                {t("Geri", "رجوع")}
              </button>
              <button
                type="button"
                disabled={!confirmReady || loading}
                onClick={deleteAccount}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent-red px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading && <Spinner size="sm" className="border-white/40 border-t-white" />}
                {t("Kalıcı Olarak Sil", "حذف نهائياً")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
