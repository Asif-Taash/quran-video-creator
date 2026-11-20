// The reciters starred (★) in the reciter list, most recently starred
// first. Kept per browser (localStorage); empty when storage is blocked.
// The list (wizard/ReciterPicker.tsx) shows them on top, and a new project
// starts with the first one that recorded its surah (VideoCreatorForm).

const FAVORITES_KEY = "kurannuru:favReciters";

export function readFavoriteReciters(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function writeFavoriteReciters(ids: string[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
  } catch {
    // Private window or blocked storage: favourites last for this visit only.
  }
}
