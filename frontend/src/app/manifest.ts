import type { MetadataRoute } from "next";

// Installable on a phone (2026-11-26): «Ana ekrana ekle» gives an app icon
// that opens the memorization page full screen. The microphone needs HTTPS,
// so it is reached through Tailscale (`tailscale serve`) -- see README.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kuran Nuru — Hıfz",
    short_name: "Kuran Nuru",
    description: "Kuran ezberi: dinle, oku, ezberden oku; kelime kelime düzeltilsin.",
    start_url: "/hifz",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0C0A09",
    theme_color: "#0C0A09",
    lang: "tr",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
