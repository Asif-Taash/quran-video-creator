"use client";

import * as React from "react";
import { useLanguage } from "@/lib/LanguageContext";
import DeleteAccountDialog from "@/components/account/DeleteAccountDialog";
import Spinner from "@/components/ui/Spinner";
import {
  CameraIcon,
  UserCircleIcon,
  XMarkIcon,
  CheckIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";

const INPUT_CLASSES =
  "w-full h-[50px] outline-none transition-all duration-300 rounded-xl border border-border bg-background shadow-sm hover:border-primary/30 hover:shadow-md text-sm font-medium focus:border-primary focus:ring-1 focus:ring-primary px-4";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 8;

type Props = {
  email: string;
  initialName: string | null;
  initialAvatarUrl: string | null;
  initialEmailVerified: boolean;
};

// Other mounted instances of AccountMenu (in Navbar) fetched /api/auth/me
// once on their own mount and have no reason to know this page just
// changed the name/avatar -- this fires once per successful save so any
// listener (see AccountMenu.tsx) can refetch and stay in sync without a
// full page reload. Purely a same-tab convenience; a fresh page load
// already picks up the change on its own via the server component above.
function broadcastProfileUpdated() {
  window.dispatchEvent(new Event("account:profile-updated"));
}

export default function AccountSettings({ email, initialName, initialAvatarUrl, initialEmailVerified }: Props) {
  const { language } = useLanguage();
  const isAr = language === "ar";
  const t = (ar: string, tr: string) => (isAr ? ar : tr);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const [name, setName] = React.useState(initialName ?? "");
  const [avatarUrl, setAvatarUrl] = React.useState(initialAvatarUrl);
  const [nameSaving, setNameSaving] = React.useState(false);
  const [nameSaved, setNameSaved] = React.useState(false);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = React.useState(false);
  const [avatarError, setAvatarError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [emailVerified, setEmailVerified] = React.useState(initialEmailVerified);
  const [verifySending, setVerifySending] = React.useState(false);
  const [devVerifyUrl, setDevVerifyUrl] = React.useState<string | null>(null);
  const [verifyError, setVerifyError] = React.useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [showPasswords, setShowPasswords] = React.useState(false);
  const [passwordSaving, setPasswordSaving] = React.useState(false);
  const [passwordSaved, setPasswordSaved] = React.useState(false);
  const [passwordError, setPasswordError] = React.useState<string | null>(null);

  const nameChanged = name.trim() !== (initialName ?? "");

  const saveName = async () => {
    setNameSaving(true);
    setNameError(null);
    setNameSaved(false);
    try {
      const formData = new FormData();
      formData.append("name", name.trim());
      const res = await fetch("/api/auth/profile", { method: "POST", body: formData });
      if (!res.ok) {
        setNameError(t("حدث خطأ، حاول مرة أخرى", "Bir hata oluştu, tekrar deneyin"));
        return;
      }
      setNameSaved(true);
      broadcastProfileUpdated();
      setTimeout(() => setNameSaved(false), 2500);
    } catch {
      setNameError(t("خطأ في الاتصال", "Bağlantı hatası"));
    } finally {
      setNameSaving(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    setAvatarError(null);
    if (file.size > MAX_AVATAR_BYTES) {
      setAvatarError(t("حجم الصورة كبير جداً (الحد الأقصى 5 ميجابايت)", "Görsel çok büyük (en fazla 5MB)"));
      return;
    }
    setAvatarBusy(true);
    // Optimistic local preview -- swapped for the server-saved URL the
    // instant the upload confirms, same pattern used for the video
    // background image elsewhere in this app.
    const localPreview = URL.createObjectURL(file);
    setAvatarUrl(localPreview);
    try {
      const formData = new FormData();
      formData.append("avatar", file);
      const res = await fetch("/api/auth/profile", { method: "POST", body: formData });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setAvatarError(t("تعذر رفع الصورة", "Görsel yüklenemedi"));
        setAvatarUrl(initialAvatarUrl);
        return;
      }
      setAvatarUrl(data.avatarUrl ?? null);
      broadcastProfileUpdated();
    } catch {
      setAvatarError(t("خطأ في الاتصال", "Bağlantı hatası"));
      setAvatarUrl(initialAvatarUrl);
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    setAvatarError(null);
    setAvatarBusy(true);
    const previous = avatarUrl;
    setAvatarUrl(null);
    try {
      const formData = new FormData();
      formData.append("removeAvatar", "true");
      const res = await fetch("/api/auth/profile", { method: "POST", body: formData });
      if (!res.ok) {
        setAvatarError(t("تعذر حذف الصورة", "Görsel kaldırılamadı"));
        setAvatarUrl(previous);
        return;
      }
      broadcastProfileUpdated();
    } catch {
      setAvatarError(t("خطأ في الاتصال", "Bağlantı hatası"));
      setAvatarUrl(previous);
    } finally {
      setAvatarBusy(false);
    }
  };

  const resendVerification = async () => {
    setVerifySending(true);
    setVerifyError(null);
    setDevVerifyUrl(null);
    try {
      const res = await fetch("/api/auth/verify-email/request", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setVerifyError(t("حدث خطأ، حاول مرة أخرى", "Bir hata oluştu, tekrar deneyin"));
        return;
      }
      if (data?.alreadyVerified) {
        setEmailVerified(true);
        return;
      }
      setDevVerifyUrl(data?.devVerifyUrl ?? null);
    } catch {
      setVerifyError(t("خطأ في الاتصال", "Bağlantı hatası"));
    } finally {
      setVerifySending(false);
    }
  };

  // Two-click arm/confirm instead of a full modal -- this only ever touches
  // ephemeral render output/temp audio/generated backgrounds and unsaved
  // drafts (see /api/video/cleanup), never the saved gallery, so it doesn't
  // warrant the same multi-step friction as account deletion.
  const [cleanupArmed, setCleanupArmed] = React.useState(false);
  const [cleanupRunning, setCleanupRunning] = React.useState(false);
  const [cleanupDone, setCleanupDone] = React.useState(false);
  const [cleanupError, setCleanupError] = React.useState<string | null>(null);

  const clearTempFiles = async () => {
    if (!cleanupArmed) {
      setCleanupArmed(true);
      return;
    }
    setCleanupRunning(true);
    setCleanupError(null);
    setCleanupDone(false);
    try {
      const res = await fetch("/api/video/cleanup", { method: "DELETE" });
      if (!res.ok) {
        setCleanupError(t("حدث خطأ، حاول مرة أخرى", "Bir hata oluştu, tekrar deneyin"));
        return;
      }
      setCleanupDone(true);
      setTimeout(() => setCleanupDone(false), 3000);
    } catch {
      setCleanupError(t("خطأ في الاتصال", "Bağlantı hatası"));
    } finally {
      setCleanupRunning(false);
      setCleanupArmed(false);
    }
  };

  const passwordFormValid =
    currentPassword.length > 0 && newPassword.length >= MIN_PASSWORD_LENGTH && newPassword === confirmPassword;

  const changePassword = async () => {
    setPasswordSaving(true);
    setPasswordError(null);
    setPasswordSaved(false);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error === "invalid_password") {
          setPasswordError(t("كلمة المرور الحالية غير صحيحة", "Mevcut şifre hatalı"));
        } else if (data.error === "weak_password") {
          setPasswordError(t(`كلمة المرور الجديدة يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل`, `Yeni şifre en az ${MIN_PASSWORD_LENGTH} karakter olmalı`));
        } else {
          setPasswordError(t("حدث خطأ، حاول مرة أخرى", "Bir hata oluştu, tekrar deneyin"));
        }
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordSaved(true);
      setTimeout(() => setPasswordSaved(false), 2500);
    } catch {
      setPasswordError(t("خطأ في الاتصال", "Bağlantı hatası"));
    } finally {
      setPasswordSaving(false);
    }
  };

  return (
    <>
      <div className="relative max-w-md mx-auto">
        <div className="absolute -top-16 left-1/2 -translate-x-1/2 h-40 w-40 rounded-full bg-primary/20 blur-3xl -z-10" />
        <div className="rounded-2xl border border-border bg-surface shadow-soft p-8">
          <h1 className="text-xl font-bold text-foreground mb-8 text-center">
            {t("الحساب", "Hesap")}
          </h1>

          {/* Avatar */}
          <div className="flex flex-col items-center gap-3 mb-8">
            <div className="relative group">
              <div className="h-24 w-24 rounded-full overflow-hidden border-2 border-primary/30 bg-background flex items-center justify-center shadow-soft">
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <UserCircleIcon className="h-16 w-16 text-muted" />
                )}
                {avatarBusy && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <Spinner size="sm" className="border-white/40 border-t-white" />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={avatarBusy}
                aria-label={t("تغيير الصورة", "Fotoğrafı değiştir")}
                className="absolute bottom-0 right-0 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-white shadow-md ring-2 ring-surface transition-transform hover:scale-110 disabled:opacity-50"
              >
                <CameraIcon className="h-4 w-4" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadAvatar(file);
                  e.target.value = "";
                }}
              />
            </div>
            {avatarUrl && !avatarBusy && (
              <button
                type="button"
                onClick={removeAvatar}
                className="text-xs text-muted hover:text-accent-red transition-colors"
              >
                {t("إزالة الصورة", "Fotoğrafı kaldır")}
              </button>
            )}
            {avatarError && <p className="text-xs text-accent-red">{avatarError}</p>}
          </div>

          {/* Name */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              {t("الاسم", "Ad")}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                maxLength={60}
                dir={isAr ? "rtl" : "ltr"}
                placeholder={t("أضف اسمك", "Adınızı ekleyin")}
                className={INPUT_CLASSES}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameSaved(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && nameChanged && !nameSaving) saveName();
                }}
              />
              <button
                type="button"
                onClick={saveName}
                disabled={!nameChanged || nameSaving}
                className="flex-shrink-0 inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {nameSaving ? (
                  <Spinner size="sm" className="border-white/40 border-t-white" />
                ) : nameSaved ? (
                  <CheckIcon className="h-4 w-4" />
                ) : (
                  t("حفظ", "Kaydet")
                )}
              </button>
            </div>
            {nameError && <p className="text-xs text-accent-red">{nameError}</p>}
          </div>

          {/* Email */}
          <div className="space-y-2 mt-6">
            <label className="text-sm font-medium text-foreground">
              {t("البريد الإلكتروني", "E-posta")}
            </label>
            <div className="w-full h-[50px] flex items-center rounded-xl border border-border bg-background px-4 text-sm text-muted" dir="ltr">
              {email}
            </div>
          </div>

          {/* Email verification */}
          {!emailVerified && (
            <div className="mt-6 rounded-xl border border-accent-amber/30 bg-accent-amber-bg/30 p-4">
              <div className="flex items-start gap-2.5">
                <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0 text-accent-amber mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm text-foreground leading-relaxed">
                    {t("بريدك الإلكتروني غير مؤكد بعد.", "E-posta adresiniz henüz doğrulanmadı.")}
                  </p>
                  {devVerifyUrl ? (
                    <a
                      href={devVerifyUrl}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-accent-amber/15 px-3 py-1.5 text-xs font-semibold text-accent-amber hover:bg-accent-amber/25 transition-colors"
                      dir="ltr"
                    >
                      {t("فتح رابط التأكيد (وضع تطوير -- لا يوجد بريد فعلي)", "Doğrulama linki (dev mod -- gerçek e-posta yok)")}
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={resendVerification}
                      disabled={verifySending}
                      className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-accent-amber hover:underline disabled:opacity-50"
                    >
                      {verifySending && <Spinner size="sm" className="border-accent-amber/30 border-t-accent-amber" />}
                      {t("إرسال رابط التأكيد", "Doğrulama linki gönder")}
                    </button>
                  )}
                  {verifyError && <p className="mt-1.5 text-xs text-accent-red">{verifyError}</p>}
                </div>
              </div>
            </div>
          )}

          {/* Change password */}
          <div className="mt-6 rounded-xl border border-border bg-background/50 p-5">
            <h2 className="text-sm font-bold text-foreground mb-4">
              {t("تغيير كلمة المرور", "Şifreyi Değiştir")}
            </h2>
            <div className="space-y-3" dir="ltr">
              <input
                type={showPasswords ? "text" : "password"}
                placeholder={t("كلمة المرور الحالية", "Mevcut şifre")}
                className={INPUT_CLASSES}
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                  setPasswordError(null);
                }}
              />
              <div className="relative">
                <input
                  type={showPasswords ? "text" : "password"}
                  placeholder={t("كلمة المرور الجديدة", "Yeni şifre")}
                  className={`${INPUT_CLASSES} pr-12`}
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setPasswordError(null);
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPasswords((prev) => !prev)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer p-1 text-muted transition-colors hover:text-foreground"
                >
                  {showPasswords ? <EyeSlashIcon className="w-5 h-5" /> : <EyeIcon className="w-5 h-5" />}
                </button>
              </div>
              <input
                type={showPasswords ? "text" : "password"}
                placeholder={t("تأكيد كلمة المرور الجديدة", "Yeni şifreyi onayla")}
                className={INPUT_CLASSES}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  setPasswordError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && passwordFormValid && !passwordSaving) changePassword();
                }}
              />
            </div>
            {newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH && (
              <p className="mt-2 text-xs text-muted">
                {t(`${MIN_PASSWORD_LENGTH} أحرف على الأقل`, `En az ${MIN_PASSWORD_LENGTH} karakter`)}
              </p>
            )}
            {confirmPassword.length > 0 && newPassword !== confirmPassword && (
              <p className="mt-2 text-xs text-accent-red">
                {t("كلمتا المرور غير متطابقتين", "Şifreler eşleşmiyor")}
              </p>
            )}
            {passwordError && <p className="mt-2 text-xs text-accent-red">{passwordError}</p>}
            <button
              type="button"
              onClick={changePassword}
              disabled={!passwordFormValid || passwordSaving}
              className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {passwordSaving ? (
                <Spinner size="sm" className="border-white/40 border-t-white" />
              ) : passwordSaved ? (
                <CheckIcon className="h-4 w-4" />
              ) : null}
              {t("تحديث كلمة المرور", "Şifreyi Güncelle")}
            </button>
          </div>

          {/* Clear temporary files */}
          <div className="mt-6 rounded-xl border border-border bg-background/50 p-5">
            <h2 className="text-sm font-bold text-foreground mb-2">
              {t("الملفات المؤقتة", "Geçici Dosyalar")}
            </h2>
            <p className="text-sm text-muted leading-relaxed mb-4">
              {t(
                "امسح الصور والفيديوهات والأصوات المؤقتة المتبقية من الجلسات والمسودات السابقة لتوفير مساحة التخزين. فيديوهات معرضك المحفوظة لن تتأثر.",
                "Depolama alanı boşaltmak için önceki oturum ve taslaklardan kalan geçici görsel, video ve ses dosyalarını temizleyin. Kaydedilmiş galeri videolarınız etkilenmez."
              )}
            </p>
            {cleanupError && <p className="mb-3 text-xs text-accent-red">{cleanupError}</p>}
            {cleanupArmed && !cleanupRunning && (
              <p className="mb-3 text-xs text-accent-amber">
                {t("اضغط مرة أخرى للتأكيد", "Onaylamak için tekrar tıklayın")}
              </p>
            )}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={clearTempFiles}
                disabled={cleanupRunning}
                className={`inline-flex items-center gap-2 rounded-lg border px-5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  cleanupArmed
                    ? "border-accent-amber/50 bg-accent-amber/10 text-accent-amber hover:bg-accent-amber/20"
                    : "border-border text-foreground hover:bg-surface-2"
                }`}
              >
                {cleanupRunning ? (
                  <Spinner size="sm" className="border-primary/30 border-t-primary" />
                ) : cleanupDone ? (
                  <CheckIcon className="h-4 w-4" />
                ) : (
                  <TrashIcon className="h-4 w-4" />
                )}
                {cleanupDone
                  ? t("تم المسح", "Temizlendi")
                  : cleanupArmed
                    ? t("تأكيد المسح", "Silmeyi Onayla")
                    : t("مسح الملفات المؤقتة", "Geçici Dosyaları Temizle")}
              </button>
              {cleanupArmed && !cleanupRunning && (
                <button
                  type="button"
                  onClick={() => setCleanupArmed(false)}
                  className="text-xs text-muted hover:text-foreground transition-colors"
                >
                  {t("إلغاء", "İptal")}
                </button>
              )}
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-accent-red/30 bg-accent-red-bg/40 p-5">
            <h2 className="text-sm font-bold text-accent-red mb-2">
              {t("منطقة الخطر", "Tehlikeli Bölge")}
            </h2>
            <p className="text-sm text-foreground leading-relaxed mb-4">
              {t(
                "حذف حسابك يؤدي إلى إزالة جميع بياناتك نهائياً. لا يمكن التراجع عن هذه العملية.",
                "Hesabınızı silmek tüm verilerinizi kalıcı olarak kaldırır. Bu işlem geri alınamaz."
              )}
            </p>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-accent-red/50 bg-accent-red/10 px-5 py-2.5 text-sm font-semibold text-accent-red transition-colors hover:bg-accent-red/20"
            >
              <XMarkIcon className="h-4 w-4" />
              {t("حذف الحساب", "Hesabı Sil")}
            </button>
          </div>
        </div>
      </div>

      <DeleteAccountDialog open={dialogOpen} email={email} onClose={() => setDialogOpen(false)} />
    </>
  );
}
