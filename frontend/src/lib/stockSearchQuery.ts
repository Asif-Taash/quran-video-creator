// Server-only: turns what a user types in the background picker into a
// query the stock providers understand. Pixabay/Pexels can search in
// Turkish (and English) but not Arabic, so Arabic words are translated --
// first through the small scenery dictionary below (instant, covers what
// people actually search for here), then, for anything it doesn't know,
// one short call to the backend's AI chat endpoint.

export type SearchLanguage = "en" | "tr";

const ARABIC_RE = /[؀-ۿ]/;

// Keys are normalized (see normalizeArabicWord): no diacritics, plain alef,
// no leading "ال"/"و".
const ARABIC_SCENERY: Record<string, string> = {
  سماء: "sky", نجوم: "stars", نجم: "star", قمر: "moon", هلال: "crescent moon", ليل: "night", ليلي: "night",
  ليليه: "night", ليله: "night", غيوم: "clouds", غيمه: "cloud", سحاب: "clouds", سحب: "clouds", بحر: "sea",
  بحار: "sea", محيط: "ocean", امواج: "waves", موج: "waves", شاطي: "beach", شاطئ: "beach", مطر: "rain",
  امطار: "rain", صحراء: "desert", صحرا: "desert", رمال: "sand", رمل: "sand", كثبان: "dunes", جبال: "mountains",
  جبل: "mountain", غابه: "forest", غابات: "forest", اشجار: "trees", شجره: "tree", شجر: "trees", مسجد: "mosque",
  مساجد: "mosque", جامع: "mosque", كعبه: "kaaba", مكه: "mecca", مدينه: "city", قبه: "dome", مئذنه: "minaret",
  ماذن: "minarets", غروب: "sunset", شروق: "sunrise", شمس: "sun", فجر: "dawn", ضباب: "fog", شلال: "waterfall",
  شلالات: "waterfall", نهر: "river", انهار: "rivers", بحيره: "lake", ثلج: "snow", ثلوج: "snow", شتاء: "winter",
  ربيع: "spring", خريف: "autumn", صيف: "summer", زهور: "flowers", زهره: "flower", ورود: "roses", ورده: "rose",
  طبيعه: "nature", مجره: "galaxy", فضاء: "space", برق: "lightning", عاصفه: "storm", رعد: "thunder",
  ماء: "water", مياه: "water", نخيل: "palm trees", نخله: "palm tree", حقل: "field", عشب: "grass",
  وادي: "valley", كهف: "cave", طيور: "birds", طائر: "bird", سفينه: "ship", فانوس: "lantern", رمضان: "ramadan",
  اسلامي: "islamic", اسلاميه: "islamic", هادي: "calm", هادئ: "calm", هادئه: "calm", جميل: "beautiful",
  جميله: "beautiful", ازرق: "blue", زرقاء: "blue", اخضر: "green", خضراء: "green", ذهبي: "golden",
  ذهبيه: "golden", اسود: "black", ابيض: "white", ظلام: "dark", مظلم: "dark", مظلمه: "dark", نور: "light",
  ضوء: "light", اضواء: "lights", شفق: "aurora", قطرات: "drops", مطريه: "rain", جليد: "ice",
  // Things the library never shows (see lib/stockBackgrounds.ts' blocklist)
  // -- mapped only so the picker can say "natural scenery only" right away
  // instead of an empty result or a slow AI translation.
  سياره: "car", سيارات: "cars", طائره: "plane", طائرات: "planes", طياره: "plane", قارب: "boat", قوارب: "boats",
  مبني: "building", مباني: "buildings", بيت: "house", منزل: "house", بيوت: "houses", ناس: "people",
  انسان: "person", رجل: "man", امراه: "woman", طفل: "child", اطفال: "children", حيوان: "animal",
  حيوانات: "animals", قطه: "cat", كلب: "dog", حصان: "horse", جمل: "camel", سمك: "fish", شارع: "street",
  طريق: "road", برج: "tower", جسر: "bridge", قصر: "palace", قطار: "train", دراجه: "bicycle", حافله: "bus",
  شاحنه: "truck",
};

function normalizeArabicWord(word: string): string {
  return word
    .replace(/[ً-ٰٟـ]/g, "") // diacritics, tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

function lookupArabicWord(word: string): string | undefined {
  const w = normalizeArabicWord(word);
  const candidates = [w, w.replace(/^ال/, ""), w.replace(/^و/, ""), w.replace(/^وال/, ""), w.replace(/^بال/, "")];
  for (const c of candidates) {
    const hit = ARABIC_SCENERY[c] ?? ARABIC_SCENERY[c.replace(/ه$/, "ة")];
    if (hit) return hit;
  }
  return undefined;
}

const aiTranslationCache = new Map<string, string>();

async function translateWithAI(text: string): Promise<string | null> {
  const cached = aiTranslationCache.get(text);
  if (cached !== undefined) return cached;
  const baseUrl = process.env.INTERNAL_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://backend:8000";
  try {
    const res = await fetch(`${baseUrl}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_prompt:
          "You translate short image/video search queries into English. Reply with ONLY the English search keywords (1-4 words), lowercase, no punctuation, no explanation.",
        user_message: text,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = String(data.result || "")
      .toLowerCase()
      .replace(/[^a-z\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 4)
      .join(" ");
    if (!result) return null;
    aiTranslationCache.set(text, result);
    return result;
  } catch {
    return null;
  }
}

// The query and language to send to the providers. `uiLanguage` decides
// how a non-Arabic query is read (a Turkish user typing "deniz" means sea).
export async function resolveSearchQuery(
  query: string,
  uiLanguage: string
): Promise<{ query: string; language: SearchLanguage }> {
  const trimmed = query.trim();
  if (!ARABIC_RE.test(trimmed)) {
    return { query: trimmed, language: uiLanguage === "tr" ? "tr" : "en" };
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  const translated = words.map((w) => (ARABIC_RE.test(w) ? lookupArabicWord(w) : w));
  if (translated.every((t) => t !== undefined)) {
    return { query: [...new Set(translated as string[])].join(" "), language: "en" };
  }
  const ai = await translateWithAI(trimmed);
  if (ai) return { query: ai, language: "en" };
  // Whatever the dictionary did recognize is still better than nothing.
  const known = translated.filter((t): t is string => t !== undefined);
  return { query: known.length > 0 ? [...new Set(known)].join(" ") : trimmed, language: "en" };
}
