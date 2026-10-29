"use client";

import Link from "next/link";
import Navbar from "@/components/layout/Navbar";
import { useT } from "@/lib/LanguageContext";

export default function NotFound() {
  const tx = useT();

  return (
    <div className="min-h-screen flex flex-col bg-background transition-colors duration-300">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-16">
        <div className="animate-fade-in relative overflow-hidden max-w-md w-full text-center bg-surface border border-primary/10 rounded-2xl p-8 shadow-lg">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary-light via-primary to-primary-dark" />
          <p className="text-6xl font-bold text-gradient-gold mb-3">404</p>
          <div className="bismillah-ornament mx-auto w-full max-w-[140px] mb-4" />
          <h1 className="text-lg font-semibold text-foreground mb-2">
            {tx("الصفحة غير موجودة", "Sayfa bulunamadı", "Page not found")}
          </h1>
          <p className="text-sm text-muted-foreground mb-6">
            {tx("الرابط الذي فتحته غير موجود أو تم نقله.", "Açtığınız bağlantı mevcut değil veya taşınmış olabilir.", "The link you opened doesn't exist or may have been moved.")}
          </p>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-primary to-primary-dark px-6 py-2.5 text-sm font-semibold text-white shadow-lg transition-all hover:shadow-primary/25"
          >
            {tx("العودة للرئيسية", "Ana sayfaya dön", "Back to home")}
          </Link>
        </div>
      </main>
    </div>
  );
}
