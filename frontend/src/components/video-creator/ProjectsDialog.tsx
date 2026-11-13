"use client";

import { useEffect, useState } from "react";
import { BookOpenIcon, FilmIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useLanguage, useT } from "@/lib/LanguageContext";
import { RECITER_ARABIC_NAMES, RECITER_DISPLAY_NAMES } from "@/lib/reciterNames";
import { fixMojibake } from "@/lib/textEncoding";

// One row of GET /api/drafts.
type ProjectSummary = {
  id: string;
  updatedAt: string;
  surahId: number;
  startVerse: number | null;
  endVerse: number | null;
  audioSourceMode: string;
  selectedReciter: string | null;
  customAudioName: string | null;
  backgroundUrl: string | null;
  hasBackgroundVideo: boolean;
  // The copy an export keeps of the project as it was exported
  // (api/drafts/[id]/snapshot). It never changes: opening it opens a new
  // project copied from it.
  exportedAt: string | null;
  exportName: string | null;
};

type Props = {
  currentDraftId: string | null;
  surahs: { id: number; name: string; transliteration: string }[];
  // false when it couldn't be opened (the dialog stays usable).
  onOpen: (id: string, isExport: boolean) => Promise<boolean | void> | void;
  onClose: () => void;
};

// "مشاريعي": every project saved on this machine (each one is a draft that
// autosave keeps up to date), to reopen or delete, and a fixed copy of
// each exported video. The open project can't
// be deleted from here: its next autosave would bring it back half-saved.
export default function ProjectsDialog({ currentDraftId, surahs, onOpen, onClose }: Props) {
  const { language } = useLanguage();
  const tx = useT();
  const isArabic = language === "ar";
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/drafts", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => alive && setProjects(data.drafts ?? []))
      .catch(() => alive && setLoadFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const deleteProject = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/drafts/${id}`, { method: "DELETE" });
      if (res.ok) setProjects((prev) => prev?.filter((p) => p.id !== id) ?? null);
    } catch {
      // Left in the list: nothing was deleted.
    } finally {
      setBusyId(null);
      setConfirmDeleteId(null);
    }
  };

  const dateFormat = new Intl.DateTimeFormat(isArabic ? "ar-u-nu-latn" : language === "en" ? "en-GB" : "tr-TR", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const describe = (p: ProjectSummary) => {
    const surah = surahs.find((s) => s.id === p.surahId);
    const surahName = surah ? fixMojibake(isArabic ? surah.name : surah.transliteration) : "";
    const verses =
      p.startVerse === null
        ? ""
        : p.endVerse === null || p.endVerse === p.startVerse
          ? `${tx("الآية", "Ayet", "Ayah")} ${p.startVerse}`
          : `${tx("الآيات", "Ayetler", "Ayahs")} ${p.startVerse}–${p.endVerse}`;
    const audio =
      p.audioSourceMode === "custom"
        ? p.customAudioName || tx("تلاوة مرفوعة", "Yüklenen ses", "Uploaded audio")
        : (p.selectedReciter && (isArabic ? RECITER_ARABIC_NAMES : RECITER_DISPLAY_NAMES)[p.selectedReciter]) || "";
    return { surahName, verses, audio };
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="projects-dialog-title"
        dir={isArabic ? "rtl" : "ltr"}
        className="flex max-h-[85vh] w-full max-w-lg animate-fade-in flex-col rounded-2xl border border-border bg-surface shadow-lg md:max-h-[90vh] md:max-w-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4 md:px-6">
          <h2 id="projects-dialog-title" className="text-lg font-bold text-foreground md:text-xl">
            {tx("مشاريعي", "Projelerim", "My Projects")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={tx("إغلاق", "Kapat", "Close")}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-4 md:p-5">
          {loadFailed ? (
            <p className="py-8 text-center text-sm text-accent-red">
              {tx("تعذر تحميل المشاريع.", "Projeler yüklenemedi.", "Couldn't load the projects.")}
            </p>
          ) : projects === null ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{tx("جارٍ التحميل…", "Yükleniyor…", "Loading…")}</p>
          ) : projects.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {tx(
                "لا توجد مشاريع بعد. يُحفظ كل مشروع هنا تلقائيًا بمجرد اختيار السورة والآيات.",
                "Henüz proje yok. Sure ve ayetleri seçtiğinizde her proje buraya otomatik kaydedilir.",
                "No projects yet. Each project is saved here automatically once you pick the surah and ayahs."
              )}
            </p>
          ) : (
            <>
            {projects.some((p) => p.exportedAt) && (
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground md:text-sm">
                {tx(
                  "🎬 الفيديو المُصدَّر يبقى كما صُدِّر، وفتحه يُنشئ مشروعاً جديداً منه للتعديل.",
                  "🎬 Dışa aktarılan video olduğu gibi kalır; açınca ondan düzenlenecek yeni bir proje oluşur.",
                  "🎬 An exported video stays as it was exported; opening it makes a new project from it to edit."
                )}
              </p>
            )}
            <ul className="space-y-2 md:space-y-3">
              {projects.map((p) => {
                const { surahName, verses, audio } = describe(p);
                const isCurrent = p.id === currentDraftId;
                const busy = busyId === p.id;
                return (
                  <li
                    key={p.id}
                    className={`flex items-center gap-3 rounded-xl border p-3 md:gap-4 md:p-4 ${
                      isCurrent ? "border-primary/50 bg-primary/5" : "border-border bg-background"
                    }`}
                  >
                    <div className="flex h-14 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface text-muted-foreground md:h-20 md:w-14">
                      {p.backgroundUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.backgroundUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                      ) : p.hasBackgroundVideo ? (
                        <FilmIcon className="h-5 w-5" />
                      ) : (
                        <BookOpenIcon className="h-5 w-5" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      {/* Wraps instead of truncating: on a phone the ayah
                          numbers are what got cut off. */}
                      <p className="text-sm leading-snug text-foreground md:text-base">
                        <span className="font-semibold">{surahName}</span>
                        {verses && <span className="whitespace-nowrap">{surahName ? " · " : ""}{verses}</span>}
                      </p>
                      {audio && <p className="truncate text-xs text-muted-foreground md:mt-0.5 md:text-sm">{audio}</p>}
                      {p.exportedAt ? (
                        <p className="text-[11px] font-medium text-primary-dark md:mt-0.5 md:text-xs">
                          🎬 {tx("فيديو مُصدَّر", "Dışa aktarılan video", "Exported video")} · {dateFormat.format(new Date(p.exportedAt))}
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground md:mt-0.5 md:text-xs">{dateFormat.format(new Date(p.updatedAt))}</p>
                      )}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1.5 md:gap-2">
                      {isCurrent ? (
                        <span className="whitespace-nowrap rounded-full border border-primary/40 bg-primary/15 px-2.5 py-1 text-[11px] font-semibold text-primary-dark md:px-3 md:text-xs">
                          {tx("مفتوح الآن", "Açık", "Open now")}
                        </span>
                      ) : confirmDeleteId === p.id ? (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => deleteProject(p.id)}
                            className="rounded-lg bg-accent-red px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60 md:px-4 md:py-2 md:text-sm"
                          >
                            {tx("تأكيد الحذف", "Silmeyi onayla", "Confirm delete")}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface md:px-4 md:py-2 md:text-sm"
                          >
                            {tx("إلغاء", "İptal", "Cancel")}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => {
                              setBusyId(p.id);
                              Promise.resolve(onOpen(p.id, Boolean(p.exportedAt))).then(
                                (opened) => opened === false && setBusyId(null),
                                () => setBusyId(null)
                              );
                            }}
                            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-60 md:px-4 md:py-2 md:text-sm"
                          >
                            {busy
                              ? tx("جارٍ الفتح…", "Açılıyor…", "Opening…")
                              : p.exportedAt
                                ? tx("فتح نسخة", "Kopyasını aç", "Open a copy")
                                : tx("فتح", "Aç", "Open")}
                          </button>
                          <button
                            type="button"
                            disabled={busyId !== null}
                            onClick={() => setConfirmDeleteId(p.id)}
                            aria-label={tx("حذف المشروع", "Projeyi sil", "Delete project")}
                            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent-red/10 hover:text-accent-red disabled:opacity-60"
                          >
                            <TrashIcon className="h-4 w-4 md:h-5 md:w-5" />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
