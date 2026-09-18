"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useSearchParams } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import AccountMenu from "@/components/layout/AccountMenu";
import { useState, useEffect, useCallback } from "react";
import { Bars3Icon, XMarkIcon, PlusCircleIcon } from "@heroicons/react/24/outline";
import { useLanguage } from "@/lib/LanguageContext";



export default function Navbar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // "الفيديوهات المحفوظة"/gallery now lives on "/" itself as a tab (see
  // HomeTabs) rather than its own route -- these two links are the tab
  // switcher, so their active state has to account for the query param too,
  // not just the path.
  const isOnGalleryTab = pathname === "/" && searchParams.get("tab") === "gallery";
  const isOnCreateTab = pathname === "/" && !isOnGalleryTab;
  const { language } = useLanguage();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 12);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);



  return (
    <>
      <nav
        role="navigation"
        aria-label="Ana navigasyon"
        dir="ltr"
        className={`sticky top-0 z-50 transition-all duration-300 ${scrolled
            ? "bg-background/90 backdrop-blur-xl border-b border-border shadow-sm"
            : "bg-background/70 backdrop-blur-md border-b border-transparent"
          }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-20 lg:h-24">

            {/* Logo */}
            <Link
              href="/"
              className="flex items-center gap-2.5 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
              aria-label="Kuran Nuru — Ana sayfaya git"
            >
              <div className="relative w-16 h-16 lg:w-20 lg:h-20 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3">
                <Image
                  src="/kuran-nuru-logo.png"
                  alt=""
                  fill
                  className="object-contain drop-shadow-sm rounded-md mix-blend-multiply dark:mix-blend-normal"
                  priority
                />
              </div>
              <span className="text-xl font-bold tracking-tight text-gradient-gold whitespace-nowrap" dir="ltr">
                Kuran Nuru
              </span>
            </Link>

            {/* Desktop & Mobile Toggles */}
            <div className="flex items-center gap-2">
              {/* "فيديوهاتي" removed from here -- it now lives on the page
                  itself, right next to "مشروع جديد" in VideoCreatorForm's
                  own header (avoids showing the same destination twice). */}
              <Link
                href="/"
                className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isOnCreateTab
                    ? "bg-primary/10 text-primary"
                    : "text-foreground hover:bg-surface"
                }`}
              >
                <PlusCircleIcon className="h-5 w-5" />
                <span className="hidden sm:inline">{language === "ar" ? "إنشاء الفيديو" : "Video Oluştur"}</span>
              </Link>
              <LanguageToggle />
              <ThemeToggle />
              <AccountMenu />
            </div>
          </div>
        </div>
      </nav>


    </>
  );
}
