// The quick topics under the background library's search box, shared by the
// picker (labels) and the search route (wordings). Pixabay returns at most
// 500 results per wording, so a topic searches ALL of its wordings, page by
// page as the user scrolls (see lib/stockBackgrounds.ts) -- a few wordings
// ran out within a few searches and the good results kept coming back
// (the user, 2026-11-01). Wordings stay within natural scenery and must not
// contain a blocked word (lib/stockBackgrounds.ts's BLOCKED_EN), or every
// result for them is dropped.

export interface BackgroundTopic {
  id: string;
  ar: string;
  tr: string;
  en: string;
  queries: string[];
}

export const BACKGROUND_TOPICS: BackgroundTopic[] = [
  {
    id: "night-sky", ar: "سماء ليلية", tr: "Gece Gökyüzü", en: "Night Sky",
    queries: [
      "night sky stars", "starry sky", "starry night", "full moon", "moon night sky", "crescent moon",
      "moonlight", "moon clouds", "star trails", "night landscape stars", "astrophotography",
      "night sky mountains", "blue hour sky", "twilight sky", "moonrise", "night clouds",
    ],
  },
  {
    id: "clouds", ar: "غيوم", tr: "Bulutlar", en: "Clouds",
    queries: [
      "clouds sky", "cloudscape", "dramatic clouds", "white clouds blue sky", "clouds timelapse", "cumulus clouds",
      "clouds sunlight", "sun rays clouds", "fluffy clouds", "above the clouds", "sea of clouds", "blue sky",
      "cloudy sky", "pink clouds", "clouds horizon", "sky background",
    ],
  },
  {
    id: "sea", ar: "بحر", tr: "Deniz", en: "Sea",
    queries: [
      "ocean waves", "sea waves", "calm sea", "ocean water", "sea horizon", "turquoise sea", "ocean sunset",
      "waves crashing", "sea foam", "ocean surface", "seascape", "rocky coast", "sea cliffs", "blue ocean",
      "tropical sea", "underwater light",
    ],
  },
  {
    id: "rain", ar: "مطر", tr: "Yağmur", en: "Rain",
    queries: [
      "rain", "rain drops", "rainy weather", "rain storm", "raindrops leaves", "heavy rain", "rain clouds",
      "rain on water", "rainy forest", "water drops", "dew drops", "drizzle", "rain ripples", "monsoon clouds",
    ],
  },
  {
    id: "sunset", ar: "غروب", tr: "Gün Batımı", en: "Sunset",
    queries: [
      "sunset sky", "sunset clouds", "sunrise sky", "golden hour sky", "dusk sky", "sunset sea", "sunset mountains",
      "sunrise mountains", "sunrise fog", "orange sky", "red sky", "sunset horizon", "sun rays", "sunrise landscape",
      "evening sky", "dawn sky",
    ],
  },
  {
    id: "desert", ar: "صحراء", tr: "Çöl", en: "Desert",
    queries: [
      "desert sand dunes", "sand dunes", "desert landscape", "sahara desert", "desert sunset", "desert night",
      "dunes aerial", "sand texture", "desert mountains", "red desert", "arid landscape", "sand waves",
      "desert sky", "namib desert", "desert rocks", "golden dunes",
    ],
  },
  {
    id: "mountains", ar: "جبال", tr: "Dağlar", en: "Mountains",
    queries: [
      "mountains fog", "mountain landscape", "mountain peaks", "misty mountains", "mountains clouds", "alps",
      "snowy peaks", "mountain range", "mountain valley", "mountain sunrise", "himalaya", "dolomites",
      "rocky mountains", "mountain ridge", "highlands", "mountain panorama",
    ],
  },
  {
    id: "forest", ar: "غابات", tr: "Orman", en: "Forest",
    queries: [
      "forest mist", "forest trees", "green forest", "forest fog", "forest sunlight", "pine forest", "rainforest",
      "forest canopy", "woodland", "bamboo forest", "forest moss", "jungle", "forest stream", "birch forest",
      "tree tops", "sun rays forest",
    ],
  },
  {
    id: "rivers", ar: "أنهار", tr: "Nehirler", en: "Rivers",
    queries: [
      "river", "river stream", "mountain river", "river water", "creek", "river valley", "river rocks",
      "flowing water", "river forest", "river sunset", "brook", "rapids", "river aerial", "calm river",
      "winding river", "water stream",
    ],
  },
  {
    id: "galaxy", ar: "مجرّة", tr: "Galaksi", en: "Galaxy",
    queries: [
      "milky way galaxy", "milky way", "galaxy stars", "nebula space", "starfield", "cosmos", "deep space",
      "andromeda galaxy", "night sky milky way", "outer space stars", "space nebula", "universe stars",
      "star cluster", "orion nebula", "galaxy background", "stars space",
    ],
  },
  {
    id: "waterfall", ar: "شلالات", tr: "Şelale", en: "Waterfall",
    queries: [
      "waterfall", "waterfall nature", "cascade water", "waterfall forest", "tropical waterfall", "waterfall rocks",
      "iceland waterfall", "waterfall long exposure", "waterfall mountain", "small waterfall", "waterfall jungle",
      "waterfall pool", "cascading water", "waterfall cliff", "falls water", "waterfall moss",
    ],
  },
  {
    id: "snow", ar: "ثلوج", tr: "Kar", en: "Snow",
    queries: [
      "snow winter landscape", "snowy forest", "snowfall", "winter snow mountains", "snowy trees", "winter landscape",
      "frost", "snowflakes", "frozen lake", "snow field", "winter forest", "ice crystals", "snowy mountains",
      "winter sunrise", "hoarfrost", "falling snow",
    ],
  },
  {
    id: "lakes", ar: "بحيرات", tr: "Göller", en: "Lakes",
    queries: [
      "lake", "mountain lake", "lake reflection", "calm lake", "lake sunrise", "lake fog", "alpine lake",
      "lake forest", "lake sunset", "turquoise lake", "still water reflection", "pond", "lake aerial",
      "misty lake", "lake shore", "lake mountains",
    ],
  },
  {
    id: "aurora", ar: "شفق قطبي", tr: "Kuzey Işıkları", en: "Aurora",
    queries: [
      "aurora borealis", "northern lights", "aurora", "aurora sky", "polar lights", "aurora night",
      "northern lights snow", "aurora mountains", "aurora lake", "green aurora", "aurora stars", "aurora australis",
    ],
  },
  {
    id: "fog", ar: "ضباب", tr: "Sis", en: "Fog",
    queries: [
      "fog", "foggy landscape", "mist", "morning mist", "foggy forest", "fog valley", "misty morning", "fog hills",
      "mist lake", "fog trees", "haze landscape", "fog mountains", "low clouds", "foggy field",
    ],
  },
  {
    id: "autumn", ar: "خريف", tr: "Sonbahar", en: "Autumn",
    queries: [
      "autumn", "autumn leaves", "fall foliage", "autumn forest", "autumn trees", "autumn landscape", "fall colors",
      "golden autumn", "maple leaves", "autumn river", "autumn mountains", "red leaves", "orange leaves", "autumn mist",
    ],
  },
  {
    id: "beach", ar: "شواطئ", tr: "Sahiller", en: "Beaches",
    queries: [
      "beach", "sandy beach", "tropical beach", "beach sunset", "beach waves", "white sand beach", "palm beach",
      "beach aerial", "coast", "shore", "beach sunrise", "lagoon", "island beach", "beach rocks",
    ],
  },
  {
    id: "fields", ar: "حقول وزهور", tr: "Çiçek Tarlaları", en: "Fields & Flowers",
    queries: [
      "flower field", "wildflowers", "meadow flowers", "lavender field", "sunflower field", "green field",
      "wheat field", "grass field", "spring flowers", "tulip field", "poppy field", "field sunset", "green meadow",
      "rolling hills", "green hills", "blossom",
    ],
  },
  {
    id: "valleys", ar: "وديان", tr: "Vadiler", en: "Valleys",
    queries: [
      "valley", "green valley", "valley fog", "valley landscape", "canyon", "grand canyon", "gorge", "grassland",
      "plains", "rock formations", "red rocks", "cliffs", "mountain pass", "valley sunrise",
    ],
  },
  {
    id: "storm", ar: "عواصف وبرق", tr: "Fırtına", en: "Storms",
    queries: [
      "lightning", "lightning storm", "thunderstorm", "storm clouds", "storm sky", "supercell", "dark clouds",
      "stormy sea", "lightning strike", "thunder", "stormy weather", "storm sunset",
    ],
  },
  {
    id: "ice", ar: "جليد", tr: "Buzullar", en: "Ice",
    queries: [
      "glacier", "iceberg", "ice cave", "arctic", "antarctica", "frozen", "ice landscape", "glacier lagoon",
      "ice texture", "polar landscape", "frozen waterfall", "ice formations",
    ],
  },
];

export function topicById(id: string | null | undefined): BackgroundTopic | undefined {
  return id ? BACKGROUND_TOPICS.find((t) => t.id === id) : undefined;
}
