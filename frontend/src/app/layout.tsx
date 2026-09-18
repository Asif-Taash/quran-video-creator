import type { Metadata, Viewport } from "next";
import { Inter, Amiri } from "next/font/google";
import "./globals.css";
import "./pua-fonts.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { LanguageProvider } from "@/lib/LanguageContext";
import { TranslationProvider } from "@/lib/TranslationContext";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const amiri = Amiri({
  subsets: ["arabic"],
  weight: ["400", "700"],
  variable: "--font-amiri",
  display: "swap",
});

// The authentic KFGQPC Uthman Taha Naskh font is self-hosted in
// public/fonts/UthmanTN1Ver10.woff2 and declared via @font-face in globals.css

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FDFBF7" },
    { media: "(prefers-color-scheme: dark)", color: "#0C0A09" },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL("https://kurannuru.com"),
  title: {
    default: "Kuran Nuru — Dijital Kuran Uygulaması",
    template: "%s | Kuran Nuru",
  },
  description:
    "Kuran-ı Kerim'i zarif tipografi, güzel tilavetler ve Türkçe çevirilerle okuyun. 114 Sure, 6236 Ayet.",
  keywords: [
    "Kuran",
    "Quran",
    "Kur'an",
    "Sure",
    "Ayet",
    "Türkçe Kuran",
    "Diyanet",
    "İslam",
    "Hafız",
    "Tilevet",
  ],
  authors: [{ name: "Kuran Nuru" }],
  creator: "Kuran Nuru",
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  openGraph: {
    type: "website",
    locale: "tr_TR",
    alternateLocale: "ar_SA",
    url: "https://kurannuru.com",
    siteName: "Kuran Nuru",
    title: "Kuran Nuru — Dijital Kuran Uygulaması",
    description:
      "Kuran-ı Kerim'i zarif tipografi ve Türkçe çeviriyle okuyun.",
    images: [
      {
        url: "/kuran-nuru-logo.png",
        width: 512,
        height: 512,
        alt: "Kuran Nuru — Dijital Kuran Uygulaması",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Kuran Nuru",
    description: "Dijital Kuran Uygulaması",
    images: ["/kuran-nuru-logo.png"],
  },
  icons: {
    icon: "/kuran-nuru-favicon.png",
    shortcut: "/kuran-nuru-favicon.png",
    apple: "/kuran-nuru-favicon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="tr"
      suppressHydrationWarning
      className={`${inter.variable} ${amiri.variable}`}
    >
      <body className="font-sans bg-background text-foreground antialiased min-h-screen">
        <LanguageProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange={false}
          >
            <TranslationProvider>
              {/* Skip to main content for accessibility */}
              <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[9999] focus:px-4 focus:py-2 focus:bg-primary focus:text-white focus:rounded-lg focus:font-semibold focus:shadow-lg"
              >
                Ana içeriğe geç
              </a>
              {children}
            </TranslationProvider>
          </ThemeProvider>
        </LanguageProvider>
      </body>
    </html>
  );
}
