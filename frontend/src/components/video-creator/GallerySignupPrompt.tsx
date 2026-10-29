"use client";

import Link from "next/link";
import { useT } from "@/lib/LanguageContext";

// Shown on /gallery in place of GalleryGrid whenever there is no logged-in
// session -- videos are never listed to a logged-out visitor, only this
// prompt to create an account or sign in.
export default function GallerySignupPrompt() {
  const tx = useT();

  return (
    <div className="rounded-2xl border border-dashed border-border/60 bg-surface/30 p-10 text-center space-y-4">
      <h1 className="text-xl font-bold text-foreground">
        {tx("فيديوهاتك السابقة بانتظارك", "Geçmiş videolarınız sizi bekliyor", "Your past videos are waiting for you")}
      </h1>
      <p className="text-sm text-muted max-w-md mx-auto">
        {tx("أنشئ حسابًا مجانيًا أو سجّل الدخول لحفظ فيديوهاتك ومشاهدتها في أي وقت.", "Videolarınızı kaydetmek ve istediğiniz zaman görüntülemek için ücretsiz bir hesap oluşturun veya giriş yapın.", "Create a free account or sign in to save your videos and view them anytime.")}
      </p>
      <div className="flex items-center justify-center gap-3 pt-2">
        <Link
          href="/signup"
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
        >
          {tx("إنشاء حساب", "Kayıt Ol", "Sign Up")}
        </Link>
        <Link
          href="/login"
          className="rounded-lg border border-border bg-background px-5 py-2.5 text-sm font-medium text-foreground hover:bg-surface transition-colors"
        >
          {tx("تسجيل الدخول", "Giriş Yap", "Sign In")}
        </Link>
      </div>
    </div>
  );
}
