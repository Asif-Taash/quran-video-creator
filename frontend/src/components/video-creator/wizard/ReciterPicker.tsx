"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { PlayIcon, StarIcon, StopIcon } from "@heroicons/react/24/solid";
import { StarIcon as StarOutlineIcon } from "@heroicons/react/24/outline";
import Spinner from "@/components/ui/Spinner";
import { useT } from "@/lib/LanguageContext";
import { RECITERS, getReciter, reciterHasSurah, type ReciterInfo } from "@/lib/reciterNames";

// The reciter list (2026-11-20): every built-in reciter plus the other Hafs
// recordings on mp3quran, searchable, each with a listen button that plays
// the chosen ayahs straight from mp3quran -- nothing is prepared until a
// reciter is picked -- and a star that keeps favourites at the top. The user
// used to prepare a reciter, dislike it, and go look for one on YouTube.

const FAVORITES_KEY = "kurannuru:favReciters";
// A recording without ayah timing plays its opening, as a voice sample.
const SAMPLE_SECONDS = 30;

function readFavorites(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeFavorites(ids: string[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
  } catch {
    // Private window or blocked storage: favourites last for this visit only.
  }
}

// Arabic: no harakat/tatweel, one alef, ة=ه, ى=ي. Latin: Turkish letters and
// "al-"/hyphens folded, so "alturki", "Al-Turki" and "turki" all match.
function normalize(text: string): string {
  return text
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىی]/g, "ي")
    .replace(/[İIıi]/g, "i")
    .replace(/[âÂ]/g, "a")
    .replace(/[îÎ]/g, "i")
    .replace(/[ûÛ]/g, "u")
    .toLowerCase()
    .replace(/[-'’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type PreviewInfo = { url: string; start: number; end: number | null; total: number | null; timed: boolean };

interface ReciterPickerProps {
  isArabic: boolean;
  value: string;
  onChange: (id: string) => void;
  surahId: number | null;
  startVerse: number | null;
  endVerse: number | null;
}

export default function ReciterPicker({ isArabic, value, onChange, surahId, startVerse, endVerse }: ReciterPickerProps) {
  const tx = useT();
  const [open, setOpen] = useState(!value);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopAtRef = useRef<number | null>(null);
  const requestRef = useRef(0);

  useEffect(() => setFavorites(readFavorites()), []);
  // Open while no reciter is chosen; a reopened project (its reciter set
  // after mount) starts with the list closed.
  useEffect(() => {
    if (value) setOpen(false);
  }, [value]);

  const label = useCallback(
    (r: ReciterInfo) => (isArabic ? r.labelAr ?? r.nameAr : r.labelLatin ?? r.nameLatin),
    [isArabic]
  );

  const stopPreview = useCallback(() => {
    requestRef.current++;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    stopAtRef.current = null;
    setPlayingId(null);
    setLoadingId(null);
  }, []);

  // Other ayahs, or the list closed: whatever was playing no longer fits.
  useEffect(() => stopPreview, [surahId, startVerse, endVerse, stopPreview]);
  useEffect(() => {
    if (!open) stopPreview();
  }, [open, stopPreview]);

  const canPreview = surahId !== null && startVerse !== null && endVerse !== null;

  const playPreview = useCallback(
    async (r: ReciterInfo) => {
      if (playingId === r.id || loadingId === r.id) {
        stopPreview();
        return;
      }
      if (!canPreview) return;
      stopPreview();
      const ticket = ++requestRef.current;
      setLoadingId(r.id);
      setPreviewError(null);
      try {
        const query = new URLSearchParams({
          reciter: r.id,
          surah: String(surahId),
          start: String(startVerse),
          end: String(endVerse),
        });
        const res = await fetch(`/api/reciters/preview?${query}`);
        if (!res.ok) throw new Error(String(res.status));
        const info = (await res.json()) as PreviewInfo;
        if (ticket !== requestRef.current) return;
        let audio = audioRef.current;
        if (!audio) {
          audio = new Audio();
          audio.preload = "auto";
          audioRef.current = audio;
        }
        const el = audio;
        el.src = info.url;
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            el.removeEventListener("loadedmetadata", done);
            el.removeEventListener("error", fail);
            resolve();
          };
          const fail = () => {
            el.removeEventListener("loadedmetadata", done);
            el.removeEventListener("error", fail);
            reject(new Error("media"));
          };
          el.addEventListener("loadedmetadata", done);
          el.addEventListener("error", fail);
        });
        if (ticket !== requestRef.current) return;
        // mp3quran's timing is sometimes for a longer or shorter copy of the
        // recording: scale it to this file, as the backend's aligner does.
        const duration = el.duration;
        const scale =
          info.timed && info.total && Number.isFinite(duration) && Math.abs(duration - info.total) > 0.05 * info.total
            ? duration / info.total
            : 1;
        const from = info.timed ? Math.max(0, info.start * scale - 0.2) : 0;
        stopAtRef.current = info.timed && info.end !== null ? info.end * scale + 0.3 : SAMPLE_SECONDS;
        el.currentTime = from;
        await el.play();
        if (ticket !== requestRef.current) {
          el.pause();
          return;
        }
        setPlayingId(r.id);
        setLoadingId(null);
      } catch {
        if (ticket !== requestRef.current) return;
        setLoadingId(null);
        setPlayingId(null);
        setPreviewError(r.id);
      }
    },
    [canPreview, endVerse, loadingId, playingId, startVerse, stopPreview, surahId]
  );

  useEffect(() => {
    const audio = audioRef.current;
    const tick = () => {
      const el = audioRef.current;
      if (el && stopAtRef.current !== null && el.currentTime >= stopAtRef.current) stopPreview();
    };
    const id = window.setInterval(tick, 200);
    return () => {
      window.clearInterval(id);
      if (audio) audio.pause();
    };
  }, [stopPreview]);

  const toggleFavorite = (id: string) => {
    setFavorites((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [id, ...prev];
      writeFavorites(next);
      return next;
    });
  };

  const pick = (id: string) => {
    stopPreview();
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const available = useCallback((r: ReciterInfo) => surahId === null || reciterHasSurah(r, surahId), [surahId]);

  const sections = useMemo(() => {
    const q = normalize(query);
    const matches = (r: ReciterInfo) =>
      !q || normalize(`${r.nameAr} ${r.labelAr ?? ""} ${r.nameLatin} ${r.labelLatin ?? ""}`).includes(q);
    // Recordings without this surah go last in their group, greyed out.
    const order = (list: ReciterInfo[]) => [...list.filter(available), ...list.filter((r) => !available(r))];
    const favs = favorites.map((id) => getReciter(id)).filter((r): r is ReciterInfo => Boolean(r) && matches(r!));
    const favSet = new Set(favs.map((r) => r.id));
    const builtIn = RECITERS.filter((r) => r.builtIn && !favSet.has(r.id) && matches(r));
    const others = RECITERS.filter((r) => !r.builtIn && !favSet.has(r.id) && matches(r));
    return [
      { key: "fav", title: tx("المفضّلون", "Favoriler", "Favourites"), items: order(favs) },
      { key: "builtin", title: tx("أشهر القرّاء", "Öne çıkan kâriler", "Featured reciters"), items: order(builtIn) },
      { key: "more", title: tx("قرّاء آخرون (mp3quran)", "Diğer kâriler (mp3quran)", "More reciters (mp3quran)"), items: order(others) },
    ].filter((s) => s.items.length > 0);
  }, [available, favorites, query, tx]);

  const selected = getReciter(value);

  return (
    <div className="w-full" dir={isArabic ? "rtl" : "ltr"}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-[50px] w-full items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 text-sm font-medium shadow-sm transition-all hover:border-primary/30 hover:shadow-md ${isArabic ? "text-right" : "text-left"}`}
      >
        <span className={`truncate ${selected ? "" : "opacity-50"}`}>
          {selected ? label(selected) : tx("اختر القارئ", "Kâri seçin", "Choose a reciter")}
        </span>
        <span className="flex flex-shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {!open && tx(`${RECITERS.length} قارئاً`, `${RECITERS.length} kâri`, `${RECITERS.length} reciters`)}
          <ChevronDownIcon className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open && (
        <div className="mt-2 overflow-hidden rounded-xl border border-border bg-background shadow-sm">
          <div className="border-b border-border/60 p-2">
            <div className="relative">
              <MagnifyingGlassIcon className={`pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/40 ${isArabic ? "right-3" : "left-3"}`} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tx("ابحث باسم القارئ...", "Kâri adıyla ara...", "Search by name...")}
                className={`w-full rounded-lg border border-border bg-surface py-2 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15 ${isArabic ? "pr-9 pl-3" : "pl-9 pr-3"}`}
              />
            </div>
            <p className="mt-1.5 px-1 text-[11px] leading-snug text-muted-foreground">
              {canPreview
                ? tx(
                    "▶ يُسمعك آياتك بصوت القارئ فوراً، قبل التحضير. ★ تُبقيه في أعلى القائمة.",
                    "▶ seçtiğiniz ayetleri hazırlamadan hemen dinletir. ★ kâriyi listenin başında tutar.",
                    "▶ plays your ayahs in that voice right away, before preparing. ★ keeps the reciter at the top."
                  )
                : tx(
                    "اختر السورة والآيات أولاً لتسمعها بصوت كل قارئ.",
                    "Her kâriden dinlemek için önce sure ve ayetleri seçin.",
                    "Choose the surah and ayahs first to listen to each reciter."
                  )}
            </p>
          </div>
          <div className="max-h-[22rem] overflow-y-auto overscroll-contain">
            {sections.length === 0 && (
              <p className="p-4 text-center text-sm text-muted-foreground">{tx("لا نتائج", "Sonuç yok", "No results")}</p>
            )}
            {sections.map((section) => (
              <div key={section.key}>
                <div className="sticky top-0 z-10 bg-surface/95 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground backdrop-blur">
                  {section.title}
                </div>
                {section.items.map((r) => {
                  const ok = available(r);
                  const isFav = favorites.includes(r.id);
                  const isPlaying = playingId === r.id;
                  const isLoading = loadingId === r.id;
                  return (
                    <div
                      key={`${section.key}-${r.id}`}
                      className={`flex items-center gap-1.5 border-b border-border/40 px-2 py-1 last:border-b-0 ${r.id === value ? "bg-primary/10" : ""} ${ok ? "" : "opacity-45"}`}
                    >
                      <button
                        type="button"
                        disabled={!ok || !canPreview}
                        onClick={() => playPreview(r)}
                        title={
                          !ok
                            ? undefined
                            : r.timed
                              ? tx("استمع إلى الآيات المختارة", "Seçili ayetleri dinle", "Listen to the chosen ayahs")
                              : tx("استمع إلى عيّنة من صوته (بداية السورة)", "Sesinden bir örnek dinle (sure başı)", "Listen to a sample (start of the surah)")
                        }
                        className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${isPlaying ? "bg-primary text-white" : "bg-primary/10 text-primary hover:bg-primary/20"}`}
                      >
                        {isLoading ? <Spinner size="sm" /> : isPlaying ? <StopIcon className="h-4 w-4" /> : <PlayIcon className={`h-4 w-4 ${isArabic ? "-scale-x-100" : ""}`} />}
                      </button>
                      <button
                        type="button"
                        disabled={!ok}
                        onClick={() => pick(r.id)}
                        className={`min-w-0 flex-1 rounded-lg px-2 py-2 text-sm hover:bg-primary/5 disabled:cursor-not-allowed ${isArabic ? "text-right" : "text-left"} ${r.id === value ? "font-semibold text-primary" : ""}`}
                      >
                        <span className="block truncate">{label(r)}</span>
                        {!ok ? (
                          <span className="block text-[11px] text-muted-foreground">
                            {tx("لم يسجّل هذه السورة", "Bu sureyi okumamış", "Hasn't recorded this surah")}
                          </span>
                        ) : previewError === r.id ? (
                          <span className="block text-[11px] text-accent-red">
                            {tx("تعذّر التشغيل، حاول مرة أخرى", "Çalınamadı, tekrar deneyin", "Couldn't play, try again")}
                          </span>
                        ) : r.quality || !r.timed ? (
                          <span className="flex flex-wrap gap-x-2 text-[11px]">
                            {r.quality === "high" && (
                              <span className="text-accent-green">{tx("جودة صوت عالية", "Yüksek ses kalitesi", "High audio quality")}</span>
                            )}
                            {r.quality === "low" && (
                              <span className="text-amber-600">{tx("جودة الصوت ضعيفة", "Düşük ses kalitesi", "Low audio quality")}</span>
                            )}
                            {!r.timed && (
                              <span className="text-muted-foreground">{tx("▶ عيّنة من صوته فقط", "▶ yalnızca ses örneği", "▶ voice sample only")}</span>
                            )}
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleFavorite(r.id)}
                        title={isFav ? tx("إزالة من المفضّلين", "Favorilerden çıkar", "Remove from favourites") : tx("أضف إلى المفضّلين", "Favorilere ekle", "Add to favourites")}
                        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-amber-500 hover:bg-amber-500/10"
                      >
                        {isFav ? <StarIcon className="h-5 w-5" /> : <StarOutlineIcon className="h-5 w-5 text-foreground/30" />}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
