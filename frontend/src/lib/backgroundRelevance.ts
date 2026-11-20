// Server-only: is a stock result actually about what was searched? Pixabay
// matches loosely -- past its first pages, and with a color filter, a
// "night sky stars" search returns plain daytime clouds, grass and lit
// fountains that match only "sky" or nothing visible at all (the user,
// 2026-11-14: 53 of the 89 photos a night-sky search showed had no
// night-related tag). A result is kept only when its tags name the
// subject: a word below (a word also covers longer ones it starts, from 4
// letters on: "moon" -> "moonlight") or a phrase (has a space).

export type RelevanceCheck = (tags: string) => boolean;

// Per quick topic (lib/backgroundTopics.ts). Only words naming the topic's
// subject -- never a generic one like "sky" or "landscape".
const TOPIC_WORDS: Record<string, string[]> = {
  "night-sky": [
    "night", "star", "moon", "crescent", "lunar", "astrophotography", "astronomy", "milky way", "galaxy",
    "cosmos", "universe", "nebula", "blue hour", "aurora", "nocturnal",
  ],
  clouds: ["cloud", "cumulus", "cirrus", "stratus", "nimbus", "overcast", "sky", "skies", "heaven"],
  sea: ["sea", "ocean", "wave", "seascape", "surf", "coast", "shore", "beach", "lagoon", "tide", "underwater", "marine", "bay"],
  rain: ["rain", "drop", "dew", "drizzle", "monsoon", "wet", "puddle", "shower", "ripple"],
  sunset: ["sunset", "sunrise", "sundown", "dusk", "dawn", "golden hour", "twilight", "afterglow", "evening", "orange sky", "red sky"],
  desert: ["desert", "dune", "sand", "sahara", "namib", "arid", "oasis", "wadi"],
  mountains: [
    "mountain", "peak", "summit", "alps", "alpine", "himalaya", "dolomites", "ridge", "highland", "massif",
    "hills", "volcano",
  ],
  forest: ["forest", "woods", "woodland", "tree", "jungle", "pine", "birch", "bamboo", "canopy", "moss", "foliage"],
  rivers: ["river", "stream", "creek", "brook", "rapids", "rivulet", "flowing water", "waterway"],
  galaxy: [
    "galaxy", "galaxies", "milky way", "nebula", "cosmos", "cosmic", "universe", "star", "astronomy",
    "astrophotography", "andromeda", "orion", "outer space", "deep space",
  ],
  waterfall: ["waterfall", "cascade", "cascading", "falls"],
  snow: ["snow", "winter", "frost", "frozen", "ice crystal", "hoarfrost", "blizzard", "rime"],
  lakes: ["lake", "pond", "tarn", "loch", "still water"],
  aurora: ["aurora", "borealis", "australis", "northern lights", "polar lights"],
  fog: ["fog", "mist", "haze", "hazy", "low clouds"],
  autumn: ["autumn", "fall", "foliage", "leaves", "leaf", "maple"],
  beach: ["beach", "seaside", "shore", "coast", "seashore", "lagoon", "sand", "bay", "island"],
  fields: [
    "field", "meadow", "flower", "wildflower", "blossom", "bloom", "lavender", "sunflower", "tulip", "poppy",
    "poppies", "wheat", "grass", "pasture", "prairie", "hills", "spring",
  ],
  valleys: [
    "valley", "canyon", "gorge", "ravine", "grassland", "plains", "prairie", "cliff", "rock", "sandstone",
    "mesa", "butte", "mountain pass",
  ],
  storm: ["storm", "lightning", "thunder", "supercell", "tornado", "cyclone", "hurricane", "dark clouds"],
  ice: ["ice", "icy", "glacier", "iceberg", "arctic", "antarctic", "frozen", "polar"],
};

// Words a typed search may contain that don't name a subject: a search
// made only of these is not filtered.
const GENERIC = new Set([
  "sky", "skies", "nature", "natural", "landscape", "landscapes", "background", "backgrounds", "beautiful",
  "scenery", "scenic", "view", "views", "photo", "wallpaper", "outdoor", "outdoors", "light", "color", "colors",
  "blue", "white", "green", "red", "orange", "golden", "dark", "aerial", "texture", "calm", "the", "and", "with",
  "gökyüzü", "doğa", "manzara", "arka", "plan", "güzel", "renk", "mavi", "beyaz", "yeşil", "kırmızı", "turuncu",
  "karanlık", "ile",
]);

function compile(words: string[]): RelevanceCheck {
  const phrases = words.filter((w) => w.includes(" "));
  const singles = words.filter((w) => !w.includes(" "));
  return (tags) => {
    const lower = tags.toLowerCase();
    if (phrases.some((p) => lower.includes(p))) return true;
    const tokens = lower.split(/[^\p{L}]+/u).filter(Boolean);
    return tokens.some((t) => singles.some((w) => t === w || (w.length >= 4 && t.startsWith(w))));
  };
}

export function topicRelevance(topicId: string): RelevanceCheck | undefined {
  const words = TOPIC_WORDS[topicId];
  return words ? compile(words) : undefined;
}

// A typed search: any of its own subject words.
export function queryRelevance(query: string, language: string): RelevanceCheck | undefined {
  const words = query
    .toLocaleLowerCase(language === "tr" ? "tr" : "en")
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 3 && !GENERIC.has(w));
  return words.length > 0 ? compile(words) : undefined;
}
