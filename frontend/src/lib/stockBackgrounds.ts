// Server-only: the stock background library behind Step2Background.tsx's
// picker -- real photos and looping videos from Pexels (primary) and
// Pixabay (secondary), instead of the old AI-generated images. Both need a
// free API key read at request time (PEXELS_API_KEY / PIXABAY_API_KEY, e.g.
// in frontend/.env.local -- Next's dev server reloads that file without a
// restart); a provider without a key is simply skipped.
//
// Both providers' terms are respected here: results are cached (Pixabay asks
// for 24h), files are downloaded to our own server instead of hot-linked,
// and the picker credits the provider and author.

export type StockProvider = "pexels" | "pixabay";
export type StockMediaType = "photo" | "video";
export type StockOrientation = "portrait" | "landscape" | "square";
// Language the query is written in (see stockSearchQuery.ts).
export type StockSearchLanguage = "en" | "tr";

export type StockItem = {
  key: string; // `${provider}-${type}-${id}`, unique across providers
  provider: StockProvider;
  type: StockMediaType;
  id: string;
  thumbUrl: string;
  // Small muted mp4 the picker plays on hover (videos only).
  previewVideoUrl?: string;
  width: number;
  height: number;
  durationSec?: number;
  // Made to repeat without a visible jump (its author tagged it as a
  // loop) -- shown first among the videos, and badged in the picker.
  seamlessLoop?: boolean;
  author: string;
  authorUrl?: string;
  pageUrl: string;
};

const LOOP_WORDS: Record<StockSearchLanguage, Set<string>> = {
  en: new Set(["loop", "loops", "looping", "loopable", "seamless"]),
  tr: new Set(["döngü", "döngülü", "kesintisiz"]),
};

function mentionsLoop(description: string, language: StockSearchLanguage): boolean {
  const words = description.toLocaleLowerCase(language === "tr" ? "tr" : "en").split(/[^\p{L}]+/u);
  return words.some((w) => LOOP_WORDS[language].has(w));
}

// Photos: the file whose short side is about this many pixels -- sharp up
// to 1080p exports, still only a few MB.
const TARGET_SHORT_SIDE = 1440;
// Videos: the smallest file with at least this short side -- exactly the
// default 720p export, and ~10 MB instead of 40-80+ MB at 1080/1440, which
// matters because the picked file is re-sent with every preview reload,
// autosave and render.
const VIDEO_MIN_SHORT_SIDE = 720;

// Backgrounds must be natural scenery only: no people, no buildings (incl.
// mosques), no vehicles of any kind, no animals, no other man-made objects.
// Two layers enforce it: Pixabay is asked for its "nature" category only,
// and every result whose own tags/description mention any of the words
// below is dropped. Matching is per whole word (Unicode-aware -- JS's \b
// is ASCII-only and silently fails on Turkish letters like ş/ı/ğ), also
// trying the singular of a plural. Pixabay returns its tags in the search
// language, so a Turkish search is checked against the Turkish list.
const BLOCKED_EN = [
  // people
  "woman", "man", "girl", "boy", "person", "people", "human", "lady", "guy", "couple", "model", "face", "selfie",
  "portrait", "child", "children", "kid", "baby", "family", "friend", "crowd", "tourist", "hiker", "hiking",
  "climber", "surfer", "surfing", "swimmer", "swimming", "fisherman", "fishing", "diver", "diving", "runner",
  "skier", "skiing", "traveler", "traveller", "wedding", "bride", "bikini", "swimsuit", "lingerie", "kiss",
  "romantic", "love", "party", "dance", "dancing", "concert", "music", "guitar", "fashion", "nude", "sexy",
  "hand", "feet", "foot", "leg", "legs", "eye", "eyes", "hair", "umbrella", "smoking", "cigarette",
  "miner", "astronaut", "kilt", "skirt", "ski", "sport", "sports", "snowboard", "sandboard", "yoga", "swim",
  "hike", "trekking", "mountaineering", "nomad", "ceremony", "tribe", "rafting", "meeting", "religion",
  // buildings and other man-made structures/objects
  "building", "house", "home", "city", "town", "village", "skyline", "architecture", "mosque", "church", "temple",
  "cathedral", "minaret", "dome", "tower", "bridge", "castle", "palace", "ruins", "ruin", "monument", "statue",
  "street", "road", "highway", "urban", "skyscraper", "apartment", "hotel", "interior", "room", "window", "roof",
  "wall", "fence", "pier", "dock", "harbor", "harbour", "port", "marina", "lighthouse", "dam", "windmill",
  "turbine", "pylon", "factory", "industry", "industrial", "construction", "stadium", "market", "shop", "store",
  "restaurant", "cafe", "kitchen", "barn", "farmhouse", "cabin", "hut", "tent", "camping", "boardwalk", "bench",
  "lamp", "lantern", "candle", "flag", "fireworks", "balloon", "christmas", "cross", "buddha", "halloween",
  "skull", "beer", "wine", "alcohol", "cocktail", "bar", "pub", "drink", "pagoda", "shrine", "torii", "chalet",
  "inn", "camp", "basecamp", "mine", "landmark", "avenue", "fireplace", "cream", "scrap", "wreck", "shipwreck",
  "ancient", "aquarium", "ferris", "amusement", "telescope",
  // vehicles
  "car", "vehicle", "truck", "bus", "train", "railway", "rail", "tram", "subway", "metro", "plane", "airplane",
  "aeroplane", "aircraft", "jet", "helicopter", "airport", "boat", "ship", "yacht", "sailboat", "sailing", "ferry",
  "cruise", "canoe", "kayak", "motorcycle", "motorbike", "bike", "bicycle", "traffic", "tractor", "rocket",
  "satellite", "submarine", "jeep", "taxi", "automobile", "starship", "spaceship", "spacecraft", "ufo",
  // animals
  "animal", "wildlife", "bird", "seagull", "gull", "eagle", "hawk", "owl", "pigeon", "dove", "duck", "swan",
  "goose", "flamingo", "parrot", "fish", "shark", "whale", "dolphin", "turtle", "tortoise", "jellyfish", "crab",
  "horse", "camel", "cow", "cattle", "sheep", "goat", "deer", "lion", "tiger", "elephant", "giraffe", "zebra",
  "bear", "wolf", "fox", "monkey", "cat", "kitten", "dog", "puppy", "pig", "insect", "butterfly", "bee", "ant",
  "spider", "snake", "lizard", "frog", "squirrel", "rabbit", "mammal", "pet", "livestock", "zoo", "chameleon",
  "alpaca", "llama", "creature",
];
const BLOCKED_TR = [
  // people
  "insan", "kadın", "adam", "erkek", "kız", "çocuk", "bebek", "kişi", "kalabalık", "aile", "çift", "model", "yüz",
  "portre", "turist", "gezgin", "yürüyüşçü", "sörfçü", "sörf", "yüzücü", "dalgıç", "balıkçı", "gelin", "düğün",
  "parti", "dans", "müzik", "konser", "moda", "el", "eller", "ayak", "bacak", "göz", "saç", "şemsiye", "sigara",
  "madenci", "astronot", "etek", "kayak", "spor", "yoga", "yüzme", "yüzmek", "yürüyüş", "dağcılık", "göçebe",
  "tören", "kabile", "rafting", "toplantı", "aşk", "romantik", "sevgilim", "ilişki", "din", "kutsal",
  // buildings and other man-made structures/objects
  "bina", "ev", "şehir", "kent", "kasaba", "köy", "mimari", "mimarlık", "cami", "kilise", "tapınak", "minare",
  "kubbe", "kule", "köprü", "kale", "saray", "harabe", "anıt", "heykel", "sokak", "cadde", "yol", "otoyol",
  "kentsel", "gökdelen", "apartman", "otel", "pencere", "oda", "çatı", "duvar", "çit", "iskele", "liman", "marina",
  "fener", "baraj", "değirmen", "türbin", "fabrika", "sanayi", "inşaat", "stadyum", "pazar", "dükkan",
  "mağaza", "restoran", "kafe", "mutfak", "ahır", "kulübe", "çadır", "kamp", "bank", "lamba", "mum",
  "bayrak", "havai", "balon", "noel", "haç", "bira", "şarap", "alkol", "kokteyl", "pagoda", "türbe", "maden",
  "şömine", "dondurma", "hurda", "enkaz", "batık", "antik", "akvaryum", "dolap", "lunapark", "teleskop", "han",
  "jip", "alpaka", "lama", "yaratık",
  // vehicles
  "araba", "araç", "otomobil", "kamyon", "otobüs", "tren", "demiryolu", "tramvay", "metro", "uçak", "jet",
  "helikopter", "havaalanı", "havalimanı", "tekne", "bot", "gemi", "yat", "yelkenli", "yelken", "feribot",
  "kano", "motosiklet", "bisiklet", "trafik", "traktör", "roket", "uydu", "denizaltı", "cip", "taksi",
  // animals
  "hayvan", "yaban", "kuş", "martı", "kartal", "şahin", "baykuş", "güvercin", "ördek", "kuğu", "kaz", "flamingo",
  "papağan", "balık", "köpekbalığı", "balina", "yunus", "kaplumbağa", "denizanası", "yengeç", "at", "deve",
  "inek", "sığır", "koyun", "keçi", "geyik", "aslan", "kaplan", "fil", "zürafa", "zebra", "ayı", "kurt", "tilki",
  "maymun", "kedi", "yavru", "köpek", "domuz", "böcek", "kelebek", "arı", "karınca", "örümcek", "yılan",
  "kertenkele", "kurbağa", "sincap", "tavşan", "memeli", "evcil", "hayvanat",
];
const BLOCKED: Record<StockSearchLanguage, Set<string>> = {
  en: new Set(BLOCKED_EN),
  tr: new Set(BLOCKED_TR.map((w) => w.toLocaleLowerCase("tr"))),
};

function singularForms(word: string, language: StockSearchLanguage): string[] {
  if (language === "tr") return [word, word.replace(/(lar|ler)(ı|i|u|ü)?$/, ""), word.replace(/(ı|i|u|ü|sı|si|su|sü)$/, "")];
  return [word, word.replace(/s$/, ""), word.replace(/es$/, ""), word.replace(/ies$/, "y")];
}

export function isAllowed(description: string, language: StockSearchLanguage): boolean {
  const blocked = BLOCKED[language];
  const words = description.toLocaleLowerCase(language === "tr" ? "tr" : "en").split(/[^\p{L}]+/u).filter(Boolean);
  // Adjacent pairs too, joined: a compound tag is often written as two
  // words ("deniz anası" = jellyfish, listed as "denizanası").
  const candidates = [...words, ...words.slice(1).map((w, i) => words[i] + w)];
  return !candidates.some((w) => singularForms(w, language).some((f) => blocked.has(f)));
}

// ---- tiny response cache ----------------------------------------------------

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 600;
const responseCache = new Map<string, { at: number; data: unknown }>();

async function cachedJson(url: string, headers: Record<string, string>): Promise<any> {
  const hit = responseCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
  }
  const data = await res.json();
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(url, { at: Date.now(), data });
  return data;
}

// ---- randomness -------------------------------------------------------------
// Every search draws a different random slice of a query's results (a seed
// picked by the client per search): which result pages, in what order, and
// in what order their items show -- instead of the same first page every
// time. "Load more" walks the same seed's page order, so it never repeats.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(list: T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// How many result pages a query has, learned from its first response.
const pageCountCache = new Map<string, number>();

// The provider page to fetch for the n-th (1-based) page of this search,
// or null once the seed's page order is used up.
function randomPage(pageCount: number, logicalPage: number, seed: number): number | null {
  if (logicalPage > pageCount) return null;
  const order = seededShuffle(Array.from({ length: pageCount }, (_, i) => i + 1), seed);
  return order[logicalPage - 1];
}

export function configuredProviders(): StockProvider[] {
  const providers: StockProvider[] = [];
  if (process.env.PEXELS_API_KEY) providers.push("pexels");
  if (process.env.PIXABAY_API_KEY) providers.push("pixabay");
  return providers;
}

// ---- Pexels -------------------------------------------------------------------

type PexelsVideoFile = { file_type: string; width: number | null; height: number | null; link: string };

function pexelsHeaders() {
  return { Authorization: process.env.PEXELS_API_KEY ?? "" };
}

function pexelsPhotoToItem(p: any): StockItem {
  return {
    key: `pexels-photo-${p.id}`,
    provider: "pexels",
    type: "photo",
    id: String(p.id),
    thumbUrl: p.src?.medium ?? p.src?.small,
    width: p.width,
    height: p.height,
    author: p.photographer ?? "Pexels",
    authorUrl: p.photographer_url,
    pageUrl: p.url,
  };
}

function mp4Files(files: PexelsVideoFile[] | undefined): (PexelsVideoFile & { width: number; height: number })[] {
  return (files ?? []).filter(
    (f): f is PexelsVideoFile & { width: number; height: number } =>
      f.file_type === "video/mp4" && !!f.width && !!f.height && !!f.link
  );
}

function pexelsVideoToItem(v: any): StockItem {
  const files = mp4Files(v.video_files);
  const preview = files
    .filter((f) => Math.min(f.width, f.height) >= 240)
    .sort((a, b) => a.width * a.height - b.width * b.height)[0];
  return {
    key: `pexels-video-${v.id}`,
    provider: "pexels",
    type: "video",
    id: String(v.id),
    thumbUrl: v.image,
    previewVideoUrl: preview?.link,
    width: v.width,
    height: v.height,
    durationSec: v.duration,
    seamlessLoop: mentionsLoop(v.url ?? "", "en"),
    author: v.user?.name ?? "Pexels",
    authorUrl: v.user?.url,
    pageUrl: v.url,
  };
}

// Pexels serves arbitrarily deep pages; past this, results stop being
// relevant to the query.
const PEXELS_MAX_PAGES = 15;

async function searchPexels(query: string, type: StockMediaType, orientation: StockOrientation, logicalPage: number, perPage: number, language: StockSearchLanguage, seed: number): Promise<ProviderPage> {
  const base = `https://api.pexels.com/${type === "photo" ? "v1" : "videos"}/search`;
  const paramsFor = (page: number) =>
    new URLSearchParams({ query, orientation, page: String(page), per_page: String(perPage), locale: language === "tr" ? "tr-TR" : "en-US" });
  const countKey = `pexels|${type}|${orientation}|${language}|${perPage}|${query}`;
  if (!pageCountCache.has(countKey)) {
    const first = await cachedJson(`${base}?${paramsFor(1)}`, pexelsHeaders());
    pageCountCache.set(countKey, Math.max(1, Math.min(PEXELS_MAX_PAGES, Math.ceil((first.total_results ?? 0) / perPage))));
  }
  const pageCount = pageCountCache.get(countKey)!;
  const page = randomPage(pageCount, logicalPage, seed);
  if (page === null) return { items: [], hasMore: false };
  const data = await cachedJson(`${base}?${paramsFor(page)}`, pexelsHeaders());
  const items =
    type === "photo"
      ? (data.photos ?? []).filter((p: any) => isAllowed(`${p.alt ?? ""} ${p.url ?? ""}`, "en")).map(pexelsPhotoToItem)
      : (data.videos ?? [])
          .filter((v: any) => isAllowed(v.url ?? "", "en"))
          .map(pexelsVideoToItem)
          .filter((item: StockItem) => !!item.previewVideoUrl);
  return { items, hasMore: logicalPage < pageCount };
}

// ---- Pixabay ------------------------------------------------------------------

function pixabayPhotoToItem(h: any): StockItem {
  return {
    key: `pixabay-photo-${h.id}`,
    provider: "pixabay",
    type: "photo",
    id: String(h.id),
    thumbUrl: h.webformatURL,
    width: h.imageWidth,
    height: h.imageHeight,
    author: h.user ?? "Pixabay",
    authorUrl: h.user && h.user_id ? `https://pixabay.com/users/${h.user}-${h.user_id}/` : undefined,
    pageUrl: h.pageURL,
  };
}

function pixabayVideoToItem(h: any, language: StockSearchLanguage): StockItem {
  const v = h.videos ?? {};
  const preview = v.tiny?.url ? v.tiny : v.small;
  return {
    key: `pixabay-video-${h.id}`,
    provider: "pixabay",
    type: "video",
    id: String(h.id),
    thumbUrl: v.medium?.thumbnail || v.small?.thumbnail || v.tiny?.thumbnail || "",
    previewVideoUrl: preview?.url,
    width: v.large?.width || v.medium?.width || 0,
    height: v.large?.height || v.medium?.height || 0,
    durationSec: h.duration,
    seamlessLoop: mentionsLoop(h.tags ?? "", language),
    author: h.user ?? "Pixabay",
    authorUrl: h.user && h.user_id ? `https://pixabay.com/users/${h.user}-${h.user_id}/` : undefined,
    pageUrl: h.pageURL,
  };
}

function pixabayOrientation(orientation: StockOrientation): string {
  return orientation === "portrait" ? "vertical" : orientation === "landscape" ? "horizontal" : "all";
}

// Pixabay's API only ever exposes a query's first 500 results.
const PIXABAY_MAX_RESULTS = 500;

// One Pixabay result list: a wording, ranked one way, optionally only its
// Editor's Choice results (the ones Pixabay's editors awarded -- the best of
// the pool, a few hundred per topic).
type PixabayListing = { query: string; order: "popular" | "latest"; editorsChoice: boolean };

// Pages of a listing it turns out not to have, skipped past within one
// request before it gives up (see searchPixabay).
const PIXABAY_MAX_SKIPS = 8;

// Every page of every listing a search walks, in order: page 1 of every
// listing, then every page 2, ... -- each round shuffled by the seed, with
// an Editor's Choice page leading every three. Pixabay serves at most 500
// results per listing, and a search used to walk a single one, so a topic
// ran dry within a few searches and its good results kept coming back (the
// user, 2026-11-01); a 16-wording topic now reaches thousands. Related
// wordings' Editor's Choice pools overlap heavily, hence mixed in rather
// than first. Every listing is assumed full so the plan never shifts
// mid-search; pages one doesn't have are skipped when fetched.
function pixabayPlan(queries: string[], perPage: number, seed: number): { listing: PixabayListing; page: number }[] {
  const pages = Math.max(1, Math.ceil(PIXABAY_MAX_RESULTS / perPage));
  const editors: PixabayListing[] = queries.map((query) => ({ query, order: "popular", editorsChoice: true }));
  const rest: PixabayListing[] = queries.flatMap((query) =>
    (["popular", "latest"] as const).map((order) => ({ query, order, editorsChoice: false }))
  );
  const plan: { listing: PixabayListing; page: number }[] = [];
  for (let page = 1; page <= pages; page++) {
    const e = seededShuffle(editors, seed + page);
    const r = seededShuffle(rest, (seed ^ 0x5bd1e995) + page);
    while (e.length > 0 || r.length > 0) {
      const next = [e.shift(), r.shift(), r.shift()].filter((l): l is PixabayListing => !!l);
      plan.push(...next.map((listing) => ({ listing, page })));
    }
  }
  return plan;
}

// One page of a listing, or null when the listing doesn't have it.
async function pixabayListingPage(listing: PixabayListing, type: StockMediaType, orientation: StockOrientation, perPage: number, language: StockSearchLanguage, page: number): Promise<StockItem[] | null> {
  const base = type === "photo" ? "https://pixabay.com/api/" : "https://pixabay.com/api/videos/";
  const paramsFor = (p: number) => {
    const params = new URLSearchParams({
      key: process.env.PIXABAY_API_KEY ?? "",
      q: listing.query,
      lang: language,
      safesearch: "true",
      // Natural scenery only -- see BLOCKED_EN above.
      category: "nature",
      order: listing.order,
      page: String(p),
      per_page: String(Math.max(3, perPage)),
    });
    if (listing.editorsChoice) params.set("editors_choice", "true");
    if (type === "photo") {
      params.set("image_type", "photo");
      params.set("orientation", pixabayOrientation(orientation));
    }
    return params;
  };
  const countKey = `pixabay|${type}|${orientation}|${language}|${perPage}|${listing.order}|${listing.editorsChoice ? "ec" : "all"}|${listing.query}`;
  if (!pageCountCache.has(countKey)) {
    const first = await cachedJson(`${base}?${paramsFor(1)}`, {});
    const total = Math.min(PIXABAY_MAX_RESULTS, first.totalHits ?? 0);
    pageCountCache.set(countKey, Math.ceil(total / perPage));
  }
  if (page > pageCountCache.get(countKey)!) return null;
  let data: any;
  try {
    data = await cachedJson(`${base}?${paramsFor(page)}`, {});
  } catch (err) {
    // Pixabay answers a page past the listing's end with a 400.
    if (page > 1 && err instanceof Error && err.message.startsWith("HTTP 400")) return null;
    throw err;
  }
  return type === "photo"
    ? (data.hits ?? []).filter((h: any) => isAllowed(h.tags ?? "", language)).map(pixabayPhotoToItem)
    : (data.hits ?? [])
        .filter((h: any) => isAllowed(h.tags ?? "", language))
        .map((h: any) => pixabayVideoToItem(h, language))
        .filter((item: StockItem) => !!item.thumbUrl && !!item.previewVideoUrl);
}

async function searchPixabay(queries: string[], type: StockMediaType, orientation: StockOrientation, logicalPage: number, perPage: number, language: StockSearchLanguage, seed: number): Promise<ProviderPage> {
  const plan = pixabayPlan(queries, perPage, seed);
  let n = logicalPage;
  for (; n <= plan.length && n < logicalPage + PIXABAY_MAX_SKIPS; n++) {
    const { listing, page } = plan[n - 1];
    const items = await pixabayListingPage(listing, type, orientation, perPage, language, page);
    if (items) return { items, hasMore: n < plan.length, lastPage: n };
  }
  const lastPage = Math.min(n, plan.length);
  return { items: [], hasMore: lastPage < plan.length, lastPage };
}

// lastPage: the last page of the search this one consumed (a provider may
// skip past pages it turned out not to have).
type ProviderPage = { items: StockItem[]; hasMore: boolean; lastPage?: number };

// ---- public API -----------------------------------------------------------------

// `queries`: every wording of the search (a topic's several, or the one the
// user typed). Pixabay walks them all; Pexels, which serves deep pages of a
// single wording, takes one per search.
export async function searchStock(
  queries: string[],
  type: StockMediaType,
  orientation: StockOrientation,
  page: number,
  language: StockSearchLanguage = "en",
  seed = 1
): Promise<{ items: StockItem[]; errors: string[]; hasMore: boolean; lastPage: number }> {
  const providers = configuredProviders();
  const perProvider = providers.length > 1 ? 18 : 36;
  const pexelsQuery = queries[Math.floor(mulberry32(seed)() * queries.length)];
  const settled = await Promise.allSettled(
    providers.map((p) =>
      p === "pexels"
        ? searchPexels(pexelsQuery, type, orientation, page, perProvider, language, seed)
        : searchPixabay(queries, type, orientation, page, perProvider, language, seed)
    )
  );
  const lists: StockItem[][] = [];
  const errors: string[] = [];
  let hasMore = false;
  let lastPage = page;
  settled.forEach((r, i) => {
    // Shuffled by the seed, seamless loops still first.
    if (r.status === "fulfilled") {
      const shuffled = seededShuffle(r.value.items, seed + page);
      lists.push([...shuffled.filter((v) => v.seamlessLoop), ...shuffled.filter((v) => !v.seamlessLoop)]);
      hasMore = hasMore || r.value.hasMore;
      lastPage = Math.max(lastPage, r.value.lastPage ?? page);
    } else {
      errors.push(`${providers[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });
  // Interleave so both providers show up near the top.
  const items: StockItem[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) items.push(l[i]);
  }
  return { items, errors, hasMore, lastPage };
}

// Smallest video file that's still at least VIDEO_MIN_SHORT_SIDE, or the
// largest one when none is.
function pickVideoFile<T extends { width: number; height: number }>(files: T[]): T | undefined {
  const area = (f: T) => f.width * f.height;
  const bigEnough = files.filter((f) => Math.min(f.width, f.height) >= VIDEO_MIN_SHORT_SIDE);
  if (bigEnough.length > 0) return [...bigEnough].sort((a, b) => area(a) - area(b))[0];
  return [...files].sort((a, b) => area(b) - area(a))[0];
}

// Resolves the actual file to download for an item the picker showed, by
// re-fetching it from the provider by id -- never trusting a URL from the
// client, so this can't be used to make the server fetch arbitrary URLs.
export async function resolveDownloadUrl(provider: StockProvider, type: StockMediaType, id: string): Promise<string> {
  if (!/^\d+$/.test(id)) throw new Error("Invalid id");

  if (provider === "pexels") {
    if (!process.env.PEXELS_API_KEY) throw new Error("Pexels is not configured");
    if (type === "photo") {
      const p = await cachedJson(`https://api.pexels.com/v1/photos/${id}`, pexelsHeaders());
      const original: string | undefined = p.src?.original;
      if (!original) throw new Error("Photo has no downloadable file");
      // Pexels resizes on the fly from the original via these query params;
      // ask for the short side only, so nothing gets cropped here.
      const sizeParam = p.width <= p.height ? `w=${TARGET_SHORT_SIDE}` : `h=${TARGET_SHORT_SIDE}`;
      return `${original}?auto=compress&cs=tinysrgb&${sizeParam}`;
    }
    const v = await cachedJson(`https://api.pexels.com/videos/videos/${id}`, pexelsHeaders());
    const best = pickVideoFile(mp4Files(v.video_files));
    if (!best) throw new Error("Video has no downloadable mp4 file");
    return best.link;
  }

  if (!process.env.PIXABAY_API_KEY) throw new Error("Pixabay is not configured");
  const params = new URLSearchParams({ key: process.env.PIXABAY_API_KEY, id });
  if (type === "photo") {
    const data = await cachedJson(`https://pixabay.com/api/?${params}`, {});
    const url: string | undefined = data.hits?.[0]?.largeImageURL;
    if (!url) throw new Error("Photo not found");
    return url;
  }
  const data = await cachedJson(`https://pixabay.com/api/videos/?${params}`, {});
  const videos = data.hits?.[0]?.videos ?? {};
  const files = ["large", "medium", "small", "tiny"]
    .map((k) => videos[k])
    .filter((f: any) => f?.url && f.width && f.height);
  const best = pickVideoFile(files as { url: string; width: number; height: number }[]);
  if (!best) throw new Error("Video not found");
  return best.url;
}
