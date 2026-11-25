// Memorization progress and when each ayah is due for review (the /hifz
// page). Pure functions, shared by the page and the server store
// (lib/hifzProgress.ts), so both always agree.
//
// Each ayah is reviewed on a growing interval (a light SM-2): read without
// a mistake and the next review comes later (1 day, 3, then ×ease), with
// one or two slips a little later than now, with more it comes back today.
// An ayah is "memorized" once its interval reaches MEMORIZED_DAYS.

export interface AyahRecord {
  // Reviews in a row without falling back to "again".
  reps: number;
  // Days until the next review.
  interval: number;
  ease: number;
  // YYYY-MM-DD (the viewer's own calendar day).
  due: string;
  last: string;
  // Share of the ayah's words said right last time (0-1).
  score: number;
  // Word index -> how often it was missed or said wrong recently.
  weak?: Record<string, number>;
}

export interface HifzSession {
  date: string;
  surah: number;
  from: number;
  to: number;
  // Share of the words reached that were said right (0-1).
  score: number;
  words: number;
  mistakes: number;
}

export interface HifzProgress {
  version: 1;
  // "surah:ayah" -> record.
  ayahs: Record<string, AyahRecord>;
  // Newest first, at most MAX_SESSIONS.
  sessions: HifzSession[];
}

export interface AyahResult {
  ayah: number;
  // Words in the ayah, and how they went.
  total: number;
  ok: number;
  wrong: number;
  missing: number;
  added: number;
  // Indices of the words said wrong or missed.
  weak: number[];
}

export const MEMORIZED_DAYS = 7;
export const MAX_SESSIONS = 300;
const START_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;

export const emptyProgress = (): HifzProgress => ({ version: 1, ayahs: {}, sessions: [] });

export function localDay(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d + days);
  return localDay(date);
}

/** Share of an ayah's words said right; an added word costs half a word. */
export function ayahScore(r: AyahResult): number {
  if (r.total <= 0) return 0;
  return Math.max(0, (r.ok - 0.5 * r.added) / r.total);
}

/** The record after one recitation of the ayah. */
export function review(prev: AyahRecord | undefined, result: AyahResult, today: string): AyahRecord {
  const score = ayahScore(result);
  const rec: AyahRecord = prev
    ? { ...prev, weak: { ...(prev.weak ?? {}) } }
    : { reps: 0, interval: 0, ease: START_EASE, due: today, last: today, score: 0, weak: {} };
  if (score >= 0.98) {
    rec.interval = rec.reps === 0 ? 1 : rec.reps === 1 ? 3 : Math.round(Math.max(rec.interval, 1) * rec.ease);
    rec.ease = Math.min(MAX_EASE, rec.ease + 0.05);
    rec.reps += 1;
  } else if (score >= 0.9) {
    rec.interval = Math.max(1, Math.round(rec.interval * 1.2));
    rec.ease = Math.max(MIN_EASE, rec.ease - 0.15);
    rec.reps += 1;
  } else {
    rec.interval = 0;
    rec.ease = Math.max(MIN_EASE, rec.ease - 0.2);
    rec.reps = 0;
  }
  rec.due = addDays(today, rec.interval);
  rec.last = today;
  rec.score = Math.round(score * 1000) / 1000;
  // Weak words: each slip counts one, each clean reading forgives half.
  const weak = rec.weak ?? {};
  const slipped = new Set(result.weak.map(String));
  for (const key of Object.keys(weak)) {
    if (!slipped.has(key)) {
      weak[key] -= 0.5;
      if (weak[key] <= 0) delete weak[key];
    }
  }
  for (const key of slipped) weak[key] = (weak[key] ?? 0) + 1;
  rec.weak = weak;
  return rec;
}

/** Marks ayahs as already known: they join the reviews a week from now. */
export function markKnown(today: string): AyahRecord {
  return { reps: 2, interval: MEMORIZED_DAYS, ease: START_EASE, due: addDays(today, MEMORIZED_DAYS), last: today, score: 1, weak: {} };
}

export type AyahState = "new" | "learning" | "memorized";

export function ayahState(rec: AyahRecord | undefined): AyahState {
  if (!rec) return "new";
  return rec.interval >= MEMORIZED_DAYS ? "memorized" : "learning";
}

export interface DueRange {
  surah: number;
  from: number;
  to: number;
  // The ayah overdue the longest, for ordering.
  oldest: string;
}

// A review session covers at most this many ayahs: more is split.
const MAX_DUE_RANGE = 10;

/** Ayahs due on `today` or earlier, as runs of consecutive ayahs. */
export function dueRanges(progress: HifzProgress, today: string): DueRange[] {
  const due = Object.entries(progress.ayahs)
    .filter(([, r]) => r.due <= today)
    .map(([key, r]) => {
      const [surah, ayah] = key.split(":").map(Number);
      return { surah, ayah, due: r.due };
    })
    .sort((a, b) => a.surah - b.surah || a.ayah - b.ayah);
  const out: DueRange[] = [];
  for (const d of due) {
    const last = out[out.length - 1];
    if (last && last.surah === d.surah && last.to === d.ayah - 1 && last.to - last.from + 1 < MAX_DUE_RANGE) {
      last.to = d.ayah;
      if (d.due < last.oldest) last.oldest = d.due;
    } else {
      out.push({ surah: d.surah, from: d.ayah, to: d.ayah, oldest: d.due });
    }
  }
  return out.sort((a, b) => (a.oldest < b.oldest ? -1 : a.oldest > b.oldest ? 1 : a.surah - b.surah || a.from - b.from));
}

/** Per surah: ayahs memorized and being learned. */
export function surahTotals(progress: HifzProgress): Map<number, { memorized: number; learning: number }> {
  const totals = new Map<number, { memorized: number; learning: number }>();
  for (const [key, rec] of Object.entries(progress.ayahs)) {
    const surah = Number(key.split(":")[0]);
    const t = totals.get(surah) ?? { memorized: 0, learning: 0 };
    if (ayahState(rec) === "memorized") t.memorized += 1;
    else t.learning += 1;
    totals.set(surah, t);
  }
  return totals;
}
