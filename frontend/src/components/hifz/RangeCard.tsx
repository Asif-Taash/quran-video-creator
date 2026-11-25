"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, MinusIcon, PlusIcon } from "@heroicons/react/24/outline";
import DropdownSelect from "@/components/ui/DropdownSelect";
import QuranSearch from "@/components/video-creator/QuranSearch";
import { useLanguage, useT } from "@/lib/LanguageContext";
import { findSurahJump } from "@/lib/surahJump";
import { surahEnglishName } from "@/lib/surahEnglishNames";
import { ayahState, type HifzProgress } from "@/lib/hifzSchedule";
import type { HifzSurah } from "./HifzPage";

// Which ayahs to memorize: the same search (words, meaning, "البقرة 255",
// 🎤) and surah / from / to fields as the video creator's first step, with
// a step to the previous or next ayahs of the same length, and where these
// ayahs stand in the reader's progress.

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";

// An ayah number box: what is typed is taken once it's done (Enter, leaving
// the box, or a pause), not digit by digit -- as in the video creator.
function AyahNumberField({
  value,
  min,
  max,
  onCommit,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
  ariaLabel: string;
}) {
  const [text, setText] = useState(String(value));
  const timerRef = useRef<number | null>(null);
  useEffect(() => setText(String(value)), [value]);
  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);
  const commit = (raw: string) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(Math.max(n, min), max);
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={text}
      onChange={(e) => {
        const typed = e.target.value.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d))).replace(/\D/g, "");
        setText(typed);
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => commit(typed), 1000);
      }}
      onBlur={() => commit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(text);
      }}
      className="h-full w-full min-w-0 bg-transparent text-center text-base font-semibold tabular-nums text-foreground outline-none"
    />
  );
}

export default function RangeCard({
  surahs,
  surahName,
  surah,
  from,
  to,
  onSelect,
  progress,
  onMark,
  bare = false,
}: {
  surahs: HifzSurah[];
  surahName: (id: number) => string;
  surah: HifzSurah;
  from: number;
  to: number;
  onSelect: (surah: number, from: number, to: number) => void;
  progress: HifzProgress | null;
  onMark: (state: "known" | "forget") => void;
  // Inside a dialog: no card of its own, no heading.
  bare?: boolean;
}) {
  const tx = useT();
  const { language } = useLanguage();
  const isArabic = language === "ar";

  const jumpSurahs = useMemo(
    () =>
      surahs.map((s) => ({
        id: s.id,
        totalVerses: s.total,
        names: [s.name, s.transliteration, surahEnglishName(s.id) ?? ""].filter(Boolean),
      })),
    [surahs]
  );

  // Where the chosen ayahs stand.
  const counts = useMemo(() => {
    const c = { new: 0, learning: 0, memorized: 0 };
    for (let a = from; a <= to; a++) c[ayahState(progress?.ayahs[`${surah.id}:${a}`])]++;
    return c;
  }, [progress, surah.id, from, to]);
  const size = to - from + 1;
  const tracked = counts.learning + counts.memorized;

  const fieldShell =
    "flex h-[50px] items-stretch overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20";
  const stepButton =
    "flex w-10 flex-shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:pointer-events-none disabled:opacity-30";
  // "Previous" points the way the page reads back: right in Arabic.
  const PrevIcon = isArabic ? ChevronRightIcon : ChevronLeftIcon;
  const NextIcon = isArabic ? ChevronLeftIcon : ChevronRightIcon;

  return (
    <div className={bare ? "space-y-5" : "relative space-y-6 rounded-2xl p-4 shadow-lg sm:p-6 md:p-8"}>
      {!bare && (
        <>
          <div className="absolute inset-0 -z-10 overflow-hidden rounded-2xl border border-primary/10 bg-surface-2/80 backdrop-blur-md" />
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary-light/30 via-primary/20 to-primary-dark/20 text-sm text-primary ring-1 ring-primary/20">
              1
            </span>
            {tx("ماذا تحفظ؟", "Ne ezberleyeceksiniz?", "What to memorize?")}
          </h2>
        </>
      )}

      <QuranSearch
        getSurahName={surahName}
        resolveJump={(q) => findSurahJump(q, jumpSurahs)}
        onSelectVerse={(s, a) => onSelect(s, a, a)}
        onSelectRange={onSelect}
      />

      <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
        <span className="h-px flex-1 bg-border" />
        {tx("أو اختر بنفسك", "ya da kendiniz seçin", "or choose yourself")}
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-[minmax(0,1fr)_9.5rem_11rem]">
        <div className="col-span-2 md:col-span-1">
          <DropdownSelect
            label={tx("السورة", "Sure", "Surah")}
            placeholder={tx("اختر السورة...", "Sure seçin...", "Choose a surah...")}
            options={surahs.map((s) => ({
              value: String(s.id),
              label: isArabic ? `سورة ${s.name}` : language === "en" ? `Surah ${surahName(s.id)}` : `${s.transliteration} Suresi`,
            }))}
            value={String(surah.id)}
            onChange={(val) => {
              const s = surahs.find((x) => String(x.id) === String(val));
              if (s) onSelect(s.id, 1, Math.min(s.total, 5));
            }}
            isRtl={isArabic}
            showNumberBadge
            enableSearch
            searchPlaceholder={tx("ابحث عن سورة...", "Sure ara...", "Search surahs...")}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">{tx("من الآية", "Başlangıç ayeti", "From ayah")}</label>
          <div className={fieldShell}>
            <AyahNumberField
              ariaLabel={tx("من الآية", "Başlangıç ayeti", "From ayah")}
              value={from}
              min={1}
              max={surah.total}
              onCommit={(n) => onSelect(surah.id, n, Math.max(n, Math.min(surah.total, n + (to - from))))}
            />
          </div>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">{tx("إلى الآية", "Bitiş ayeti", "To ayah")}</label>
          <div className={fieldShell} dir="ltr">
            <button
              type="button"
              onClick={() => onSelect(surah.id, from, to - 1)}
              disabled={to <= from}
              aria-label={tx("إزالة آخر آية", "Son ayeti çıkar", "Remove the last ayah")}
              className={`${stepButton} border-r border-border/70`}
            >
              <MinusIcon className="h-4 w-4" />
            </button>
            <AyahNumberField
              ariaLabel={tx("إلى الآية", "Bitiş ayeti", "To ayah")}
              value={to}
              min={from}
              max={surah.total}
              onCommit={(n) => onSelect(surah.id, from, n)}
            />
            <button
              type="button"
              onClick={() => onSelect(surah.id, from, to + 1)}
              disabled={to >= surah.total}
              aria-label={tx("أضف الآية التالية", "Sonraki ayeti ekle", "Add the next ayah")}
              className={`${stepButton} border-l border-border/70`}
            >
              <PlusIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* The same number of ayahs before or after: the next lesson. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onSelect(surah.id, Math.max(1, from - size), from - 1)}
          disabled={from <= 1}
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-surface disabled:pointer-events-none disabled:opacity-40"
        >
          <PrevIcon className="h-4 w-4" />
          {tx("الآيات السابقة", "Önceki ayetler", "Previous ayahs")}
        </button>
        <button
          type="button"
          onClick={() => onSelect(surah.id, to + 1, Math.min(surah.total, to + size))}
          disabled={to >= surah.total}
          className="inline-flex items-center gap-1 rounded-lg border border-primary/40 px-3 py-2 text-sm font-medium text-primary transition-colors hover:border-primary hover:bg-primary/10 disabled:pointer-events-none disabled:opacity-40"
        >
          {tx("الآيات التالية", "Sonraki ayetler", "Next ayahs")}
          <NextIcon className="h-4 w-4" />
        </button>

        <div className="ms-auto flex flex-wrap items-center gap-2 text-xs">
          {counts.memorized > 0 && (
            <span className="rounded-full bg-accent-green-bg/70 px-2.5 py-1 font-medium text-accent-green">
              {tx(`محفوظة ${counts.memorized}`, `Ezber ${counts.memorized}`, `Memorized ${counts.memorized}`)}
            </span>
          )}
          {counts.learning > 0 && (
            <span className="rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary-dark dark:text-primary-light">
              {tx(`قيد الحفظ ${counts.learning}`, `Çalışılıyor ${counts.learning}`, `Learning ${counts.learning}`)}
            </span>
          )}
          {counts.memorized < size && (
            <button
              type="button"
              onClick={() => onMark("known")}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
              title={tx(
                "أحفظها من قبل: تدخل المراجعة بعد أسبوع",
                "Zaten ezberimde: bir hafta sonra tekrara girer",
                "Already know them: they come up for review in a week"
              )}
            >
              <CheckIcon className="h-3.5 w-3.5" />
              {tx("أحفظها من قبل", "Zaten ezberimde", "I know these")}
            </button>
          )}
          {tracked > 0 && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm(tx("أبدأ حفظ هذه الآيات من جديد؟ يُمسح تقدّمها.", "Bu ayetlere baştan başlansın mı? İlerlemesi silinir.", "Start these ayahs over? Their progress is cleared."))) {
                  onMark("forget");
                }
              }}
              className="rounded-full px-2 py-1 font-medium text-muted-foreground transition-colors hover:text-accent-red"
            >
              {tx("ابدأ من جديد", "Baştan başla", "Start over")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
