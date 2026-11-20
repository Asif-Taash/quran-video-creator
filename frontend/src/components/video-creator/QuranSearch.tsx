import React, { useState, useEffect, useRef } from "react";
import { ArrowUturnLeftIcon, MagnifyingGlassIcon, SparklesIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useLanguage, useT } from "@/lib/LanguageContext";
import Spinner from "@/components/ui/Spinner";
import { findWordStartMatches } from "@/lib/arabicSearch";
import ReciteSearch from "./ReciteSearch";

interface QuranSearchProps {
  onSelectVerse: (surahNumber: number, ayahNumber: number) => void;
  // A range found by reciting it (ReciteSearch) -- one ayah or several.
  onSelectRange: (surahNumber: number, fromAyah: number, toAyah: number) => void;
  getSurahName: (surahNumber: number) => string;
  // A surah (and ayah) the query names -- "البقرة 255", "2:255", "yasin" --
  // offered first, to go straight there (lib/surahJump.ts).
  resolveJump?: (query: string) => { surah: number; ayah: number; hasAyah: boolean } | null;
}

interface SearchResult {
  surahNumber: number;
  ayahNumber: number;
  // The last ayah, when a result spans several (the closest-text search).
  toAyah?: number;
  text: string;
  // Meaning search: the ayah's translation in the UI language, if any.
  translation?: string | null;
}

// "text": the words themselves (word-start match). "meaning": ayahs ABOUT
// the query in any language -- الصبر / sabır / patience -- by the backend's
// meaning search (2026-11-20, backend/scripts/ayah_search.py).
type SearchMode = "text" | "meaning";

// Quick topics under the box in meaning mode: one tap fills the search.
const THEMES: { ar: string; tr: string; en: string }[] = [
  { ar: "الصبر", tr: "Sabır", en: "Patience" },
  { ar: "الرحمة", tr: "Rahmet", en: "Mercy" },
  { ar: "التوبة", tr: "Tevbe", en: "Repentance" },
  { ar: "الدعاء", tr: "Dua", en: "Supplication" },
  { ar: "الجنة", tr: "Cennet", en: "Paradise" },
  { ar: "الموت", tr: "Ölüm", en: "Death" },
  { ar: "يوم القيامة", tr: "Kıyamet", en: "Day of Judgement" },
  { ar: "الشكر", tr: "Şükür", en: "Gratitude" },
  { ar: "التوكل على الله", tr: "Tevekkül", en: "Trust in Allah" },
  { ar: "الوالدان", tr: "Anne baba", en: "Parents" },
  { ar: "الرزق", tr: "Rızık", en: "Provision" },
  { ar: "لا تيأسوا من رحمة الله", tr: "Ümit", en: "Hope" },
  { ar: "آيات الله في الكون", tr: "Kâinattaki ayetler", en: "Signs in creation" },
  { ar: "الأنبياء", tr: "Peygamberler", en: "Prophets" },
];

export default function QuranSearch({ onSelectVerse, onSelectRange, getSurahName, resolveJump }: QuranSearchProps) {
  const tx = useT();
  const { language } = useLanguage();
  const isArabic = language === "ar";
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SearchMode>("text");
  // The words weren't found as typed: the results are the closest text
  // ("near", a word wrong or missing) or, failing that, the closest meaning.
  const [fallback, setFallback] = useState<"near" | "meaning" | null>(null);
  // The meaning model loads on its first query (a few seconds): started as
  // soon as the mode is picked, while the user is still typing.
  const warmedRef = useRef(false);
  useEffect(() => {
    if (mode !== "meaning" || warmedRef.current) return;
    warmedRef.current = true;
    fetch(`/api/quran/search?mode=meaning&q=${encodeURIComponent("رحمة")}&lang=${language}`).catch(() => {});
  }, [mode, language]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [dropdownMaxHeight, setDropdownMaxHeight] = useState(420);

  // Size the dropdown as a share of the viewport (half its height, clamped
  // between 220 and 560px) rather than a flat pixel value, so it scales up
  // on taller phones instead of looking cramped. Being an overlay over a
  // scrollable page, it's fine for it to extend past the fold.
  useEffect(() => {
    if (!isOpen) return;
    const updateMaxHeight = () => {
      setDropdownMaxHeight(Math.max(220, Math.min(window.innerHeight * 0.55, 560)));
    };
    updateMaxHeight();
    window.addEventListener("resize", updateMaxHeight);
    return () => window.removeEventListener("resize", updateMaxHeight);
  }, [isOpen]);

  // Handle click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Debounce the query
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 500);
    return () => clearTimeout(handler);
  }, [query]);

  // Guards against a stale response overwriting a newer one. The debounce
  // above only cancels a pending TIMER -- once a request is actually in
  // flight, nothing stops a second one from starting before the first
  // resolves (e.g. typing "مو", pausing >500ms so it fires, then continuing
  // to "موت" fires a second one). If the earlier, broader query's response
  // ("مو" matches every word starting with "مو", e.g. "موسى") happened to
  // arrive AFTER the narrower "موت" one, it would silently overwrite the
  // correct results with stale, too-broad ones. Bumped once per effect run;
  // a response is only applied if it's still the latest request by the time
  // it resolves.
  const searchRequestIdRef = useRef(0);

  // Fetch results when debounced query changes
  useEffect(() => {
    const requestId = ++searchRequestIdRef.current;

    async function fetchResults() {
      if (!debouncedQuery || debouncedQuery.length < 2) {
        setResults([]);
        setIsOpen(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      setIsOpen(true);

      try {
        const params = new URLSearchParams({ q: debouncedQuery });
        if (mode === "meaning") {
          params.set("mode", "meaning");
          params.set("lang", language);
        }
        let response = await fetch(`/api/quran/search?${params}`);
        let data = await response.json();
        if (requestId !== searchRequestIdRef.current) return; // superseded by a newer search
        // No ayah has these words as typed: first the closest text (a word
        // misremembered or misspelt -- "وكفر عنا خطايانا" finds 3:193), then
        // the closest meaning (a topic typed in the text mode).
        let usedFallback: "near" | "meaning" | null = null;
        // "البقرة 255" is a place to go to (offered above the results), not
        // words to look for.
        const isPlace = Boolean(resolveJump?.(debouncedQuery)?.hasAyah);
        if (mode === "text" && !isPlace && response.ok && !(data.search?.results?.length > 0)) {
          for (const [kind, extra] of [
            ["near", { mode: "fuzzy" }],
            ["meaning", { mode: "meaning", lang: language }],
          ] as const) {
            const res = await fetch(`/api/quran/search?${new URLSearchParams({ q: debouncedQuery, ...extra })}`).catch(() => null);
            if (requestId !== searchRequestIdRef.current) return;
            if (!res?.ok) continue;
            const found = await res.json();
            const list = found.search?.results ?? [];
            // A close text is one with most of its letters right.
            if (list.length > 0 && (kind === "meaning" || list[0].score >= 0.6)) {
              response = res;
              data = found;
              usedFallback = kind;
              break;
            }
          }
        }
        setFallback(usedFallback);

        if (mode === "meaning" && !response.ok) {
          setResults([]);
          setError(tx(
            "البحث بالمعنى غير متاح الآن، جرّب البحث بالنص.",
            "Anlama göre arama şu an kullanılamıyor, metinle aramayı deneyin.",
            "Search by meaning isn't available right now, try searching the text."
          ));
        } else if (data.search && data.search.results) {
          const mappedResults: SearchResult[] = data.search.results.map((r: any) => {
            const [surah, ayah] = r.verse_key.split(':').map(Number);
            return {
              surahNumber: surah,
              ayahNumber: ayah,
              toAyah: typeof r.to === "number" && r.to > ayah ? r.to : undefined,
              text: r.text, // Text with full diacritics
              translation: r.translation ?? null,
            };
          });
          setResults(mappedResults);
        } else {
          setResults([]);
          setError(tx("لم يتم العثور على نتائج", "Sonuç bulunamadı", "No results found"));
        }
      } catch (err) {
        if (requestId !== searchRequestIdRef.current) return; // superseded by a newer search
        console.error("Search error:", err);
        setError(tx("حدث خطأ أثناء البحث", "Arama sırasında bir hata oluştu", "An error occurred while searching"));
        setResults([]);
      } finally {
        if (requestId === searchRequestIdRef.current) setIsLoading(false);
      }
    }

    fetchResults();
  }, [debouncedQuery, isArabic, mode, language]);

  const handleClear = () => {
    setQuery("");
    setDebouncedQuery("");
    setResults([]);
    setIsOpen(false);
  };

  const pickTheme = (text: string) => {
    setQuery(text);
    setDebouncedQuery(text);
    setIsOpen(true);
  };

  const handleSelect = (result: SearchResult) => {
    if (result.toAyah) onSelectRange(result.surahNumber, result.ayahNumber, result.toAyah);
    else onSelectVerse(result.surahNumber, result.ayahNumber);
    setIsOpen(false);
  };

  // Highlight every word-start match of the query inside `text` (see
  // arabicSearch.ts for the matching rules: diacritic-insensitive, and
  // hamza-lenient only when the query itself omits the hamza).
  const renderHighlightedText = (text: string) => {
    if (!debouncedQuery) return text;

    const origChars = Array.from(text);
    const matches = findWordStartMatches(text, debouncedQuery);
    if (matches.length === 0) {
      return <span className="font-arabic leading-loose text-lg">{text}</span>;
    }

    const segments: { text: string; highlight: boolean }[] = [];
    let cursor = 0;
    for (const { start, end } of matches) {
      if (start > cursor) {
        segments.push({ text: origChars.slice(cursor, start).join(""), highlight: false });
      }
      segments.push({ text: origChars.slice(start, end).join(""), highlight: true });
      cursor = end;
    }
    if (cursor < origChars.length) {
      segments.push({ text: origChars.slice(cursor).join(""), highlight: false });
    }

    return (
      <span className="font-arabic leading-loose text-lg">
        {segments.map((seg, i) =>
          seg.highlight ? (
            <span key={i} className="text-primary font-extrabold bg-primary/10 rounded px-0.5">
              {seg.text}
            </span>
          ) : (
            <span key={i}>{seg.text}</span>
          )
        )}
      </span>
    );
  };

  const jump = resolveJump && query.trim().length > 1 ? resolveJump(query) : null;
  const showDropdown = isOpen && query.trim().length > 1;
  const modeChip = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all ${
      active
        ? "border-primary/50 bg-primary/10 text-primary-dark shadow-sm dark:text-primary-light"
        : "border-border bg-surface text-muted-foreground hover:border-primary/30 hover:text-foreground"
    }`;

  return (
    <div className="relative w-full" ref={containerRef}>
      <ReciteSearch getSurahName={getSurahName} onSelect={onSelectRange}>
        <div className="relative flex items-center">
          <div className={`absolute inset-y-0 ${isArabic ? 'right-0 pr-4' : 'left-0 pl-4'} flex items-center pointer-events-none`}>
            <MagnifyingGlassIcon className="h-5 w-5 text-primary/70" aria-hidden="true" />
          </div>
          <input
            type="text"
            className={`block h-12 w-full rounded-xl border-0 ${isArabic ? 'pr-11 pl-10' : 'pl-11 pr-10'} text-[15px] text-foreground ring-1 ring-inset ring-border placeholder:text-muted-foreground/80 focus:ring-2 focus:ring-inset focus:ring-primary bg-surface shadow-sm transition-shadow focus:shadow-md`}
            placeholder={
              mode === "meaning"
                ? tx("اكتب موضوعاً: الصبر، الجنة، الأم...", "Bir konu yazın: sabır, cennet, anne...", "Type a topic: patience, paradise, mother...")
                : tx("كلمات من الآية أو «البقرة 255»", "Ayetten kelimeler ya da «Bakara 255»", "Words of the ayah or “Baqarah 255”")
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value.trim().length > 1) {
                setIsOpen(true);
              }
            }}
            dir={isArabic ? "rtl" : "ltr"}
            onFocus={() => {
              if (results.length > 0 || jump) setIsOpen(true);
            }}
          />
          {query && (
            <button
              type="button"
              className={`absolute inset-y-0 ${isArabic ? 'left-0 pl-3' : 'right-0 pr-3'} flex items-center`}
              onClick={handleClear}
              aria-label={tx("مسح", "Temizle", "Clear")}
            >
              <XMarkIcon className="h-5 w-5 text-muted-foreground hover:text-foreground transition-colors" aria-hidden="true" />
            </button>
          )}
        </div>
      </ReciteSearch>

      <div className="mt-2.5 flex flex-wrap items-center gap-2" dir={isArabic ? "rtl" : "ltr"}>
        <button type="button" onClick={() => setMode("text")} aria-pressed={mode === "text"} className={modeChip(mode === "text")}>
          <MagnifyingGlassIcon className="h-3.5 w-3.5" />
          {tx("بالكلمات", "Kelimeyle", "By words")}
        </button>
        <button type="button" onClick={() => setMode("meaning")} aria-pressed={mode === "meaning"} className={modeChip(mode === "meaning")}>
          <SparklesIcon className="h-3.5 w-3.5" />
          {tx("بالمعنى والموضوع", "Anlam ve konuyla", "By meaning or topic")}
        </button>
      </div>
      {mode === "meaning" && (
        <div className="-mx-1 mt-2 flex gap-2 overflow-x-auto px-1 pb-1" dir={isArabic ? "rtl" : "ltr"}>
          {THEMES.map((t) => {
            const label = tx(t.ar, t.tr, t.en);
            return (
              <button
                key={t.ar}
                type="button"
                onClick={() => pickTheme(label)}
                className={`flex-shrink-0 rounded-full border px-3 py-1 text-xs transition-colors ${
                  debouncedQuery === label
                    ? "border-primary/50 bg-primary/10 font-medium text-primary-dark dark:text-primary-light"
                    : "border-border/70 bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {showDropdown && (
        <div
          className={`animate-fadeIn absolute z-50 mt-1.5 w-full overflow-auto rounded-2xl border border-border bg-surface shadow-xl ${isArabic ? 'text-right' : 'text-left'}`}
          style={{ maxHeight: dropdownMaxHeight }}
          dir="rtl"
        >
          {jump && (
            <button
              type="button"
              onClick={() => {
                onSelectVerse(jump.surah, jump.ayah);
                setIsOpen(false);
              }}
              className="flex w-full items-center gap-3 border-b border-border/60 bg-primary/5 px-4 py-3 text-right transition-colors hover:bg-primary/10"
            >
              <ArrowUturnLeftIcon className="h-4 w-4 flex-shrink-0 text-primary" />
              <span className="flex-1 text-sm font-semibold text-foreground">
                {tx("انتقل إلى", "Git:", "Go to")} {tx("سورة ", "", "Surah ")}
                {getSurahName(jump.surah)}
                {jump.hasAyah ? `${tx("، الآية ", " Suresi, ", ", ayah ")}${jump.ayah}${tx("", ". ayet", "")}` : tx("", " Suresi", "")}
              </span>
            </button>
          )}
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner size="sm" />
              <span>{tx("جاري البحث...", "Aranıyor...", "Searching...")}</span>
            </div>
          ) : error ? (
            <div className="p-4 text-center text-sm text-accent-red">{error}</div>
          ) : results.length > 0 ? (
            <>
              {fallback && (
                <p className="flex items-center gap-1.5 border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
                  <SparklesIcon className="h-3.5 w-3.5 text-primary" />
                  {fallback === "near"
                    ? tx("لم أجد هذه الكلمات بنصّها، وهذه أقرب الآيات لما كتبت:", "Bu kelimeler aynen bulunamadı; yazdığınıza en yakın ayetler:", "These words weren't found as typed; the closest ayahs:")
                    : tx("لم أجد هذه الكلمات بنصّها، وهذه آيات قريبة منها في المعنى:", "Bu kelimeler aynen bulunamadı; anlamca yakın ayetler:", "These words weren't found as typed; ayahs close in meaning:")}
                </p>
              )}
              <ul className="divide-y divide-border/50">
                {results.map((result) => (
                  <li
                    key={`${result.surahNumber}-${result.ayahNumber}`}
                    className="group flex cursor-pointer items-start gap-3 px-4 py-3.5 transition-colors hover:bg-primary/5"
                    onClick={() => handleSelect(result)}
                  >
                    <span className="mt-1.5 inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary-dark ring-1 ring-inset ring-primary/15 dark:text-primary-light">
                      {getSurahName(result.surahNumber)}
                      <span className="rounded-md bg-surface px-1.5 tabular-nums">
                        {result.toAyah ? `${result.ayahNumber}-${result.toAyah}` : result.ayahNumber}
                      </span>
                    </span>
                    <div className="min-w-0 flex-1 text-foreground">
                      {mode === "meaning" || fallback ? (
                        <span className="font-arabic text-lg leading-loose">{result.text}</span>
                      ) : (
                        renderHighlightedText(result.text)
                      )}
                      {result.translation && (
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground" dir="ltr">
                          {result.translation}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : !jump ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {tx("لا توجد نتائج مطابقة", "Eşleşen sonuç bulunamadı", "No matching results found")}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
