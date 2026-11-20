import React, { useState, useEffect, useRef } from "react";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useLanguage, useT } from "@/lib/LanguageContext";
import Spinner from "@/components/ui/Spinner";
import { findWordStartMatches } from "@/lib/arabicSearch";
import ReciteSearch from "./ReciteSearch";

interface QuranSearchProps {
  onSelectVerse: (surahNumber: number, ayahNumber: number) => void;
  // A range found by reciting it (ReciteSearch) -- one ayah or several.
  onSelectRange: (surahNumber: number, fromAyah: number, toAyah: number) => void;
  getSurahName: (surahNumber: number) => string;
}

interface SearchResult {
  surahNumber: number;
  ayahNumber: number;
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

export default function QuranSearch({ onSelectVerse, onSelectRange, getSurahName }: QuranSearchProps) {
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
        const response = await fetch(`/api/quran/search?${params}`);
        const data = await response.json();
        if (requestId !== searchRequestIdRef.current) return; // superseded by a newer search

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
    onSelectVerse(result.surahNumber, result.ayahNumber);
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

  return (
    <div className="relative w-full" ref={containerRef}>
      <div className="relative flex items-center">
        <div className={`absolute inset-y-0 ${isArabic ? 'right-0 pr-3' : 'left-0 pl-3'} flex items-center pointer-events-none`}>
          <MagnifyingGlassIcon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <input
          type="text"
          className={`block w-full rounded-xl border-0 py-3 ${isArabic ? 'pr-10 pl-10' : 'pl-10 pr-10'} text-foreground ring-1 ring-inset ring-border placeholder:text-muted-foreground focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm sm:leading-6 bg-surface shadow-sm`}
          placeholder={
            mode === "meaning"
              ? tx("اكتب موضوعاً: الصبر، الجنة، الأم...", "Bir konu yazın: sabır, cennet, anne...", "Type a topic: patience, paradise, mother...")
              : tx("ابحث عن آية أو كلمة في القرآن...", "Kur'an'da bir ayet veya kelime arayın...", "Search the Quran for an ayah or word...")
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
            if (results.length > 0) setIsOpen(true);
          }}
        />
        {query && (
          <button
            type="button"
            className={`absolute inset-y-0 ${isArabic ? 'left-0 pl-3' : 'right-0 pr-3'} flex items-center`}
            onClick={handleClear}
          >
            <XMarkIcon className="h-5 w-5 text-muted-foreground hover:text-foreground transition-colors" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2" dir={isArabic ? "rtl" : "ltr"}>
        <div className="flex rounded-lg border border-border bg-background p-0.5 text-xs font-medium">
          {(["text", "meaning"] as SearchMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 transition-colors ${mode === m ? "bg-primary text-white shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {m === "text" ? tx("بالنص", "Metne göre", "By text") : tx("بالمعنى والموضوع", "Anlama / konuya göre", "By meaning / topic")}
            </button>
          ))}
        </div>
        <ReciteSearch getSurahName={getSurahName} onSelect={onSelectRange} />
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
                className={`flex-shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  debouncedQuery === label
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {isOpen && (query.length > 1) && (
        <div
          className={`animate-fadeIn absolute z-50 mt-1 w-full rounded-xl bg-surface border border-border shadow-lg overflow-auto ${isArabic ? 'text-right' : 'text-left'}`}
          style={{ maxHeight: dropdownMaxHeight }}
          dir="rtl"
        >
          {isLoading ? (
            <div className="p-4 flex items-center justify-center gap-2 text-muted-foreground">
              <Spinner size="sm" />
              <span>{tx("جاري البحث...", "Aranıyor...", "Searching...")}</span>
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-accent-red text-center">{error}</div>
          ) : results.length > 0 ? (
            <ul className="divide-y divide-border/50">
              {results.map((result) => (
                <li
                  key={`${result.surahNumber}-${result.ayahNumber}`}
                  className="p-4 hover:bg-primary/5 cursor-pointer transition-colors flex items-start gap-4"
                  onClick={() => handleSelect(result)}
                >
                  <div className="flex-shrink-0 mt-1">
                    <span className="inline-flex items-center rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary ring-1 ring-inset ring-primary/20 whitespace-nowrap">
                      [{getSurahName(result.surahNumber)} {result.ayahNumber}]
                    </span>
                  </div>
                  <div className="flex-1 text-foreground">
                    {mode === "meaning" ? <span className="font-arabic leading-loose text-lg">{result.text}</span> : renderHighlightedText(result.text)}
                    {result.translation && (
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground" dir="ltr">
                        {result.translation}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-sm text-muted-foreground text-center">
              {tx("لا توجد نتائج مطابقة", "Eşleşen sonuç bulunamadı", "No matching results found")}
              {mode === "text" && (
                <button type="button" onClick={() => setMode("meaning")} className="mt-2 block w-full font-medium text-primary hover:underline">
                  {tx("ابحث بالمعنى بدلاً من ذلك", "Bunun yerine anlama göre ara", "Search by meaning instead")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
