"use client";

import Link from "next/link";
import Image from "next/image";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useState, useEffect } from "react";

// The app is one page (the video creator), so the bar holds only the logo
// and the language/theme switches.
export default function Navbar() {
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
              <span className="text-lg sm:text-xl font-bold tracking-tight text-gradient-gold whitespace-nowrap" dir="ltr">
                Kuran Nuru
              </span>
            </Link>

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
