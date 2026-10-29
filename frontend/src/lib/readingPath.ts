import { isMarkToken } from "@/remotion/timing";

// The aligner's record of the order the reciter actually read in, written
// only when he went back and read part of the selection again (see
// backend/scripts/quran_aligner.py, _reading_path): each reading is a run of
// one ayah's tokens `from`..`to` (pause marks included) with [start, end] ms
// per token on the prepared clip; `jump` marks a reading he went back for.
export interface Reading {
  ayah: number;
  from: number;
  to: number;
  jump: boolean;
  words: [number, number][];
}

interface AyahInfo {
  id: number;
  // The ayah's translation, for an unsplit ayah's own part.
  translation: string;
  // The prepared clip's tokens for the ayah (preparedJsonData.verses[id].words[].w).
  tokens: string[];
}

interface Appearance {
  ayah: number;
  unit: number;
  start: number;
  end: number;
}

const SCALE_FIELDS = ["arabicTextScale", "arabicWidthScale", "translationTextScale", "translationWidthScale"] as const;

// Turns the reading path into the segmentation the video and the timing
// editor show, on these rules (the user's, 2026-10-27). A "unit" is a part
// of an ayah as it is split -- or the whole ayah when it isn't:
// - going back to the FIRST word of the unit on screen shows it again;
// - going back to a word in the middle of it keeps it on screen (no flash);
// - going back to a unit already left (an earlier part, or an earlier ayah
//   after the next one began) shows that unit again, wherever in it he
//   restarts -- the screen shows another unit at that moment.
// Every appearance after a unit's first becomes a repeat of it (same Arabic
// and translation), timed to the reading; the ayah's parts get the times of
// their first appearance. Ayahs the reciter didn't go back in are left as
// they are; returns `segmentation` itself when there is nothing to change.
export function applyReadings<S extends { surah: number; ayah: number; mappings: any[] }>(
  segmentation: S[],
  readings: Reading[] | undefined,
  ayahs: AyahInfo[],
  surahId: number
): S[] {
  if (!readings?.length) return segmentation;
  const info = new Map(ayahs.map((a) => [a.id, a]));
  const units = new Map<number, { from: number; to: number; mapping: any | null }[]>();
  for (const a of ayahs) {
    const parts = (segmentation.find((s) => s.surah === surahId && s.ayah === a.id)?.mappings ?? []).filter(
      (m) => typeof m.repeat_of_part !== "number"
    );
    let cursor = 0;
    units.set(
      a.id,
      parts.length > 0
        ? parts.map((m) => {
            const unit = { from: cursor, to: cursor + m.word_count - 1, mapping: m };
            cursor += m.word_count;
            return unit;
          })
        : [{ from: 0, to: a.tokens.length - 1, mapping: null }]
    );
  }

  const appearances: Appearance[] = [];
  let current: Appearance | null = null;
  for (const r of readings) {
    const ayahUnits = units.get(r.ayah);
    const tokens = info.get(r.ayah)?.tokens;
    if (!ayahUnits || !tokens) continue;
    r.words.forEach(([start, end], k) => {
      const token = r.from + k;
      if (isMarkToken(tokens[token] ?? "")) return;
      const unit = ayahUnits.findIndex((u) => token >= u.from && token <= u.to);
      if (unit < 0) return;
      // The unit's first SPOKEN word: a part can open on a Hizb sign ۞.
      let firstWord = ayahUnits[unit].from;
      while (firstWord < ayahUnits[unit].to && isMarkToken(tokens[firstWord] ?? "")) firstWord++;
      const restart = r.jump && k === 0 && token === firstWord;
      if (!current || current.ayah !== r.ayah || current.unit !== unit || restart) {
        current = { ayah: r.ayah, unit, start, end };
        appearances.push(current);
      } else {
        current.end = end;
      }
    });
  }

  // Rebuilt: every ayah he went back in -- its parts take their times from
  // the readings, so one he repeated the middle of stays on screen through
  // the repeat instead of vanishing when its first reading ends.
  const repeatedAyahs = new Set(readings.filter((r) => r.jump).map((r) => r.ayah));
  const count = new Map<string, number>();
  for (const a of appearances) {
    const key = `${a.ayah}:${a.unit}`;
    count.set(key, (count.get(key) ?? 0) + 1);
    if (count.get(key)! > 1) repeatedAyahs.add(a.ayah);
  }
  if (repeatedAyahs.size === 0) return segmentation;

  const rebuilt = new Map<number, any[]>();
  for (const ayah of Array.from(repeatedAyahs)) {
    const ayahUnits = units.get(ayah)!;
    const ofAyah = appearances.filter((a) => a.ayah === ayah);
    const seen = new Set<number>();
    const list = ofAyah.map((a) => {
      const repeat = seen.has(a.unit);
      seen.add(a.unit);
      return { a, repeat };
    });
    const partNumber = new Map<number, number>();
    list.forEach(({ a, repeat }, idx) => {
      if (!repeat) partNumber.set(a.unit, idx + 1);
    });
    rebuilt.set(
      ayah,
      list.map(({ a, repeat }, idx) => {
        const unit = ayahUnits[a.unit];
        const source = unit.mapping;
        const mapping: any = {
          part: idx + 1,
          word_count: unit.to - unit.from + 1,
          translation_text: source?.translation_text ?? info.get(ayah)!.translation,
          start_ms: Math.round(a.start),
          end_ms: Math.round(a.end),
          isFirstOfAyah: a.unit === 0,
          ...(repeat ? { repeat_of_part: partNumber.get(a.unit) } : {}),
        };
        for (const field of SCALE_FIELDS) {
          if (source && source[field] !== undefined) mapping[field] = source[field];
        }
        return mapping;
      })
    );
  }

  const next = segmentation.filter((s) => !(s.surah === surahId && rebuilt.has(s.ayah)));
  for (const [ayah, mappings] of Array.from(rebuilt.entries())) {
    next.push({ surah: surahId, ayah, mappings } as S);
  }
  return next.sort((x, y) => x.ayah - y.ayah);
}
