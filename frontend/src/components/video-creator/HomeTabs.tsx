"use client";

import { useSearchParams } from "next/navigation";
import VideoCreatorForm from "./VideoCreatorForm";
import GalleryGrid from "./GalleryGrid";
import GallerySignupPrompt from "./GallerySignupPrompt";
import type { GalleryEntry } from "@/lib/videoGallery";

// Which of the two sections "/" shows -- driven entirely by the `?tab=`
// query param rather than its own local state, so Navbar's two links
// ("إنشاء الفيديو" / "فيديوهاتي") are the single source of truth for
// switching between them (a plain Link navigation, no extra in-page tab
// buttons needed) and both stay in sync automatically. Previously the
// saved-videos gallery lived on its own /gallery route; merged in here as a
// section of the same page instead, per the user's own request.
export default function HomeTabs({
  galleryEntries,
  isLoggedIn,
}: {
  galleryEntries: GalleryEntry[] | null;
  // Threaded down to VideoCreatorForm so it knows whether its background
  // auto-save-to-gallery render is even worth running -- the gallery is
  // login-gated (see render/route.ts's own `if (session)` guard), so for a
  // logged-out visitor that render would burn real server time only to be
  // silently discarded. Equivalent to `galleryEntries !== null`, but passed
  // explicitly rather than derived so VideoCreatorForm doesn't have to know
  // that null-vs-array is how the gallery tab encodes "no session" too.
  isLoggedIn: boolean;
}) {
  const searchParams = useSearchParams();
  const activeTab = searchParams.get("tab") === "gallery" ? "gallery" : "create";

  if (activeTab === "gallery") {
    // galleryEntries is null for a logged-out visitor (see page.tsx) --
    // videos are never listed without a session, only this signup prompt.
    return galleryEntries ? <GalleryGrid entries={galleryEntries} /> : <GallerySignupPrompt />;
  }

  return <VideoCreatorForm isLoggedIn={isLoggedIn} />;
}
