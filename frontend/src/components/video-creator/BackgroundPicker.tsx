"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, MagnifyingGlassIcon, PhotoIcon, VideoCameraIcon, XMarkIcon } from "@heroicons/react/24/outline";
import Spinner from "@/components/ui/Spinner";
import { BACKGROUND_BLUR_MAX, BACKGROUND_DIM_MAX, type AspectRatio } from "@/remotion/types";
import { useLanguage, useT } from "@/lib/LanguageContext";
import { BACKGROUND_TOPICS } from "@/lib/backgroundTopics";

// The optional background section under the video preview (see
// Step5Generate.tsx): the video is created first with a black background,
// then the user can search the stock library (lib/stockBackgrounds.ts) by
// typing what they want -- in Arabic too, see lib/stockSearchQuery.ts -- or
// upload their own file, and tune how it's shown (dim/blur/slow zoom).
// Without a provider key the library part is hidden and only uploading
// remains.

// Mirrors lib/stockBackgrounds.ts' StockItem (that module is server-only).
type StockItem = {
  key: string;
  provider: "pexels" | "pixabay";
  type: "photo" | "video";
  id: string;
  thumbUrl: string;
  previewVideoUrl?: string;
  width: number;
  height: number;
  durationSec?: number;
  seamlessLoop?: boolean;
  author: string;
  authorUrl?: string;
  pageUrl: string;
};

type MediaType = "video" | "photo";

// The quick topics under the search box (lib/backgroundTopics.ts) search as
// "topic:<id>": the server walks all of a topic's wordings. The library only
// ever shows natural scenery (no people, buildings, vehicles or animals --
// enforced server-side by an image check, see lib/natureCheck.ts).
const TOPIC_PREFIX = "topic:";

const newSeed = () => 1 + Math.floor(Math.random() * 2147483000);

// Results this browser has already been shown, so a new search puts unseen
// ones first. Browser-only convenience: missing or blocked storage just
// means no preference.
const SEEN_STORAGE_KEY = "kurannuru:bgSeen";
const SEEN_MAX = 5000;

function readSeen(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberSeen(keys: string[]) {
  try {
    const merged = [...readSeen().filter((k) => !keys.includes(k)), ...keys].slice(-SEEN_MAX);
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // storage unavailable -- nothing to remember
  }
}

// Backgrounds this browser has already put in a video. A search shows them
// only after everything else -- the good ones the user had used kept coming
// back first (the user, 2026-11-01). Same storage caveats as the seen list.
const USED_STORAGE_KEY = "kurannuru:bgUsed";
const USED_MAX = 2000;

function readUsed(): string[] {
  try {
    const raw = localStorage.getItem(USED_STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberUsed(key: string) {
  try {
    const merged = [...readUsed().filter((k) => k !== key), key].slice(-USED_MAX);
    localStorage.setItem(USED_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // storage unavailable -- nothing to remember
  }
}

// More results load on their own once the list is scrolled to within this
// distance of its end -- no "load more" button (the user, 2026-11-01).
const AUTO_LOAD_MARGIN_PX = 1200;
// Loads in a row that brought nothing new before the automatic loading
// stops and a button takes over (so it can't loop on an exhausted search).
const MAX_EMPTY_LOADS = 3;

const TILE_ASPECT: Record<AspectRatio, string> = {
  portrait: "aspect-[9/16]",
  landscape: "aspect-video",
  square: "aspect-square",
};
// Big tiles, so each option can be judged at a glance.
const GRID_COLUMNS: Record<AspectRatio, string> = {
  portrait: "grid-cols-2 sm:grid-cols-3",
  landscape: "grid-cols-1 sm:grid-cols-2",
  square: "grid-cols-2 sm:grid-cols-3",
};

const TYPING_DEBOUNCE_MS = 600;

// The picker's own previews (thumbnail, hover clips) must be silent too --
// set on the element itself, not only via React's `muted` prop, which some
// browsers don't honor before autoplay starts.
function silenceMedia(el: HTMLVideoElement | null) {
  if (!el) return;
  el.muted = true;
  el.defaultMuted = true;
  el.volume = 0;
}

const SLIDER_CLASS = `h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none
  [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none
  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary
  [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:transition-transform
  [&::-webkit-slider-thumb]:hover:scale-110
  [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full
  [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-md`;

function EffectSlider({ label, value, max, step, onChange }: {
  label: string;
  value: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const percent = (value / max) * 100;
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="range"
        dir="ltr"
        min={0}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ background: `linear-gradient(to right, var(--primary) ${percent}%, var(--border) ${percent}%)` }}
        className={SLIDER_CLASS}
      />
    </label>
  );
}

function formatDuration(sec: number) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface BackgroundPickerProps {
  isArabic: boolean;
  aspectRatio: AspectRatio;
  // The recitation's length -- each video result says whether it covers it
  // or how many times it will repeat (smoothly, see QuranVideo.tsx's
  // LoopingBackgroundVideo). null until the video exists.
  videoDurationSec: number | null;
  bgPreview: string | null;
  bgVideoPreview: string | null;
  handleImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleVideoUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  removeImage: () => void;
  removeVideo: () => void;
  onBackgroundFile: (file: File, kind: "image" | "video") => void;
  // A photo too small for the video gets a sharper, upscaled copy (see
  // VideoCreatorForm's enhanceBgImage): being made, applied, or set aside
  // for the original. null: nothing to say.
  bgEnhanceState: "working" | "enhanced" | "original" | null;
  onToggleBgEnhanced: () => void;
  backgroundDim: number;
  onBackgroundDimChange: (v: number) => void;
  backgroundBlur: number;
  onBackgroundBlurChange: (v: number) => void;
  backgroundZoom: boolean;
  onBackgroundZoomChange: (v: boolean) => void;
}

export default function BackgroundPicker({
  isArabic,
  aspectRatio,
  videoDurationSec,
  bgPreview,
  bgVideoPreview,
  handleImageUpload,
  handleVideoUpload,
  removeImage,
  removeVideo,
  onBackgroundFile,
  bgEnhanceState,
  onToggleBgEnhanced,
  backgroundDim,
  onBackgroundDimChange,
  backgroundBlur,
  onBackgroundBlurChange,
  backgroundZoom,
  onBackgroundZoomChange,
}: BackgroundPickerProps) {
  const tx = useT();
  const { language } = useLanguage();
  const hasBackground = Boolean(bgPreview || bgVideoPreview);

  const [libraryEnabled, setLibraryEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/backgrounds/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setLibraryEnabled(Boolean(data?.enabled));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [mediaType, setMediaType] = useState<MediaType>("video");
  const [searchText, setSearchText] = useState("");
  // What the results below are for -- set by typing (debounced), Enter, or
  // a suggestion. Empty: nothing searched yet, so no results are shown.
  const [activeQuery, setActiveQuery] = useState("");
  // The box text that produced activeQuery -- a suggestion puts its label
  // in the box but searches its own (English) query, so the typing debounce
  // must not then re-search the label.
  const [searchedText, setSearchedText] = useState("");
  const [items, setItems] = useState<StockItem[]>([]);
  // This search's results already used in a video (see USED_STORAGE_KEY):
  // held back until everything else has been shown.
  const [usedItems, setUsedItems] = useState<StockItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  // The last load failed: no automatic retry, the button takes over.
  const [loadFailed, setLoadFailed] = useState(false);
  // MAX_EMPTY_LOADS reached: same.
  const [autoLoadStopped, setAutoLoadStopped] = useState(false);
  const emptyLoadsRef = useRef(0);
  // How many results there were when the running "more" load started.
  const countAtLoadRef = useRef<number | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  // The last search asked for something outside natural scenery.
  const [notNature, setNotNature] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);
  const [pickingKey, setPickingKey] = useState<string | null>(null);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  // Videos only: longest first instead of the providers' own ranking
  // (which already puts seamless loops first, see lib/stockBackgrounds.ts).
  const [longestFirst, setLongestFirst] = useState(false);
  const usedKeys = new Set(usedItems.map((i) => i.key));
  const listed = hasMore ? items : [...items, ...usedItems.filter((u) => !items.some((i) => i.key === u.key))];
  const shownItems =
    mediaType === "video" && longestFirst
      ? [...listed].sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0))
      : listed;

  const lengthBadge = (item: StockItem): { text: string; good: boolean } | null => {
    if (item.type !== "video" || typeof item.durationSec !== "number" || item.durationSec <= 0) return null;
    if (videoDurationSec && item.durationSec >= videoDurationSec) {
      return { text: tx("✓ يغطي الفيديو كاملاً", "✓ Videonun tamamını kaplar", "✓ Covers the whole video"), good: true };
    }
    const times = videoDurationSec ? Math.ceil(videoDurationSec / item.durationSec) : null;
    if (item.seamlessLoop) {
      return {
        text: times
          ? tx(`∞ تكرار سلس ×${times}`, `∞ Kesintisiz döngü ×${times}`, `∞ Seamless loop ×${times}`)
          : tx("∞ تكرار سلس", "∞ Kesintisiz döngü", "∞ Seamless loop"),
        good: true,
      };
    }
    return times ? { text: tx(`🔁 يتكرر ×${times}`, `🔁 ${times} kez tekrarlanır`, `🔁 Repeats ×${times}`), good: false } : null;
  };
  const requestIdRef = useRef(0);
  // The current search's random seed; a new one for every new search,
  // kept for its "load more" pages.
  const seedRef = useRef(newSeed());

  const runSearch = useCallback(
    async (query: string, type: MediaType, pageToLoad: number) => {
      const requestId = ++requestIdRef.current;
      setIsSearching(true);
      setLibraryError(null);
      setLoadFailed(false);
      if (pageToLoad === 1) {
        seedRef.current = newSeed();
        setItems([]);
        setUsedItems([]);
        setNotNature(false);
        setAutoLoadStopped(false);
        emptyLoadsRef.current = 0;
        countAtLoadRef.current = null;
      }
      try {
        const topicId = query.startsWith(TOPIC_PREFIX) ? query.slice(TOPIC_PREFIX.length) : null;
        const params = new URLSearchParams({
          q: topicId ? "" : query,
          type,
          orientation: aspectRatio,
          page: String(pageToLoad),
          lang: language,
          seed: String(seedRef.current),
        });
        if (topicId) params.set("topic", topicId);
        const res = await fetch(`/api/backgrounds/search?${params}`);
        const data = await res.json();
        if (requestId !== requestIdRef.current) return;
        if (data.enabled === false) {
          setLibraryEnabled(false);
          return;
        }
        if (!res.ok) throw new Error(data.error || "Search failed");
        setNotNature(Boolean(data.notNature));
        setProviders(data.providers ?? []);
        const shownBefore = new Set(readSeen());
        const used = new Set(readUsed());
        const fresh: StockItem[] = data.items;
        const notUsed = fresh.filter((i) => !used.has(i.key));
        const ordered = [...notUsed.filter((i) => !shownBefore.has(i.key)), ...notUsed.filter((i) => shownBefore.has(i.key))];
        rememberSeen(fresh.map((i) => i.key));
        setUsedItems((prev) => {
          const held = fresh.filter((i) => used.has(i.key));
          if (pageToLoad === 1) return held;
          const keys = new Set(prev.map((i) => i.key));
          return [...prev, ...held.filter((i) => !keys.has(i.key))];
        });
        setItems((prev) => {
          if (pageToLoad === 1) return ordered;
          const seen = new Set(prev.map((i) => i.key));
          return [...prev, ...ordered.filter((i) => !seen.has(i.key))];
        });
        setHasMore(Boolean(data.hasMore));
        // The server may have topped a thin page up from the next ones.
        setPage(typeof data.lastPage === "number" ? data.lastPage : pageToLoad);
      } catch {
        if (requestId !== requestIdRef.current) return;
        setLoadFailed(true);
        setLibraryError(tx("تعذر تحميل الخلفيات، حاول مرة أخرى.", "Arka planlar yüklenemedi, tekrar deneyin.", "Couldn't load backgrounds, please try again."));
      } finally {
        if (requestId === requestIdRef.current) setIsSearching(false);
      }
    },
    [aspectRatio, language, tx]
  );

  useEffect(() => {
    if (activeQuery) runSearch(activeQuery, mediaType, 1);
  }, [activeQuery, mediaType, runSearch]);

  const loadMore = useCallback(() => {
    countAtLoadRef.current = items.length + usedItems.length;
    runSearch(activeQuery, mediaType, page + 1);
  }, [items.length, usedItems.length, runSearch, activeQuery, mediaType, page]);

  // Counts the loads in a row that brought nothing new (MAX_EMPTY_LOADS).
  useEffect(() => {
    if (isSearching || countAtLoadRef.current === null) return;
    const grew = items.length + usedItems.length > countAtLoadRef.current;
    countAtLoadRef.current = null;
    emptyLoadsRef.current = grew ? 0 : emptyLoadsRef.current + 1;
    if (emptyLoadsRef.current >= MAX_EMPTY_LOADS) setAutoLoadStopped(true);
  }, [isSearching, items.length, usedItems.length]);

  // More results load as the list is scrolled near its end -- and right
  // after every load too, while the list is still short of it.
  const loadMoreIfNearEnd = useCallback(() => {
    const el = resultsRef.current;
    if (!el || !activeQuery || !hasMore || isSearching || loadFailed || autoLoadStopped) return;
    // Folded away with its section: nothing on screen to fill.
    if (el.clientHeight === 0) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_LOAD_MARGIN_PX) loadMore();
  }, [activeQuery, hasMore, isSearching, loadFailed, autoLoadStopped, loadMore]);
  useEffect(() => {
    loadMoreIfNearEnd();
  }, [loadMoreIfNearEnd]);

  // Search as the user types, once they pause.
  useEffect(() => {
    const q = searchText.trim();
    if (q.length < 2 || q === searchedText) return;
    const timer = setTimeout(() => {
      setSearchedText(q);
      setActiveQuery(q);
    }, TYPING_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText, searchedText]);

  // Forget which tile was picked once the background is removed or replaced
  // by an upload of the user's own.
  useEffect(() => {
    if (!hasBackground) setPickedKey(null);
  }, [hasBackground]);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchText.trim();
    if (!q) return;
    setSearchedText(q);
    if (q === activeQuery) runSearch(q, mediaType, 1);
    else setActiveQuery(q);
  };

  const pickItem = async (item: StockItem) => {
    if (pickingKey) return;
    setPickingKey(item.key);
    setLibraryError(null);
    try {
      const res = await fetch("/api/backgrounds/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: item.provider, type: item.type, id: item.id }),
      });
      const data = await res.json();
      if (res.status === 422 && data.error === "notNature") {
        // The whole video was checked on pick: some frame shows people,
        // buildings, vehicles or animals. Drop it from the results.
        setItems((prev) => prev.filter((i) => i.key !== item.key));
        setLibraryError(tx(
          "هذا الفيديو يظهر فيه أشخاص أو مبانٍ أو مركبات في بعض لقطاته، لذلك حذفناه. اختر غيره.",
          "Bu videonun bazı karelerinde insan, bina veya araç görünüyor, bu yüzden kaldırıldı. Başka birini seçin.",
          "Some frames of this video show people, buildings or vehicles, so it was removed. Pick another one."
        ));
        return;
      }
      if (!res.ok || !data.url) throw new Error(data.error || "Download failed");
      const blob = await (await fetch(data.url)).blob();
      const isVideo = item.type === "video";
      const extension = isVideo ? "mp4" : blob.type.includes("png") ? "png" : "jpg";
      const file = new File([blob], `${item.provider}-${item.id}.${extension}`, {
        type: blob.type || (isVideo ? "video/mp4" : "image/jpeg"),
      });
      onBackgroundFile(file, isVideo ? "video" : "image");
      setPickedKey(item.key);
      rememberUsed(item.key);
    } catch {
      setLibraryError(tx("تعذر تنزيل هذه الخلفية، جرّب خلفية أخرى.", "Bu arka plan indirilemedi, başka birini deneyin.", "Couldn't download this background, try another one."));
    } finally {
      setPickingKey(null);
    }
  };

  const providerLinks = (providers.length > 0 ? providers : ["pixabay"]).map((p) => (
    <a
      key={p}
      href={p === "pexels" ? "https://www.pexels.com" : "https://pixabay.com"}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-primary hover:underline"
    >
      {p === "pexels" ? "Pexels" : "Pixabay"}
    </a>
  ));

  const uploadButtonClass =
    "inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary";

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-surface p-4" dir={isArabic ? "rtl" : "ltr"}>
      {/* Header + current background */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {tx("خلفية الفيديو", "Video Arka Planı", "Video Background")}{" "}
            <span className="font-normal text-muted-foreground">{tx("(اختياري)", "(isteğe bağlı)", "(optional)")}</span>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hasBackground
              ? tx("الخلفية ظاهرة في الفيديو بالأعلى.", "Arka plan yukarıdaki videoda görünüyor.", "The background shows in the video above.")
              : tx("حالياً الخلفية سوداء.", "Şu an arka plan siyah.", "The background is currently black.")}
          </p>
          {bgPreview && bgEnhanceState && (
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {bgEnhanceState === "working" ? (
                <>
                  <Spinner size="sm" />
                  {tx("جارٍ تحسين جودة الصورة…", "Görselin kalitesi iyileştiriliyor…", "Improving the photo's quality…")}
                </>
              ) : (
                <>
                  <span>
                    {bgEnhanceState === "enhanced"
                      ? tx("حسّنّا جودة الصورة تلقائياً.", "Görselin kalitesi otomatik olarak iyileştirildi.", "The photo's quality was improved automatically.")
                      : tx("تُستخدم الصورة الأصلية.", "Orijinal görsel kullanılıyor.", "Using the original photo.")}
                  </span>
                  <button type="button" onClick={onToggleBgEnhanced} className="font-medium text-primary hover:underline">
                    {bgEnhanceState === "enhanced"
                      ? tx("استخدم الأصلية", "Orijinali kullan", "Use the original")
                      : tx("استخدم المحسّنة", "İyileştirilmişi kullan", "Use the improved one")}
                  </button>
                </>
              )}
            </p>
          )}
        </div>
        {hasBackground && (
          <div className="flex items-center gap-2">
            <div className="h-12 w-12 overflow-hidden rounded-lg border border-border bg-black">
              {bgVideoPreview ? (
                <video ref={silenceMedia} src={bgVideoPreview} muted autoPlay loop playsInline className="h-full w-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={bgPreview!} alt="" className="h-full w-full object-cover" />
              )}
            </div>
            <button
              type="button"
              onClick={bgVideoPreview ? removeVideo : removeImage}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-accent-red hover:text-accent-red"
            >
              <XMarkIcon className="h-4 w-4" />
              {tx("إزالة الخلفية", "Arka Planı Kaldır", "Remove Background")}
            </button>
          </div>
        )}
      </div>

      {libraryEnabled && (
        <>
          {/* Search */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <form onSubmit={submitSearch} className="relative flex-1">
              <MagnifyingGlassIcon className="pointer-events-none absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={tx(
                  "اكتب ما تريد، مثلاً: بحر، غيوم، مطر، مسجد...",
                  "Ne istediğinizi yazın, ör: deniz, bulut, yağmur, cami...",
                  "Type what you want, e.g. sea, clouds, rain, mosque..."
                )}
                className="w-full rounded-xl border border-border bg-background py-3 pe-3 ps-10 text-sm outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary/60"
              />
            </form>
            <div className="flex flex-shrink-0 rounded-xl border border-border bg-background p-1 text-xs font-medium">
              {(["video", "photo"] as MediaType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setMediaType(t)}
                  className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 transition-colors ${
                    mediaType === t ? "bg-primary text-white shadow-sm" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t === "video" ? <VideoCameraIcon className="h-4 w-4" /> : <PhotoIcon className="h-4 w-4" />}
                  {t === "video" ? tx("فيديوهات", "Videolar", "Videos") : tx("صور", "Fotoğraflar", "Photos")}
                </button>
              ))}
            </div>
          </div>

          <p className="-mt-1 text-xs text-muted-foreground">
            {tx(
              "تظهر هنا المناظر الطبيعية فقط: بدون أشخاص أو مبانٍ أو سيارات أو طائرات أو حيوانات.",
              "Burada yalnızca doğa manzaraları gösterilir: insan, bina, araba, uçak veya hayvan yok.",
              "Only natural scenery is shown here: no people, buildings, cars, planes or animals."
            )}
          </p>

          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {BACKGROUND_TOPICS.map((c) => {
              const label = tx(c.ar, c.tr, c.en);
              const q = `${TOPIC_PREFIX}${c.id}`;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setSearchText(label);
                    setSearchedText(label);
                    if (q === activeQuery) runSearch(q, mediaType, 1);
                    else setActiveQuery(q);
                  }}
                  className={`flex-shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    q === activeQuery
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Results */}
          {libraryError && (
            <p className="rounded-xl border border-accent-red/30 bg-accent-red-bg/60 p-3 text-sm text-accent-red">{libraryError}</p>
          )}
          {activeQuery && mediaType === "video" && listed.length > 1 && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setLongestFirst((v) => !v)}
                aria-pressed={longestFirst}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  longestFirst
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground"
                }`}
              >
                {tx("↓ الأطول أولاً", "↓ En uzun önce", "↓ Longest first")}
              </button>
            </div>
          )}
          {activeQuery && (
            <div ref={resultsRef} onScroll={loadMoreIfNearEnd} className="max-h-[80vh] overflow-y-auto rounded-xl p-1">
              {listed.length === 0 && (isSearching || (hasMore && !loadFailed && !autoLoadStopped)) ? (
                <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Spinner size="sm" />
                  {tx(
                    "جاري البحث والتأكد من خلوّ الصور من الأشخاص والمباني...",
                    "Aranıyor ve görsellerde insan ya da bina olmadığı kontrol ediliyor...",
                    "Searching and checking the images contain no people or buildings..."
                  )}
                </div>
              ) : listed.length === 0 && !libraryError ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {notNature
                    ? tx(
                        "هذه المكتبة للمناظر الطبيعية فقط، جرّب مثلاً: بحر، غيوم، جبال، مطر.",
                        "Bu kütüphane yalnızca doğa manzaraları içindir, ör: deniz, bulut, dağ, yağmur deneyin.",
                        "This library is for natural scenery only, try e.g. sea, clouds, mountains, rain."
                      )
                    : tx("لا توجد نتائج، جرّب كلمة أخرى.", "Sonuç yok, başka bir kelime deneyin.", "No results, try another word.")}
                </p>
              ) : (
                <div className={`grid gap-3 ${GRID_COLUMNS[aspectRatio]}`}>
                  {shownItems.map((item) => {
                    const isPicking = pickingKey === item.key;
                    const badge = lengthBadge(item);
                    const isPicked = pickedKey === item.key && hasBackground;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => pickItem(item)}
                        onMouseEnter={() => setHoveredKey(item.key)}
                        onMouseLeave={() => setHoveredKey((k) => (k === item.key ? null : k))}
                        disabled={Boolean(pickingKey)}
                        title={`${item.author} · ${item.provider === "pexels" ? "Pexels" : "Pixabay"}`}
                        className={`group/tile relative overflow-hidden rounded-xl bg-black/40 ${TILE_ASPECT[aspectRatio]} ring-offset-2 ring-offset-surface transition-all ${
                          isPicked ? "ring-[3px] ring-primary" : "hover:ring-2 hover:ring-primary/60"
                        } disabled:cursor-wait`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={item.thumbUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                        {item.type === "video" && hoveredKey === item.key && item.previewVideoUrl && (
                          <video
                            ref={silenceMedia}
                            src={item.previewVideoUrl}
                            autoPlay
                            muted
                            loop
                            playsInline
                            className="absolute inset-0 h-full w-full object-cover"
                          />
                        )}
                        {badge && (
                          <span
                            className={`absolute bottom-2 start-2 max-w-[70%] truncate rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white ${
                              badge.good ? "bg-emerald-600/85" : "bg-black/70"
                            }`}
                          >
                            {badge.text}
                          </span>
                        )}
                        {item.type === "video" && (
                          <span className="absolute bottom-2 end-2 inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white" dir="ltr">
                            <VideoCameraIcon className="h-3 w-3" />
                            {typeof item.durationSec === "number" ? formatDuration(item.durationSec) : null}
                          </span>
                        )}
                        <span className="pointer-events-none absolute inset-x-0 top-0 truncate bg-gradient-to-b from-black/70 to-transparent px-2 pb-4 pt-1.5 text-start text-[11px] text-white/90 opacity-0 transition-opacity group-hover/tile:opacity-100">
                          {item.author}
                        </span>
                        {usedKeys.has(item.key) && (
                          <span className="absolute end-2 top-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
                            {tx("استُخدمت سابقاً", "Daha önce kullanıldı", "Used before")}
                          </span>
                        )}
                        {isPicked && (
                          <span className="absolute start-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white shadow-lg">
                            <CheckIcon className="h-4 w-4" />
                          </span>
                        )}
                        {isPicking && (
                          <span className="absolute inset-0 flex items-center justify-center bg-black/60">
                            <Spinner size="md" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {listed.length > 0 && hasMore && isSearching && (
                <div className="flex items-center justify-center gap-2 py-5 text-xs text-muted-foreground">
                  <Spinner size="sm" />
                  {tx("جارٍ تحميل المزيد…", "Daha fazlası yükleniyor…", "Loading more…")}
                </div>
              )}
              {hasMore && !isSearching && (loadFailed || autoLoadStopped) && (
                <div className="flex justify-center pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      emptyLoadsRef.current = 0;
                      setAutoLoadStopped(false);
                      loadMore();
                    }}
                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-primary/40"
                  >
                    {tx("عرض المزيد", "Daha fazla", "Load more")}
                  </button>
                </div>
              )}
            </div>
          )}
          {activeQuery && listed.length > 0 && (
            <p className="text-center text-[11px] text-muted-foreground">
              {tx("الصور والفيديوهات من", "Fotoğraf ve videolar:", "Photos and videos from")}{" "}
              {providerLinks.reduce<React.ReactNode[]>((acc, link, i) => (i === 0 ? [link] : [...acc, " · ", link]), [])}
            </p>
          )}
        </>
      )}

      {/* Upload your own */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {libraryEnabled ? tx("أو ارفع من جهازك:", "Veya kendi dosyanızı yükleyin:", "Or upload your own:") : tx("ارفع من جهازك:", "Kendi dosyanızı yükleyin:", "Upload your own:")}
        </span>
        <label className={uploadButtonClass}>
          <PhotoIcon className="h-4 w-4" />
          {tx("صورة", "Resim", "Image")}
          <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
        </label>
        <label className={uploadButtonClass}>
          <VideoCameraIcon className="h-4 w-4" />
          {tx("فيديو", "Video", "Video")}
          <input type="file" accept="video/*" className="hidden" onChange={handleVideoUpload} />
        </label>
      </div>

      {/* How the background is shown */}
      {hasBackground && (
        <div className="grid gap-4 border-t border-border/60 pt-4 sm:grid-cols-3 sm:items-end">
          <EffectSlider
            label={tx("تعتيم الخلفية", "Karartma", "Darken")}
            value={backgroundDim}
            max={BACKGROUND_DIM_MAX}
            step={0.01}
            onChange={onBackgroundDimChange}
          />
          <EffectSlider
            label={tx("تمويه الخلفية", "Bulanıklık", "Blur")}
            value={backgroundBlur}
            max={BACKGROUND_BLUR_MAX}
            step={0.5}
            onChange={onBackgroundBlurChange}
          />
          <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
            <span className="text-xs font-medium text-muted-foreground">
              {tx("تقريب بطيء (حركة)", "Yavaş yakınlaştırma", "Slow zoom")}
            </span>
            <input
              type="checkbox"
              checked={backgroundZoom}
              onChange={(e) => onBackgroundZoomChange(e.target.checked)}
              className="peer sr-only"
            />
            <span
              aria-hidden
              className="relative h-5 w-9 flex-shrink-0 rounded-full bg-border transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:left-[18px] peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40"
            />
          </label>
        </div>
      )}
    </div>
  );
}
