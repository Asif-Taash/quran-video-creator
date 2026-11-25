"use client";

import React, { useMemo } from "react";
import { CalendarDaysIcon, CheckBadgeIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useT } from "@/lib/LanguageContext";
import { dueRanges, localDay, surahTotals, type HifzProgress } from "@/lib/hifzSchedule";
import type { HifzSurah } from "./HifzPage";

// My reviews: what falls due today (runs of ayahs, oldest first, one tap to
// recite them), how much is memorized, each surah's share, and the last
// recitations.

export default function ReviewCard({
  progress,
  surahs,
  surahName,
  onStart,
  bare = false,
}: {
  progress: HifzProgress;
  surahs: HifzSurah[];
  surahName: (id: number) => string;
  onStart: (surah: number, from: number, to: number) => void;
  bare?: boolean;
}) {
  const tx = useT();
  const today = localDay();
  const due = useMemo(() => dueRanges(progress, today), [progress, today]);
  const totals = useMemo(() => surahTotals(progress), [progress]);
  const memorized = Array.from(totals.values()).reduce((n, t) => n + t.memorized, 0);
  const learning = Array.from(totals.values()).reduce((n, t) => n + t.learning, 0);
  const dueAyahs = due.reduce((n, d) => n + d.to - d.from + 1, 0);
  const surahRows = Array.from(totals.entries())
    .map(([id, t]) => ({ id, ...t, total: surahs.find((s) => s.id === id)?.total ?? 1 }))
    .sort((a, b) => b.memorized + b.learning - (a.memorized + a.learning))
    .slice(0, 6);

  return (
    <div className={bare ? "space-y-5" : "relative space-y-5 rounded-2xl p-4 shadow-lg sm:p-6"}>
      {!bare && <div className="absolute inset-0 -z-10 overflow-hidden rounded-2xl border border-primary/10 bg-surface-2/80 backdrop-blur-md" />}
      <div className="flex flex-wrap items-center gap-3">
        {!bare && (
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <CalendarDaysIcon className="h-6 w-6 text-primary" />
            {tx("مراجعتي", "Tekrarlarım", "My reviews")}
          </h2>
        )}
        <div className={`${bare ? "" : "ms-auto"} flex flex-wrap gap-2 text-xs`}>
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-green-bg/70 px-2.5 py-1 font-medium text-accent-green">
            <CheckBadgeIcon className="h-4 w-4" />
            {tx(`${memorized} آية محفوظة`, `${memorized} ayet ezber`, `${memorized} ayahs memorized`)}
          </span>
          {learning > 0 && (
            <span className="rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary-dark dark:text-primary-light">
              {tx(`${learning} قيد الحفظ`, `${learning} çalışılıyor`, `${learning} learning`)}
            </span>
          )}
        </div>
      </div>

      {due.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            {tx(`للمراجعة اليوم: ${dueAyahs} آية`, `Bugün tekrar: ${dueAyahs} ayet`, `Due today: ${dueAyahs} ayahs`)}
          </p>
          <div className="flex flex-wrap gap-2">
            {due.slice(0, 8).map((d) => (
              <button
                key={`${d.surah}:${d.from}`}
                type="button"
                onClick={() => onStart(d.surah, d.from, d.to)}
                className="group inline-flex items-center gap-2 rounded-xl border border-primary/30 bg-background px-3 py-2 text-sm transition-colors hover:border-primary hover:bg-primary/5"
              >
                <PlayIcon className="h-4 w-4 text-primary" />
                <span className="font-medium text-foreground">{surahName(d.surah)}</span>
                <span className="tabular-nums text-muted-foreground">{d.from === d.to ? d.from : `${d.from}–${d.to}`}</span>
                {d.oldest < today && (
                  <span className="rounded-full bg-accent-amber-bg/70 px-1.5 text-[10px] font-medium text-accent-amber">
                    {tx("متأخرة", "gecikti", "late")}
                  </span>
                )}
              </button>
            ))}
            {due.length > 8 && <span className="self-center text-xs text-muted-foreground">+{due.length - 8}</span>}
          </div>
        </div>
      ) : (
        <p className="text-sm text-accent-green">
          {tx("لا مراجعة اليوم، أحسنت! احفظ آيات جديدة.", "Bugün tekrar yok, maşallah! Yeni ayetler ezberleyin.", "Nothing due today, well done! Memorize something new.")}
        </p>
      )}

      {surahRows.length > 0 && (
        <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {surahRows.map((r) => {
            const mem = Math.round((r.memorized / r.total) * 100);
            const learn = Math.round((r.learning / r.total) * 100);
            return (
              <div key={r.id} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-medium text-foreground">{surahName(r.id)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {tx(`محفوظة ${r.memorized} من ${r.total}`, `${r.total} ayetten ${r.memorized} ezber`, `${r.memorized} of ${r.total} memorized`)}
                  </span>
                </div>
                <div className="flex h-1.5 overflow-hidden rounded-full bg-border/60">
                  <div className="h-full bg-accent-green" style={{ width: `${mem}%` }} />
                  <div className="h-full bg-primary/30" style={{ width: `${learn}%` }} title={tx("قيد الحفظ", "Çalışılıyor", "Learning")} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {progress.sessions.length > 0 && (
        <div className="space-y-1.5 border-t border-border/60 pt-3">
          <p className="text-xs font-medium text-muted-foreground">{tx("آخر التسميعات", "Son okumalar", "Recent recitations")}</p>
          <ul className="space-y-1 text-xs">
            {progress.sessions.slice(0, 4).map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="tabular-nums text-muted-foreground" dir="ltr">
                  {s.date.slice(5).replace("-", "/")}
                </span>
                <span className="truncate text-foreground">
                  {surahName(s.surah)} {s.from === s.to ? s.from : `${s.from}–${s.to}`}
                </span>
                <span
                  className={`ms-auto rounded-full px-2 py-0.5 font-semibold tabular-nums ${
                    s.score >= 0.95 ? "bg-accent-green-bg/70 text-accent-green" : s.score >= 0.8 ? "bg-primary/10 text-primary-dark dark:text-primary-light" : "bg-accent-red/10 text-accent-red"
                  }`}
                >
                  {Math.round(s.score * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
