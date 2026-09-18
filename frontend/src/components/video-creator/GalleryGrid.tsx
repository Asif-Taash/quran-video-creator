"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { TrashIcon, ArrowDownTrayIcon, ArrowRightIcon, PencilSquareIcon, FilmIcon } from "@heroicons/react/24/outline";
import { useLanguage } from "@/lib/LanguageContext";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { latinNameForArabicReciterName } from "@/lib/reciterNames";
import type { GalleryEntry } from "@/lib/videoGallery";

const ASPECT_RATIO_LABEL: Record<GalleryEntry["aspectRatio"], { ar: string; tr: string }> = {
  portrait: { ar: "عمودي", tr: "Dikey" },
  landscape: { ar: "أفقي", tr: "Yatay" },
  square: { ar: "مربع", tr: "Kare" },
};

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatDate(iso: string, locale: string): string {
  try {
    return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export default function GalleryGrid({ entries: initialEntries }: { entries: GalleryEntry[] }) {
  const { language } = useLanguage();
  const isArabic = language === "ar";
  const [entries, setEntries] = useState(initialEntries);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const router = useRouter();

  // page.tsx re-reads the manifest on every request (force-dynamic), so a
  // router.refresh() below re-renders this component with fresh `entries` --
  // but useState's initial value only applies on mount, so without this the
  // grid would keep showing whatever was here when the tab first loaded even
  // after a refresh hands it new props. Kept as a separate sync effect
  // (rather than deriving straight from the prop) so handleDelete's own
  // optimistic removal above isn't immediately undone by a refresh that
  // hasn't caught up yet.
  useEffect(() => {
    setEntries(initialEntries);
  }, [initialEntries]);

  // Videos created or edited from the "إنشاء فيديو" tab are now saved/updated
  // in the background as the user works (see VideoCreatorForm.tsx's debounced
  // auto-render) -- if this gallery tab happens to be open in another tab/
  // window at the same time, or the user just switches back to it, a plain
  // router.refresh() re-runs page.tsx's manifest read so the card reflects
  // that latest save without needing a manual full page reload. Paused
  // whenever the tab isn't visible so it doesn't burn a request a minute for
  // nobody to see.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const intervalId = setInterval(tick, 15000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/video/gallery/${id}`, { method: "DELETE" });
      if (res.ok) {
        setEntries((prev) => prev.filter((e) => e.id !== id));
      }
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6" dir={isArabic ? "rtl" : "ltr"}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-border/50 bg-gradient-to-br from-surface/80 to-background p-5 shadow-inner-soft">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FilmIcon className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-foreground">
              {isArabic ? "الفيديوهات المحفوظة" : "Kaydedilen Videolar"}
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {isArabic
                ? `آخر ${entries.length} فيديو أنشأته يبقى هنا للتنزيل لاحقًا.`
                : `Oluşturduğunuz son ${entries.length} video burada, daha sonra indirmeniz için tutulur.`}
            </p>
          </div>
        </div>
        <Link
          href="/"
          className="flex-shrink-0 flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-primary to-primary-dark px-4 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:shadow-lg hover:shadow-primary/25"
        >
          {isArabic ? "إنشاء فيديو جديد" : "Yeni Video Oluştur"}
          <ArrowRightIcon className={`h-4 w-4 ${isArabic ? "rotate-180" : ""}`} />
        </Link>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 bg-surface/30 p-10 text-center text-muted-foreground">
          {isArabic
            ? "لا توجد فيديوهات محفوظة بعد. أنشئ فيديو من الصفحة الرئيسية وستظهر هنا تلقائيًا."
            : "Henüz kaydedilmiş video yok. Ana sayfadan bir video oluşturun, otomatik olarak burada görünecek."}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {entries.map((entry) => {
            // Cache-busted on updatedAt (falls back to createdAt for an
            // entry that's never been re-rendered) -- this same id's mp4 can
            // now be overwritten in place by a later edit (see
            // saveToGallery's upsert), and without this the browser would
            // keep showing whatever it already cached at this exact URL
            // instead of the newer file underneath it.
            const videoSrc = `/api/serve-audio?file=render-assets/gallery/${entry.id}.mp4&v=${encodeURIComponent(entry.updatedAt ?? entry.createdAt)}`;
            const downloadName = `${entry.surahNameTransliteration}-${entry.startVerse}-${entry.endVerse}.mp4`;
            const ratioLabel = ASPECT_RATIO_LABEL[entry.aspectRatio];
            // Falls back to a reverse Arabic->Latin lookup for any entry
            // saved before reciterNameLatin existed (see reciterNames.ts) --
            // so an older video's card still shows a Turkish reciter name
            // instead of silently reverting to Arabic.
            const reciterDisplay =
              entry.reciterNameLatin ?? latinNameForArabicReciterName(entry.reciterName) ?? entry.reciterName;

            return (
              <div
                key={entry.id}
                className="group rounded-2xl border border-border/60 bg-surface overflow-hidden flex flex-col shadow-sm transition-all hover:border-primary/30 hover:shadow-lg"
              >
                <video
                  src={videoSrc}
                  controls
                  preload="metadata"
                  className="w-full bg-black"
                  style={{
                    aspectRatio: entry.aspectRatio === "landscape" ? "16 / 9" : entry.aspectRatio === "square" ? "1 / 1" : "9 / 16",
                    maxHeight: 360,
                  }}
                />
                <div className="p-4 space-y-2.5 flex-1 flex flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold text-foreground truncate" dir={isArabic ? "rtl" : "ltr"}>
                        {/* surahNameTransliteration is the plain Turkish name
                            (already uppercased, tr-TR) -- " SURESİ" appended
                            the same way QuranVideo.tsx's own header does it, so
                            this matches the video's own on-screen title exactly. */}
                        {isArabic ? entry.surahNameArabic : `${entry.surahNameTransliteration} SURESİ`}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {isArabic ? "آية" : "Ayet"} {entry.startVerse}-{entry.endVerse} ·{" "}
                        {isArabic ? entry.reciterName : reciterDisplay}
                      </p>
                    </div>
                    <span className="flex-shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
                      {isArabic ? ratioLabel.ar : ratioLabel.tr}
                    </span>
                  </div>

                  <p className="text-xs text-muted-foreground" dir="ltr">
                    {formatDate(entry.createdAt, isArabic ? "ar" : "tr-TR")} · {formatSize(entry.sizeBytes)}
                  </p>
                  {/* Only shown once this entry has actually been
                      re-rendered at least once since its first save (see
                      saveToGallery's upsert-by-draftId) -- i.e. the user
                      came back and edited this same project, whether via the
                      Edit button or just leaving the create tab open. Absent
                      entirely for a video saved only once, so the card isn't
                      cluttered with a redundant second timestamp identical to
                      the one right above. */}
                  {entry.updatedAt && entry.updatedAt !== entry.createdAt && (
                    <p className="text-xs text-primary/80" dir="ltr">
                      {isArabic ? "آخر تحديث: " : "Son güncelleme: "}
                      {formatDate(entry.updatedAt, isArabic ? "ar" : "tr-TR")}
                    </p>
                  )}

                  <div className="flex gap-2 mt-auto pt-2">
                    <a
                      href={videoSrc}
                      download={downloadName}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-primary to-primary-dark py-2 text-sm font-semibold text-white transition-all hover:shadow-md hover:shadow-primary/25"
                    >
                      <ArrowDownTrayIcon className="h-4 w-4" />
                      {isArabic ? "تنزيل" : "İndir"}
                    </a>
                    {/* Only ever present for a video rendered after this field
                        was introduced (see GalleryEntry.draftId) -- an older
                        entry has no draft left to restore, so the button is
                        simply not shown for it rather than linking to
                        something that 404s. Sends the user back to the exact
                        project (surah, verses, background, audio, timing,
                        fonts) that produced THIS video, not a blank one --
                        see VideoCreatorForm's `?draft=` resume effect. */}
                    {entry.draftId && (
                      <Link
                        href={`/?draft=${entry.draftId}`}
                        title={isArabic ? "تعديل" : "Düzenle"}
                        className="flex items-center justify-center rounded-lg border border-border px-3 text-primary hover:bg-primary/10 transition-colors"
                      >
                        <PencilSquareIcon className="h-4 w-4" />
                      </Link>
                    )}
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(entry.id)}
                      disabled={deletingId === entry.id}
                      className="flex items-center justify-center rounded-lg border border-border px-3 text-accent-red hover:bg-accent-red-bg/60 transition-colors disabled:opacity-50"
                      title={isArabic ? "حذف" : "Sil"}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title={isArabic ? "حذف الفيديو" : "Videoyu Sil"}
        message={isArabic ? "هل تريد حذف هذا الفيديو نهائيًا؟" : "Bu videoyu kalıcı olarak silmek istiyor musunuz?"}
        confirmLabel={isArabic ? "حذف" : "Sil"}
        cancelLabel={isArabic ? "إلغاء" : "İptal"}
        onConfirm={() => {
          if (confirmDeleteId) handleDelete(confirmDeleteId);
        }}
        onClose={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
