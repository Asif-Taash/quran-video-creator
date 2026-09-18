import { redirect } from "next/navigation";

// The saved-videos gallery moved onto "/" itself as a tab (see HomeTabs) --
// this route now only exists so an old bookmarked/shared /gallery link
// still lands somewhere useful instead of a stale page or a 404.
export default function GalleryRedirect() {
  redirect("/?tab=gallery");
}
