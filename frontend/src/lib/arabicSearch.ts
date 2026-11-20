// Arabic-aware search used by the Quran search box (the server route that
// finds the ayahs, and the dropdown that highlights the match in each one).
//
// The text searched is the Uthmani script (quran-uthmani.json), but people
// type in ordinary modern spelling. The two differ in hundreds of common
// words, and a plain letter-by-letter comparison found none of them --
// "إبراهيم", "الصلاة", "الكتاب", "القرآن", "الذين آمنوا", "يا أيها" all
// returned nothing, because the Uthmani text writes them إِبْرَٰهِيمَ,
// ٱلصَّلَوٰةَ, ٱلْكِتَٰبُ, ٱلْقُرْءَانُ, ءَامَنُوا۟, يَٰٓأَيُّهَا. So the text is first
// turned into tokens, and each token lists every way it may be typed:
//   - superscript (dagger) alef ٰ: an alef that may be typed or left out
//     (ٱلرَّحْمَٰن = "الرحمن" or "الرحمان", إِبْرَٰهِيم = "إبراهيم" or "ابرهيم").
//     After ى it may replace the ى (ٱلتَّوْرَىٰة = "التوراة"); after a waw
//     inside a word, before ة/ا (or صلوٰت), it may replace the waw (ٱلصَّلَوٰة =
//     "الصلاة", ٱلرِّبَوٰا۟ = "الربا", صَلَوٰتَكَ = "صلاتك"). Otherwise it follows the waw
//     (ٱلسَّمَٰوَٰت = "السماوات"; "أما" must not find أَمْوَٰتًا).
//     In the vocative / "ها" (يَٰٓأَيُّهَا, يَٰقَوْمِ, هَٰٓأَنتُمْ) the typed text
//     may have a space after it ("يا أيها"), and the word after it counts
//     as a word start ("قوم" finds يَٰقَوْمِ, "موسى" finds يَٰمُوسَىٰٓ).
//   - small waw / small yeh / small noon (لَهُۥ, إِبْرَٰهِۦمَ, ٱلنَّبِيِّۦنَ, نُۨجِى):
//     a letter that may be typed or left out.
//   - a letter marked silent (small high zero: أُو۟لَٰٓئِكَ, لِشَا۟ىْءٍ, ءَامَنُوا۟):
//     may be typed or left out.
//   - hamza: the Uthmani seat often differs from the modern one (يَسْـَٔلُونَكَ,
//     ٱلْمَلَؤُا۟ = "الملأ", جَزَٰٓؤُا۟ = "جزاء", تِلْقَآئِ = "تلقاء"). A text ء, ؤ or ئ
//     matches any typed hamza form or a plain alef typed without hamza; a
//     typed ء matches any hamza in the text. A seatless hamza followed by an
//     alef may be typed آ (ءَامَنُوا۟ = "آمنوا"), or أى at the end of a word
//     (رَءَا = "رأى"). A typed ء matches any hamza in the text; a typed ؤ
//     or ئ also matches إ (وَمَلَإِي۟هِۦ = "وملئه") but not أ ("امرئ" must not
//     find ٱمْرَأَتُ).
//   - word endings: final ا may be typed ى (ٱلْأَقْصَا = "الأقصى", طَغَا = "طغى")
//     -- not a tanween alef (بَيَٰتًا) nor the endings نا/ها/يا (جَآءَنَا, أَحْيَا);
//     final و may be typed وا (جَآءُو = "جاءوا", عَتَوْ = "عتوا"); final ىِ may
//     be typed يي (يُحْىِ = "يحيي").
//   - the imperative of سأل after و/ف drops its alef (فَسْـَٔلُوٓا۟ = "فاسألوا").
//   - lam with shadda right after alef wasla (ٱلَّيْلِ): one or two lams
//     ("الليل"; ٱلَّذِى is still "الذي").
//   - word-final open taa (رَحْمَتَ ٱللَّهِ): may be typed ة -- but not ه, or
//     "قاله" would find every قَالَتْ, and not after an alef (ءَايَٰتٍ is a
//     plural, "آية" must not find it).
//   - seen written over sad (يَبْصُۜطُ): ص or س.
// Everything else that is not a letter (tashkeel, waqf marks, tatweel) is
// ignored, and the spaces left around a standalone waqf mark collapse
// into one.
//
// Unchanged from before:
//   - a query only matches at the *start* of a word (so "احم" matches
//     "احمل" but not the "احم" that falls mid-word inside "الراحمين");
//   - a plain alef (ا/ٱ) in the query matches any alef form (أ, إ, آ, or
//     plain), but an explicit أ or إ in the query only matches that hamza;
//   - ة/ه and ى/ي are interchangeable both ways.
//
// Code points are written as NUMBERS, not literal characters: the marks
// involved are visually near-identical zero-width characters (and ة/ه, ى/ي
// are easy to transpose by eye). An earlier revision had two range
// endpoints transposed into 0x061a-0x0670, which swallowed the whole Arabic
// letter block and broke nearly every search; a number can be checked
// against a Unicode chart directly.

function codePointRange(startInclusive: number, endInclusive: number): string {
  const u = (cp: number) => "\\u" + cp.toString(16).padStart(4, "0");
  return u(startInclusive) + "-" + u(endInclusive);
}
// Marks that never change what is typed. Some code points inside these
// ranges DO matter (shadda, the hamza marks, the small letters, the silent
// markers); tokenize() checks those before falling back to this.
//   0x0617-0x061a -- small Quranic annotation marks
//   0x064b-0x065f -- tashkeel: tanween, fatha/damma/kasra, shadda, sukun, madda...
//   0x0670-0x0670 -- superscript (dagger) alef (ignored in the query only)
//   0x06d6-0x06ed -- Quranic marks: waqf signs (their own space-separated
//                    token in the text), rub el hizb, sajda, small letters
const MARKS_RE = new RegExp(
  "[" +
    codePointRange(0x0617, 0x061a) +
    codePointRange(0x064b, 0x065f) +
    codePointRange(0x0670, 0x0670) +
    codePointRange(0x06d6, 0x06ed) +
    "]"
);

const ch = (cp: number) => String.fromCodePoint(cp);
const HAMZA = ch(0x0621); // ء
const ALEF_MADDA = ch(0x0622); // آ
const ALEF_HAMZA_ABOVE = ch(0x0623); // أ
const WAW_HAMZA = ch(0x0624); // ؤ
const ALEF_HAMZA_BELOW = ch(0x0625); // إ
const YEH_HAMZA = ch(0x0626); // ئ
const ALEF = ch(0x0627); // ا
const TEH_MARBUTA = ch(0x0629); // ة
const TEH = ch(0x062a); // ت
const SEEN = ch(0x0633); // س
const SAD = ch(0x0635); // ص
const FEH = ch(0x0641); // ف
const LAM = ch(0x0644); // ل
const NOON = ch(0x0646); // ن
const HEH = ch(0x0647); // ه
const WAW = ch(0x0648); // و
const ALEF_MAKSURA = ch(0x0649); // ى
const YEH = ch(0x064a); // ي
const ALEF_WASLA = ch(0x0671); // ٱ
// Private-use stand-in for a word-final open taa typed as ة (see above).
const OPEN_TEH = ch(0xe000);

const TATWEEL = 0x0640;
const FATHATAN = 0x064b;
const KASRA = 0x0650;
const SHADDA = 0x0651;
const SUKUN = 0x0652;
const HAMZA_ABOVE_MARK = 0x0654;
const HAMZA_BELOW_MARK = 0x0655;
const DAGGER_ALEF = 0x0670;
const SMALL_HIGH_SEEN = 0x06dc;
const SMALL_HIGH_ROUNDED_ZERO = 0x06df; // letter written, never read
const SMALL_HIGH_UPRIGHT_RECT_ZERO = 0x06e0; // letter read only in pause
const SMALL_LOW_SEEN = 0x06e3;
const SMALL_LETTERS: Record<number, string> = {
  0x06e5: WAW, // small waw
  0x06e6: YEH, // small yeh
  0x06e7: YEH, // small high yeh
  0x06e8: NOON, // small high noon
};

type AlefClass = "PLAIN" | "HAMZA_ABOVE" | "HAMZA_BELOW" | null;

function classifyAlef(c: string): AlefClass {
  if (c === ALEF || c === ALEF_WASLA) return "PLAIN";
  if (c === ALEF_HAMZA_ABOVE || c === ALEF_MADDA) return "HAMZA_ABOVE";
  if (c === ALEF_HAMZA_BELOW) return "HAMZA_BELOW";
  return null;
}

const HAMZA_FORMS = new Set([HAMZA, ALEF_HAMZA_ABOVE, ALEF_HAMZA_BELOW, ALEF_MADDA, WAW_HAMZA, YEH_HAMZA]);
// Text hamzas whose seat the modern spelling often changes.
const LOOSE_SEAT_HAMZAS = new Set([HAMZA, WAW_HAMZA, YEH_HAMZA]);

function baseChar(c: string): string {
  if (c === ALEF_MAKSURA) return YEH;
  if (c === TEH_MARBUTA) return HEH;
  return c;
}

/** Does the typed character `q` match the text character `t`? */
function charsMatch(q: string, t: string): boolean {
  if (t === OPEN_TEH) return q === TEH_MARBUTA;
  // The typed spelling picks another seat (يسألونك, شيئا, الملأ, رؤوف) or
  // leaves the hamza out (يسالونك); a typed ء stands for any hamza.
  if (LOOSE_SEAT_HAMZAS.has(t)) return HAMZA_FORMS.has(q) || classifyAlef(q) === "PLAIN";
  if (q === HAMZA) return HAMZA_FORMS.has(t);
  if (q === WAW_HAMZA || q === YEH_HAMZA) return t === ALEF_HAMZA_BELOW;
  const qAlef = classifyAlef(q);
  const tAlef = classifyAlef(t);
  if (qAlef || tAlef) {
    if (qAlef === tAlef) return true;
    return qAlef === "PLAIN" && (tAlef === "HAMZA_ABOVE" || tAlef === "HAMZA_BELOW");
  }
  return baseChar(q) === baseChar(t);
}

interface Token {
  /** Every spelling this piece of text may be typed as; "" = may be left out. */
  alts: string[];
  /** Index into Array.from(text) of its first character. */
  start: number;
  /** Exclusive end, including the letter's own marks. */
  end: number;
  space?: boolean;
  /** Vocative / "ها" alef: a typed space may follow it ("يا أيها"), and the
   *  next letter counts as a word start. */
  joinsNext?: boolean;
  /** Dagger alef written after a waw (decided once the next letter is known). */
  afterWaw?: boolean;
  kasra?: boolean;
  sukun?: boolean;
  fathatan?: boolean;
}

function tokenize(text: string): Token[] {
  const chars = Array.from(text);
  const out: Token[] = [];
  const last = (): Token | undefined => {
    const t = out[out.length - 1];
    return t && !t.space ? t : undefined;
  };
  const isOnly = (t: Token | undefined, c: string) => !!t && t.alts.length === 1 && t.alts[0] === c;
  const wordStartAt = (k: number) => k === 0 || !!out[k - 1].space;

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const cp = c.codePointAt(0)!;
    if (/\s/.test(c)) {
      if (out.length > 0 && !out[out.length - 1].space) out.push({ alts: [" "], start: i, end: i + 1, space: true });
      continue;
    }
    if (cp === TATWEEL) continue;
    if (cp === HAMZA_ABOVE_MARK || cp === HAMZA_BELOW_MARK) {
      out.push({ alts: [HAMZA], start: i, end: i + 1 });
      continue;
    }
    if (cp === DAGGER_ALEF) {
      const prev = last();
      if (isOnly(prev, ALEF_MAKSURA)) {
        prev!.alts = [ALEF_MAKSURA, ALEF];
      } else if (isOnly(prev, HAMZA)) {
        prev!.alts = [HAMZA + ALEF, ALEF_MADDA, ALEF, HAMZA];
      } else {
        const k = out.length - 1;
        const vocative =
          (isOnly(prev, YEH) || isOnly(prev, HEH)) &&
          (wordStartAt(k) || (k >= 1 && (isOnly(out[k - 1], WAW) || isOnly(out[k - 1], FEH)) && wordStartAt(k - 1)));
        out.push({
          alts: ["", ALEF],
          start: i,
          end: i + 1,
          joinsNext: vocative || undefined,
          afterWaw: (isOnly(prev, WAW) && !wordStartAt(k)) || undefined,
        });
      }
      continue;
    }
    if (cp === SMALL_HIGH_ROUNDED_ZERO || cp === SMALL_HIGH_UPRIGHT_RECT_ZERO) {
      const prev = last();
      if (prev && !prev.alts.includes("")) prev.alts = [...prev.alts, ""];
      continue;
    }
    if (cp === SMALL_HIGH_SEEN || cp === SMALL_LOW_SEEN) {
      const prev = last();
      if (isOnly(prev, SAD)) prev!.alts = [SAD, SEEN];
      continue;
    }
    if (SMALL_LETTERS[cp]) {
      if (last()) out.push({ alts: ["", SMALL_LETTERS[cp]], start: i, end: i + 1 });
      continue;
    }
    if (cp === KASRA || cp === SUKUN || cp === FATHATAN) {
      const prev = last();
      if (prev) prev[cp === KASRA ? "kasra" : cp === SUKUN ? "sukun" : "fathatan"] = true;
      continue;
    }
    if (cp === SHADDA) {
      const prev = last();
      if (isOnly(prev, LAM) && isOnly(out[out.length - 2], ALEF_WASLA)) prev!.alts = [LAM, LAM + LAM];
      continue;
    }
    if (MARKS_RE.test(c)) continue;
    if (c === ALEF && isOnly(last(), HAMZA)) {
      last()!.alts = [HAMZA + ALEF, ALEF_MADDA, ALEF];
      continue;
    }
    out.push({ alts: [c], start: i, end: i + 1 });
  }
  while (out.length > 0 && out[out.length - 1].space) out.pop();

  for (let k = 0; k < out.length; k++) {
    const t = out[k];
    // Stretch each token over the marks that follow it, so a highlight
    // never cuts a letter off from its own tashkeel.
    if (!t.space) t.end = k + 1 < out.length ? out[k + 1].start : chars.length;
    const next = out[k + 1];
    const prev = out[k - 1];
    const wordEnd = !next || !!next.space;
    if (isOnly(t, TEH) && wordEnd && !(prev && prev.alts.includes(ALEF))) t.alts = [TEH, OPEN_TEH];
    if (wordEnd && t.alts[0] === HAMZA + ALEF) t.alts = [...t.alts, HAMZA + ALEF_MAKSURA];
    const notFirst = !!prev && !prev.space;
    if (wordEnd && notFirst && isOnly(t, ALEF) && !prev.fathatan && ![NOON, HEH, YEH].some((c) => isOnly(prev, c))) {
      t.alts = [ALEF, ALEF_MAKSURA];
    }
    if (wordEnd && notFirst && isOnly(t, WAW)) t.alts = [WAW, WAW + ALEF];
    if (wordEnd && notFirst && t.kasra && isOnly(t, ALEF_MAKSURA)) t.alts = [ALEF_MAKSURA, ALEF_MAKSURA + YEH];
    const salawat = isOnly(next, TEH) && isOnly(out[k - 2], LAM);
    if (t.afterWaw && next && !next.space && ([TEH_MARBUTA, ALEF].some((c) => next.alts.includes(c)) || salawat)) {
      out[k - 1].alts = [WAW, ALEF];
    }
    const n2 = out[k + 2];
    if ((isOnly(t, WAW) || isOnly(t, FEH)) && (!prev || prev.space) && next && isOnly(next, SEEN) && next.sukun
        && n2 && n2.alts[0].startsWith(HAMZA)) {
      t.alts = [t.alts[0], t.alts[0] + ALEF];
    }
  }
  return out;
}

/** The query in plain letters: no tashkeel/marks/tatweel, single spaces. */
function normalizeQuery(query: string): string[] {
  const out: string[] = [];
  for (const c of Array.from(query.normalize("NFC"))) {
    const cp = c.codePointAt(0)!;
    if (/\s/.test(c)) {
      if (out.length > 0 && out[out.length - 1] !== " ") out.push(" ");
      continue;
    }
    if (cp === TATWEEL) continue;
    if (cp === HAMZA_ABOVE_MARK || cp === HAMZA_BELOW_MARK) {
      out.push(HAMZA);
      continue;
    }
    if (MARKS_RE.test(c)) continue;
    out.push(c);
  }
  if (out[out.length - 1] === " ") out.pop();
  return out;
}

/**
 * Tries to match q[qi..] starting at tokens[ti]. Returns the exclusive end
 * (index into Array.from(text)) of the last token that consumed a typed
 * character, or -1.
 */
function matchFrom(tokens: Token[], ti: number, q: string[], qi: number, lastEnd: number): number {
  if (qi >= q.length) return lastEnd;
  if (ti >= tokens.length) return -1;
  const t = tokens[ti];
  if (t.space) return q[qi] === " " ? matchFrom(tokens, ti + 1, q, qi + 1, lastEnd) : -1;
  for (const alt of t.alts) {
    if (alt === "") {
      const r = matchFrom(tokens, ti + 1, q, qi, lastEnd);
      if (r >= 0) return r;
      continue;
    }
    const a = Array.from(alt);
    let k = 0;
    while (k < a.length && qi + k < q.length && charsMatch(q[qi + k], a[k])) k++;
    if (k > 0 && qi + k === q.length) return t.end; // the query ends here
    if (k < a.length) continue;
    let r = matchFrom(tokens, ti + 1, q, qi + k, t.end);
    if (r >= 0) return r;
    if (t.joinsNext && q[qi + k] === " ") {
      r = matchFrom(tokens, ti + 1, q, qi + k + 1, t.end);
      if (r >= 0) return r;
    }
  }
  return -1;
}

export interface ArabicMatchRange {
  /** Index into Array.from(text) where the match starts (inclusive). */
  start: number;
  /** Index into Array.from(text) where the match ends (exclusive). */
  end: number;
}

/**
 * Finds every word-start position in `text` where `query` matches, using
 * the spelling rules above. Ranges are indices over `Array.from(text)` (the
 * original text, marks included), so callers can highlight straight from
 * them. Matches never overlap.
 */
export function findWordStartMatches(text: string, query: string): ArabicMatchRange[] {
  const q = normalizeQuery(query);
  if (q.length === 0) return [];
  const tokens = tokenize(text);
  const matches: ArabicMatchRange[] = [];
  let after = 0;
  for (let ti = 0; ti < tokens.length; ti++) {
    const t = tokens[ti];
    if (t.space || t.start < after) continue;
    if (ti > 0 && !tokens[ti - 1].space && !tokens[ti - 1].joinsNext) continue;
    const end = matchFrom(tokens, ti, q, 0, -1);
    if (end >= 0) {
      matches.push({ start: t.start, end });
      after = end;
    }
  }
  return matches;
}

export function hasWordStartMatch(text: string, query: string): boolean {
  return findWordStartMatches(text, query).length > 0;
}
