// quran-uthmani.json (Tanzil) opens every surah's ayah 1 with the basmala,
// Al-Fatiha's own aside (where it IS ayah 1); At-Tawba has none. Dropping
// it by comparing with one exact string never worked -- the file's marks
// don't always come in the same order -- so searching "بسم الله" listed
// every surah's ayah 1 (2026-11-20). Matched by letters instead.
const MARKS = /[ً-ٰٟـۖ-ۭ]/g;

export function withoutBasmala(surah: number, ayah: number, text: string): string {
  if (surah <= 1 || ayah !== 1) return text;
  const words = text.split(" ");
  const bare = (w: string) => w.replace(MARKS, "");
  return words.length > 4 && bare(words[0]) === "بسم" && bare(words[3]).endsWith("رحيم") ? words.slice(4).join(" ") : text;
}
