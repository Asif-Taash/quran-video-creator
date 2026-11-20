// The translation each part of a split ayah shows.
//
// Each part of a split ayah holds its own piece of the translation. When
// another translation is picked, the parts stay as they are and the new
// text is cut to fit them (api/segmentation/split-translation). Before,
// only the first part took the new translation -- the whole of it -- and
// the other parts kept the old one's pieces (the user, 2026-11-16).
//
// The pieces each translation had are kept on the parts
// (`translation_pieces`, by translation id), so they survive autosave and
// reopening, and picking a translation again brings its pieces back as they
// were -- also where the user moved words between parts -- instead of
// cutting it anew. "No translation" ("none") hides every part's piece.
// Kept pieces are used only while they still make up exactly that
// translation's text; a part added or merged since drops them.
//
// A repeat (repeat_of_part: the reciter went back) shows the same piece as
// the part it repeats.
//
// Entries are segmentation entries ({ surah, ayah, mappings }). Every
// function returns the same object when nothing changes.

type Mapping = Record<string, any>;
type Entry = { mappings: Mapping[]; [key: string]: any };

const isRepeat = (m: Mapping) => typeof m.repeat_of_part === "number";
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The ayah's own parts (hidden ones too), without the reciter's repeats. */
export function ownParts(entry: Entry): Mapping[] {
  return entry.mappings.filter((m) => !isRepeat(m));
}

// The pieces kept for `translationId`, one per own part. Projects saved
// before 2026-11-16 kept them only for "none", as hidden_translation_*.
function keptPieces(entry: Entry, translationId: string): string[] | null {
  const own = ownParts(entry);
  if (own.length === 0) return null;
  const pieces = own.map((m) => {
    const kept = m.translation_pieces?.[translationId];
    if (typeof kept === "string") return kept;
    if (m.hidden_translation_id === translationId && typeof m.hidden_translation_text === "string") return m.hidden_translation_text;
    return null;
  });
  return pieces.every((p): p is string => p !== null) ? pieces : null;
}

/**
 * Each own part shows its piece, in order; each repeat its source part's.
 * A box width the user set for one text doesn't fit another -- kept, a box
 * narrowed around a short translation squeezed a longer one into a word or
 * two per line -- so it goes when a shown text is replaced by another.
 */
export function withPieces<E extends Entry>(entry: E, pieces: string[]): E {
  const byPart = new Map<number, string>();
  let k = 0;
  const show = (m: Mapping, text: string): Mapping => {
    const old = m.translation_text ?? "";
    if (old === text) return m;
    if (old && text) {
      const { translationWidthScale: _oldTextWidth, ...rest } = m;
      return { ...rest, translation_text: text };
    }
    return { ...m, translation_text: text };
  };
  const own = entry.mappings.map((m) => {
    if (isRepeat(m)) return m;
    const text = pieces[k++] ?? "";
    byPart.set(m.part, text);
    return show(m, text);
  });
  const mappings = own.map((m) => (isRepeat(m) && byPart.has(m.repeat_of_part) ? show(m, byPart.get(m.repeat_of_part)!) : m));
  return mappings.every((m, i) => m === entry.mappings[i]) ? entry : { ...entry, mappings };
}

/** Keeps the parts' current pieces as `translationId`'s (an ayah of one part needs none). */
export function keepPieces<E extends Entry>(entry: E, translationId: string | null): E {
  if (!translationId || translationId === "none") return entry;
  const own = ownParts(entry);
  if (own.length < 2 || own.every((m) => m.translation_pieces?.[translationId] === (m.translation_text ?? ""))) return entry;
  return {
    ...entry,
    mappings: entry.mappings.map((m) =>
      isRepeat(m) ? m : { ...m, translation_pieces: { ...m.translation_pieces, [translationId]: m.translation_text ?? "" } }
    ),
  };
}

/** The pieces kept for this translation back in place, or null when there are none that still fit `fullText`. */
export function restorePieces<E extends Entry>(entry: E, translationId: string, fullText: string): E | null {
  const pieces = keptPieces(entry, translationId);
  if (!pieces || squash(pieces.filter(Boolean).join(" ")) !== squash(fullText)) return null;
  return withPieces(entry, pieces);
}
