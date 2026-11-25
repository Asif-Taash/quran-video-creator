// Shared shapes of the memorization page (/hifz).

// How the ayahs are shown while memorizing: all of it, each word's first
// letter, nothing (tap a word to see it), or every other word.
export type HideMode = "show" | "hint" | "hide" | "alternate";

export interface HifzWordData {
  // Glyph code in the page font p{page}; Uthmani text; plain spelling.
  g: string;
  u: string;
  t: string;
  p: number;
  l: number;
}

export interface HifzVerseData {
  // Surah: a whole mushaf page can hold two.
  s?: number;
  n: number;
  words: HifzWordData[];
  end: { g: string; p: number; l: number } | null;
}

export interface RangeData {
  verses: HifzVerseData[];
  // "page:line" -> glyph units on that printed line.
  lines: Record<string, number>;
  pages?: number[];
  // A recitation's data (?session=): the last ayah it can reach.
  sessionEnd?: number;
}

// One expected word after a recitation check (backend scripts/hifz_check.py).
export interface WordResult {
  // tashkeel: the letters right, a vowel wrong (a softer flag than wrong).
  // unclear: said too faintly to judge (not counted either way).
  s: "ok" | "wrong" | "tashkeel" | "missing" | "unread" | "unclear";
  // What was heard instead (wrong).
  h?: string;
  // Where in the word (wrong / tashkeel): indices of its letters, a haraka
  // counting as the letter it is on.
  x?: number[];
  // How, sound by sound (backend hifz_judge).
  d?: SlipDetail[];
  // Where in the recording (seconds).
  t0?: number;
  t1?: number;
  // Whisper doubted it and the acoustic check found it said right.
  checked?: boolean;
}

export interface ExtraResult {
  // Index (over the range's words) of the word before; -1 before the first.
  after: number;
  kind: "restart" | "added";
  h: string;
  t0: number;
  t1: number;
}

// One differing sound: what should have been said (w) and what was (s), on
// letter x of the word. letter: another letter; vowel: another haraka; drop:
// left out; add: said more; stop: the ending read as at a stop while running
// on; hamza: a hamzat al-wasl said while running on; word: another word.
export interface SlipDetail {
  k: "letter" | "vowel" | "drop" | "add" | "stop" | "hamza" | "word";
  w: string;
  s: string;
  x: number;
}

// A slip the reader put right by going back (the word ended up right).
export interface FixedResult extends WordResult {
  w: number;
}

export interface CheckResult {
  words: WordResult[];
  extras: ExtraResult[];
  fixed?: FixedResult[];
  heard: string;
  duration: number;
  checked: number;
}

export const wordKey = (ayah: number, index: number) => `${ayah}:${index}`;

// What the reader picked to do (the mode bar on the memorization page).
export type HifzMode = "read" | "recite" | "listen";

// A slip found in a recitation, in reading order.
export interface Mistake {
  order: number;
  key: string;
  ayah: number;
  word: string;
  kind: "wrong" | "missing" | "tashkeel" | "added";
  heard?: string;
  x?: number[];
  d?: SlipDetail[];
  // Put right by going back: the word ended up right.
  corrected?: boolean;
  t0?: number;
  t1?: number;
}

export interface Outcome {
  // Words read and how many were right (a vowel slip counts as known).
  total: number;
  right: number;
  mistakes: Mistake[];
  // Nothing but vowel slips.
  passed: boolean;
  // The last ayah reached, and whether the reading stopped before the end.
  reachedAyah: number;
  stoppedEarly: boolean;
  // Words said too faintly to judge.
  unclear: number;
  // Slips put right by going back.
  fixed: Mistake[];
  // Where going on starts: the ayah stopped in if it wasn't finished, else the next.
  nextAyah: number;
}
