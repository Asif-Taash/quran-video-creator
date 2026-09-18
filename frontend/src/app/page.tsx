import Navbar from "@/components/layout/Navbar";
import type { Metadata } from "next";
import HomeTabs from "@/components/video-creator/HomeTabs";
import AccountDeletedBanner from "@/components/account/AccountDeletedBanner";
import { listGalleryEntries } from "@/lib/videoGallery";
import { getSession } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Kuran Nuru",
  description: "Kuran Nuru",
};

// Now also reads the gallery manifest for the "فيديوهاتي" tab (see
// HomeTabs) -- must always be fresh at request time, same reasoning the old
// standalone /gallery route had: a save (render/route.ts) or a delete must
// show up on the very next visit, never served from a stale build-time
// snapshot.
export const dynamic = "force-dynamic";

export default async function VideoCreatorPage({
  searchParams,
}: {
  searchParams: { deleted?: string; tab?: string };
}) {
  const session = await getSession();
  // null (not just an empty array) specifically means "no session" -- see
  // HomeTabs, which shows GallerySignupPrompt only in that case, not for a
  // logged-in user who simply has zero saved videos yet.
  const galleryEntries = session ? await listGalleryEntries(session.id) : null;

  return (
    <div className="min-h-screen bg-background transition-colors duration-300">
      <Navbar />
      <main className="px-4 py-12 md:py-16">
        {searchParams?.deleted === "1" && <AccountDeletedBanner />}
        <HomeTabs galleryEntries={galleryEntries} isLoggedIn={Boolean(session)} />
      </main>
    </div>
  );
}
