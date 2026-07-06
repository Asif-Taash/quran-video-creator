"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useState, useEffect, useCallback } from "react";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { useLanguage } from "@/lib/LanguageContext";



export default function Navbar() {
  const pathname = usePathname();
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
              <LanguageToggle />
              <ThemeToggle />
            </div>
          </div>
        </div>
      </nav>


    </>
  );
}
