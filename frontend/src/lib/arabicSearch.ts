// Arabic-aware substring search used by the Quran search box: a query only
// counts as a match when it lines up with the *start* of an actual word
// (so "احم" matches "احمل" but not the "احم" that happens to fall mid-word
// inside "الراحمين"), and hamza handling is asymmetric on purpose:
//   - a plain alef (ا/ٱ) in the query is lenient and matches any alef form
//     in the text (أ, إ, آ, or plain) -- typing without hamza should still
//     find hamza'd spellings like "أحمد".
//   - an explicit أ or إ in the query is strict and only matches that exact
//     hamza -- typing إ on purpose should not surface أ spellings or vice versa.
// ة/ه (see baseChar below) are always interchangeable in both directions --
// "رحمه" finds "رحمة" and "رحمة" finds "رحمه" -- same for ى/ي.
//
// DIACRITICS_RE is built from explicit NUMERIC codepoints (see
// codePointRange below) rather than a hand-typed regex literal -- the
// combining marks involved are visually near-identical zero-width
// characters, and a regex literal has no way to check itself. This exact
// bug already happened once: an earlier revision had two ranges'
// endpoints transposed by eye, silently widening one range to
// 0x061a-0x0670 -- a span that swallows the ENTIRE ordinary Arabic letter
// block (0x0621-0x064a) along with the real diacritics, which stripped
// ordinary letters as if they were diacritics and broke nearly every
// multi-letter search. A plain number like 0x061a can't be transposed
// into looking like a different character, so the ranges actually in
// effect are checkable here against a Unicode chart with no
// character-transcription step in between:
//   0x0617-0x061a -- small Quranic annotation marks (small high marks etc.)
//   0x064b-0x065f -- the actual tashkeel block: tanween, fatha/damma/kasra,
//                    shadda, sukun, and a few rarer marks
//   0x0670-0x0670 -- superscript alef (dagger alef)
//   0x06d6-0x06ed -- Quranic pause/stop marks (waqf signs, e.g. the small
//                    seen/qaf/lam-alef marks). These appear as their OWN
//                    space-separated token in the Uthmani text (a space,
//                    then the mark, then another space), not attached to a
//                    letter like the other diacritics. Stripping one
//                    without also collapsing the space on each side of it
//                    (see stripDiacriticsCollapsingSpaces below) would
//                    leave a stray double space right where it used to be,
//                    breaking any multi-word query spanning across one --
//                    e.g. verse 3:8, whose Uthmani text has a waqf mark
//                    (surrounded by spaces) right between two words.
function codePointRange(startInclusive: number, endInclusive: number): string {
  const u = (cp: number) => "\\u" + cp.toString(16).padStart(4, "0");
  return u(startInclusive) + "-" + u(endInclusive);
}
const DIACRITICS_RE = new RegExp(
  "[" +
    codePointRange(0x0617, 0x061a) +
    codePointRange(0x064b, 0x065f) +
    codePointRange(0x0670, 0x0670) +
    codePointRange(0x06d6, 0x06ed) +
    "]"
);

type AlefClass = "PLAIN" | "HAMZA_ABOVE" | "HAMZA_BELOW" | null;

function classifyAlef(ch: string): AlefClass {
  if (ch === "ا" || ch === "ٱ") return "PLAIN";
  if (ch === "أ" || ch === "آ") return "HAMZA_ABOVE";
  if (ch === "إ") return "HAMZA_BELOW";
  return null;
}

// Codepoints (not literal characters) for the same reason DIACRITICS_RE is
// built from numbers -- ة/ه and ى/ي are each a pair of visually-similar
// letters very easy to transpose by eye when hand-typing a comparison.
const ALEF_MAKSURA = 0x0649; // ى
const YEH = 0x064a; // ي
const TEH_MARBUTA = 0x0629; // ة
const HEH = 0x0647; // ه

// ة/ه are treated as interchangeable (typed "رحمه" should find "رحمة" and
// vice versa) -- extremely common to conflate since they're pronounced (and
// often typed) the same way, and ة is really just "ه with two dots" at the
// end of a word. Same idea as the existing ى/ي leniency just below it.
function baseChar(ch: string): string {
  const cp = ch.codePointAt(0);
  if (cp === ALEF_MAKSURA) return String.fromCodePoint(YEH);
  if (cp === TEH_MARBUTA || cp === HEH) return String.fromCodePoint(HEH);
  return ch;
}

function charsMatch(queryCh: string, textCh: string): boolean {
  const qAlef = classifyAlef(queryCh);
  const tAlef = classifyAlef(textCh);
  if (qAlef || tAlef) {
    if (qAlef === tAlef) return true;
    return qAlef === "PLAIN" && (tAlef === "HAMZA_ABOVE" || tAlef === "HAMZA_BELOW");
  }
  return baseChar(queryCh) === baseChar(textCh);
}

// Drops every diacritic (including standalone pause marks) from `chars`,
// and collapses any run of spaces left behind into a single one -- applied
// to both the text and the query so the two sides always line up
// character-for-character regardless of which one happened to have a
// pause mark (or accidental double space) in it.
function stripDiacriticsCollapsingSpaces(
  chars: { ch: string; origIdx: number }[]
): { ch: string; origIdx: number }[] {
  const out: { ch: string; origIdx: number }[] = [];
  for (const entry of chars) {
    if (DIACRITICS_RE.test(entry.ch)) continue;
    if (entry.ch === " " && out.length > 0 && out[out.length - 1].ch === " ") continue;
    out.push(entry);
  }
  return out;
}

export interface ArabicMatchRange {
  /** Index into Array.from(text) where the match starts (inclusive). */
  start: number;
  /** Index into Array.from(text) where the match ends (exclusive). */
  end: number;
}

/**
 * Finds every word-start position in `text` where `query` matches, ignoring
 * diacritics (including standalone pause marks and the double spaces they'd
 * otherwise leave behind) and applying the hamza leniency rules above.
 * Ranges are expressed as indices over `Array.from(text)` (i.e. the
 * original text, diacritics included) so callers can map straight back to
 * it for highlighting without a separate index-mapping pass.
 */
export function findWordStartMatches(text: string, query: string): ArabicMatchRange[] {
  const significant = stripDiacriticsCollapsingSpaces(
    Array.from(text).map((ch, origIdx) => ({ ch, origIdx }))
  );
  const queryChars = stripDiacriticsCollapsingSpaces(
    Array.from(query).map((ch, origIdx) => ({ ch, origIdx }))
  ).map((e) => e.ch);
  if (queryChars.length === 0) return [];

  const isWordBoundary = (i: number) => i === 0 || significant[i - 1].ch === " ";

  const matches: ArabicMatchRange[] = [];
  for (let i = 0; i < significant.length; i++) {
    if (!isWordBoundary(i)) continue;
    if (i + queryChars.length > significant.length) continue;

    let matched = true;
    for (let j = 0; j < queryChars.length; j++) {
      if (!charsMatch(queryChars[j], significant[i + j].ch)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push({ start: significant[i].origIdx, end: significant[i + queryChars.length - 1].origIdx + 1 });
    }
  }
  return matches;
}

export function hasWordStartMatch(text: string, query: string): boolean {
  return findWordStartMatches(text, query).length > 0;
}
