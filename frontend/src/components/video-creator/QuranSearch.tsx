import React, { useState, useEffect, useRef } from "react";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useLanguage } from "@/lib/LanguageContext";
import Spinner from "@/components/ui/Spinner";
import { findWordStartMatches } from "@/lib/arabicSearch";

interface QuranSearchProps {
  onSelectVerse: (surahNumber: number, ayahNumber: number) => void;
  getSurahName: (surahNumber: number) => string;
  onOpenChange?: (isOpen: boolean) => void;
}

interface SearchResult {
  surahNumber: number;
  ayahNumber: number;
  text: string;
}

export default function QuranSearch({ onSelectVerse, getSurahName, onOpenChange }: QuranSearchProps) {
  const { language } = useLanguage();
  const isArabic = language === "ar";
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [dropdownMaxHeight, setDropdownMaxHeight] = useState(420);

  // Let the caller (the wizard) hide whatever sits below — e.g. the
  // Back/Next footer — while the dropdown is open, instead of us capping
  // our own height to dodge it.
  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  // Size the dropdown as a share of the viewport (half its height, clamped
  // between 220 and 560px) rather than a flat pixel value, so it scales up
  // on taller phones instead of looking cramped. It doesn't need to dodge
  // whatever sits below on the page — the wizard hides its footer nav while
  // the dropdown is open (see onOpenChange above) — and being an overlay
  // over a scrollable page, it's fine for it to extend past the fold.
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
        const response = await fetch(`/api/quran/search?q=${encodeURIComponent(debouncedQuery)}`);
        const data = await response.json();
        if (requestId !== searchRequestIdRef.current) return; // superseded by a newer search

        if (data.search && data.search.results) {
          const mappedResults: SearchResult[] = data.search.results.map((r: any) => {
            const [surah, ayah] = r.verse_key.split(':').map(Number);
            return {
              surahNumber: surah,
              ayahNumber: ayah,
              text: r.text, // Text with full diacritics
            };
          });
          setResults(mappedResults);
        } else {
          setResults([]);
          setError(isArabic ? "لم يتم العثور على نتائج" : "Sonuç bulunamadı");
        }
      } catch (err) {
        if (requestId !== searchRequestIdRef.current) return; // superseded by a newer search
        console.error("Search error:", err);
        setError(isArabic ? "حدث خطأ أثناء البحث" : "Arama sırasında bir hata oluştu");
        setResults([]);
      } finally {
        if (requestId === searchRequestIdRef.current) setIsLoading(false);
      }
    }

    fetchResults();
  }, [debouncedQuery, isArabic]);

  const handleClear = () => {
    setQuery("");
    setDebouncedQuery("");
    setResults([]);
    setIsOpen(false);
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
          placeholder={isArabic ? "ابحث عن آية أو كلمة في القرآن..." : "Kur'an'da bir ayet veya kelime arayın..."}
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

      {isOpen && (query.length > 1) && (
        <div
          className={`animate-fadeIn absolute z-50 mt-1 w-full rounded-xl bg-surface border border-border shadow-lg overflow-auto ${isArabic ? 'text-right' : 'text-left'}`}
          style={{ maxHeight: dropdownMaxHeight }}
          dir="rtl"
        >
          {isLoading ? (
            <div className="p-4 flex items-center justify-center gap-2 text-muted-foreground">
              <Spinner size="sm" />
              <span>{isArabic ? "جاري البحث..." : "Aranıyor..."}</span>
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
                    {renderHighlightedText(result.text)}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-sm text-muted-foreground text-center">
              {isArabic ? "لا توجد نتائج مطابقة" : "Eşleşen sonuç bulunamadı"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
