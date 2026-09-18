// Latin-script reciter display names -- shared between the client
// (VideoCreatorForm's suggested video title) and the server
// (render/route.ts, stored per gallery entry as reciterNameLatin) so both
// use the exact same spelling, and a new reciter's Latin name only ever
// needs adding in this one place. Deliberately its own list rather than
// reusing Step3Audio.tsx's Turkish-mode dropdown labels (e.g. "Mishary
// Rashed Alafasy"), which are a different, longer style, or render/route.ts's
// own RECITERS map, which only ever carries the Arabic name.
export const RECITER_DISPLAY_NAMES: Record<string, string> = {
  mishary_alafasy: "Mishary Al-Afasy",
  maher_muaiqly: "Maher Al-Muaiqly",
  ahmed_ajmi: "Ahmed Al-Ajmi",
  yasser_dosari: "Yasser Al-Dosari",
  abdullah_mousa: "Abdullah Al-Mousa",
  raad_alkurdi: "Raad Al-Kurdi",
};

// Same six reciters' Arabic names, exactly as render/route.ts's own
// RECITERS map (server-only, can't be imported into a client component
// like GalleryGrid.tsx -- it pulls in fs/child_process at module scope).
// Used both to look up a Latin name for a gallery entry saved BEFORE
// reciterNameLatin existed (see latinNameForArabicReciterName below) and,
// exported, by VideoCreatorForm's suggestedTitle for the Arabic-language
// version of the credit line.
export const RECITER_ARABIC_NAMES: Record<string, string> = {
  mishary_alafasy: "مشاري راشد العفاسي",
  maher_muaiqly: "ماهر المعيقلي",
  ahmed_ajmi: "أحمد العجمي",
  yasser_dosari: "ياسر الدوسري",
  abdullah_mousa: "عبدالله الموسى",
  raad_alkurdi: "رعد محمد الكردي",
};

// Recovers a Latin reciter name from an OLD gallery entry that only ever
// stored the Arabic one (reciterNameLatin didn't exist yet) -- so those
// videos show correctly in Turkish too, without needing to touch their
// already-saved JSON.
export function latinNameForArabicReciterName(arabicName: string): string | undefined {
  const reciterId = Object.keys(RECITER_ARABIC_NAMES).find((id) => RECITER_ARABIC_NAMES[id] === arabicName);
  return reciterId ? RECITER_DISPLAY_NAMES[reciterId] : undefined;
}
