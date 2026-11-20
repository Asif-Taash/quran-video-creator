import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { BACKGROUND_TOPICS } from "@/lib/backgroundTopics";

export const runtime = "nodejs";

// Background topics that suit the chosen ayahs (2026-11-20): the picker
// offers these first and loads the first one by itself while the user is
// still looking at the video. Read from the ayahs' Turkish translation
// (Diyanet Vakfı, kept locally) by word forms -- whole words or a word's
// start, never inside a word, so "dağıttı" (scattered) isn't a mountain.
//
// GET ?surah=&from=&to=  ->  { topics: string[] } (best first, at most 3)

type Rule = { topic: string; words: RegExp; weight?: number };

// Turkish letters count as word letters (\b doesn't know them).
const W = "a-zçğıöşüâîû";
const word = (alternatives: string) => new RegExp(`(?<![${W}])(?:${alternatives})(?![${W}])`, "giu");
const start = (alternatives: string) => new RegExp(`(?<![${W}])(?:${alternatives})`, "giu");

const RULES: Rule[] = [
  { topic: "sea", words: start("deniz|derya|dalga|okyanus|gemi") },
  { topic: "mountains", words: word("dağ|dağa|dağı|dağın|dağda|dağdan|dağlar|dağları|dağların|dağlara|dağlarda|dağlardan|dağlarla") },
  { topic: "night-sky", words: start("gece|yıldız|hilal") },
  { topic: "night-sky", words: start("karanlık"), weight: 0.5 },
  { topic: "galaxy", words: start("gökler|göklerde|göklerin|semâ|sema|gezegen") },
  { topic: "clouds", words: start("bulut|gökyüzü|göğ") },
  { topic: "clouds", words: word("gök"), weight: 0.7 },
  { topic: "sunset", words: start("güneş|sabah|şafak|akşam|tan yeri|kuşluk") },
  { topic: "rain", words: start("yağmur|sağanak") },
  { topic: "storm", words: start("şimşek|gök gürültüsü|fırtına|kasırga|yıldırım|rüzgâr|rüzgar") },
  { topic: "rivers", words: start("ırmak|nehir|nehirler") },
  { topic: "rivers", words: start("cennet"), weight: 0.6 },
  { topic: "waterfall", words: start("pınar|kaynak|çeşme|fışkır") },
  { topic: "forest", words: start("ağaç|orman") },
  { topic: "fields", words: start("ekin|bitki|tohum|hurma|üzüm|zeytin|bahçe|çiçek|yeşil") },
  { topic: "fields", words: start("cennet"), weight: 0.4 },
  { topic: "valleys", words: start("vadi") },
  { topic: "desert", words: word("çöl|çölde|çöller|kum|kumlar|kum tepeleri") },
];

// For ayahs that name nothing in nature: quiet, all-purpose scenes.
const DEFAULT_TOPICS = ["night-sky", "clouds", "sunset"];

let translation: Record<string, string> | null = null;

async function loadTranslation(): Promise<Record<string, string> | null> {
  if (translation) return translation;
  for (const name of ["diyanet_vakfi.json", "diyanet_yeni.json"]) {
    try {
      const raw = await fs.readFile(path.join(process.cwd(), "src", "data", "translations", name), "utf8");
      translation = JSON.parse(raw);
      return translation;
    } catch {
      // Not on disk (the public repository leaves translations out): try the next.
    }
  }
  return null;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const surah = Number(params.get("surah"));
  const from = Number(params.get("from"));
  const to = Math.min(Number(params.get("to")), from + 40);
  if (!Number.isInteger(surah) || !Number.isInteger(from) || !Number.isInteger(to) || surah < 1 || surah > 114 || from < 1 || to < from) {
    return NextResponse.json({ topics: DEFAULT_TOPICS });
  }
  const text = await loadTranslation();
  const scores = new Map<string, number>();
  if (text) {
    for (let ayah = from; ayah <= to; ayah++) {
      const t = (text[`${surah}:${ayah}`] ?? "").toLocaleLowerCase("tr");
      for (const rule of RULES) {
        const hits = t.match(rule.words)?.length ?? 0;
        if (hits > 0) scores.set(rule.topic, (scores.get(rule.topic) ?? 0) + Math.min(hits, 2) * (rule.weight ?? 1));
      }
    }
  }
  const known = new Set(BACKGROUND_TOPICS.map((t) => t.id));
  const ranked = [...scores.entries()]
    .filter(([id]) => known.has(id))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const topics = [...ranked, ...DEFAULT_TOPICS.filter((id) => !ranked.includes(id))].slice(0, 3);
  return NextResponse.json({ topics, matched: ranked.length > 0 });
}
