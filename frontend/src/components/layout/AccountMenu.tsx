"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserCircleIcon } from "@heroicons/react/24/outline";
import { useLanguage } from "@/lib/LanguageContext";

type Profile = { email: string; name: string | null; avatarUrl: string | null };

export default function AccountMenu() {
  const { language } = useLanguage();
  const isAr = language === "ar";
  const router = useRouter();

  const [mounted, setMounted] = React.useState(false);
  const [isOpen, setIsOpen] = React.useState(false);
  const [profile, setProfile] = React.useState<Profile | null>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const fetchProfile = React.useCallback(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setProfile(data ? { email: data.email, name: data.name ?? null, avatarUrl: data.avatarUrl ?? null } : null))
      .catch(() => setProfile(null));
  }, []);

  React.useEffect(() => {
    setMounted(true);
    fetchProfile();

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    // AccountSettings dispatches this after a successful name/avatar save
    // so an already-mounted menu on the SAME page (e.g. the account page
    // itself) picks it up immediately, without waiting for a fresh
    // navigation to remount this component.
    window.addEventListener("account:profile-updated", fetchProfile);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("account:profile-updated", fetchProfile);
    };
  }, [fetchProfile]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setProfile(null);
    setIsOpen(false);
    router.push("/");
    router.refresh();
  };

  if (!mounted) {
    return <div className="w-9 h-9" />;
  }

  const displayName = profile?.name?.trim() || profile?.email;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center p-1.5 rounded-full text-foreground hover:bg-surface transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
        aria-label={isAr ? "الحساب" : "Hesap"}
        title={isAr ? "الحساب" : "Hesap"}
      >
        {profile?.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={profile.avatarUrl}
            alt=""
            className={`h-7 w-7 rounded-full object-cover ring-2 transition-colors ${isOpen ? "ring-primary" : "ring-transparent"}`}
          />
        ) : (
          <UserCircleIcon className={`w-7 h-7 transition-colors ${isOpen ? "text-primary" : "text-foreground/70"}`} />
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-52 overflow-hidden rounded-xl bg-surface border border-border shadow-lg py-1 z-50 animate-fade-in origin-top-right">
          {profile ? (
            <>
              <div className="px-4 py-2.5 border-b border-border/60 mb-1">
                <p className="text-sm font-semibold text-foreground truncate">{displayName}</p>
                {profile.name && (
                  <p className="text-xs text-muted truncate" dir="ltr">
                    {profile.email}
                  </p>
                )}
              </div>
              <Link
                href="/account"
                onClick={() => setIsOpen(false)}
                className="block w-full text-right px-4 py-2 text-sm text-foreground hover:bg-primary/10 transition-colors"
                dir={isAr ? "rtl" : "ltr"}
              >
                {isAr ? "الحساب" : "Hesap"}
              </Link>
              <button
                onClick={handleLogout}
                className="w-full text-right px-4 py-2 text-sm text-foreground hover:bg-primary/10 transition-colors"
                dir={isAr ? "rtl" : "ltr"}
              >
                {isAr ? "تسجيل الخروج" : "Çıkış Yap"}
              </button>
            </>
          ) : (
            <>
              <Link
                href="/login"
                onClick={() => setIsOpen(false)}
                className="block w-full text-right px-4 py-2 text-sm text-foreground hover:bg-primary/10 transition-colors"
                dir={isAr ? "rtl" : "ltr"}
              >
                {isAr ? "تسجيل الدخول" : "Giriş Yap"}
              </Link>
              <Link
                href="/signup"
                onClick={() => setIsOpen(false)}
                className="block w-full text-right px-4 py-2 text-sm text-foreground hover:bg-primary/10 transition-colors"
                dir={isAr ? "rtl" : "ltr"}
              >
                {isAr ? "إنشاء حساب" : "Kayıt Ol"}
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
