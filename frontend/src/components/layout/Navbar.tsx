"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { BookOpenIcon, FilmIcon } from "@heroicons/react/24/outline";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useT } from "@/lib/LanguageContext";
import { useState, useEffect } from "react";

// The logo, the two pages (the video creator and memorization, /hifz) and
// the language/theme switches. On a phone the two pages show as icons only,
// so everything fits one row at 360px.
export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const tx = useT();
  const pages = [
    { href: "/", label: tx("الفيديو", "Video", "Video"), title: tx("صانع الفيديو القرآني", "Kuran videosu oluşturucu", "Quran video creator"), Icon: FilmIcon },
    { href: "/hifz", label: tx("الحفظ", "Hıfz", "Memorize"), title: tx("الحفظ والتسميع", "Hıfz ve ezber kontrolü", "Memorize & recite"), Icon: BookOpenIcon },
  ];

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
          <div className="flex justify-between items-center gap-2 h-16 sm:h-20 lg:h-24">

            {/* Logo */}
            <Link
              href="/"
              className="flex min-w-0 items-center gap-2 sm:gap-2.5 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg"
              aria-label="Kuran Nuru — Ana sayfaya git"
            >
              <div className="relative w-12 h-12 flex-shrink-0 sm:w-16 sm:h-16 lg:w-20 lg:h-20 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3">
                <Image
                  src="/kuran-nuru-logo.png"
                  alt=""
                  fill
                  className="object-contain drop-shadow-sm rounded-md mix-blend-multiply dark:mix-blend-normal"
                  priority
                />
              </div>
              <span className="hidden xs:inline text-lg sm:text-xl font-bold tracking-tight text-gradient-gold whitespace-nowrap" dir="ltr">
                Kuran Nuru
              </span>
            </Link>

            {/* The two pages, in the same tray style as the app's segmented controls. */}
            <div className="flex flex-shrink-0 gap-1 rounded-xl bg-primary/[0.06] p-1 ring-1 ring-inset ring-primary/10">
              {pages.map(({ href, label, title, Icon }) => {
                const active = href === "/" ? pathname === "/" : pathname?.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    title={title}
                    aria-label={title}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-all duration-200 sm:px-3 ${
                      active
                        ? "bg-surface text-primary-dark shadow-sm ring-1 ring-primary/25 dark:text-primary-light"
                        : "text-muted-foreground hover:bg-surface/60 hover:text-foreground"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="hidden sm:inline">{label}</span>
                  </Link>
                );
              })}
            </div>

            {/* Desktop & Mobile Toggles */}
            <div className="flex flex-shrink-0 items-center gap-1 sm:gap-2">
              <LanguageToggle />
              <ThemeToggle />
            </div>
          </div>
        </div>
      </nav>


    </>
  );
}
