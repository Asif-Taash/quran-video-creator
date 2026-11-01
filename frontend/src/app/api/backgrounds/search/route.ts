import { NextResponse } from "next/server";
import { configuredProviders, isAllowed, searchStock, type StockMediaType, type StockOrientation } from "@/lib/stockBackgrounds";
import { resolveSearchQuery } from "@/lib/stockSearchQuery";
import { topicById } from "@/lib/backgroundTopics";
import { checkThumbnails } from "@/lib/natureCheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORIENTATIONS: StockOrientation[] = ["portrait", "landscape", "square"];
// The image check turns many results away (see lib/natureCheck.ts); a page
// left with fewer than this is topped up from the next one or two pages.
const MIN_RESULTS = 12;
const MAX_EXTRA_PAGES = 4;
// Some uploaders post dozens of near-identical clips of one scene, and one
// of them could fill half a screen (6 of 14, 2026-11-01): at most this many
// of one author's per batch.
const MAX_PER_AUTHOR = 2;
let warnedNotConfigured = false;

// What each search (its seed, picked by the client per search) has already
// sent, so scrolling on never brings the same item twice -- a topic's
// wordings overlap, and repeats used to fill most of every later batch.
// Forgotten after a while; the picker skips repeats of its own as well.
const SEARCH_MEMORY_MAX = 200;
const SEARCH_MEMORY_TTL_MS = 2 * 60 * 60 * 1000;
const sentBySearch = new Map<string, { at: number; keys: Set<string> }>();

function sentKeys(search: string): Set<string> {
  const now = Date.now();
  for (const [key, entry] of sentBySearch) {
    if (now - entry.at > SEARCH_MEMORY_TTL_MS) sentBySearch.delete(key);
  }
  let entry = sentBySearch.get(search);
  if (!entry) {
    if (sentBySearch.size >= SEARCH_MEMORY_MAX) {
      const oldest = sentBySearch.keys().next().value;
      if (oldest !== undefined) sentBySearch.delete(oldest);
    }
    entry = { at: now, keys: new Set() };
    sentBySearch.set(search, entry);
  }
  entry.at = now;
  return entry.keys;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") || "").trim().slice(0, 100);
  // A quick topic under the search box: all of its wordings are searched
  // (see lib/backgroundTopics.ts).
  const topic = topicById(searchParams.get("topic"));
  const type: StockMediaType = searchParams.get("type") === "photo" ? "photo" : "video";
  const orientationParam = searchParams.get("orientation") as StockOrientation | null;
  const orientation = orientationParam && ORIENTATIONS.includes(orientationParam) ? orientationParam : "portrait";
  // A topic's pages run into the hundreds (every wording, ranked both ways,
  // see lib/stockBackgrounds.ts), so the cap only stops absurd values.
  const page = Math.max(1, Math.min(5000, Number(searchParams.get("page")) || 1));
  // Picked by the client per search, so every search shows a different
  // random slice of the results (see lib/stockBackgrounds.ts).
  const seed = Math.abs(Math.floor(Number(searchParams.get("seed")) || 1)) % 2147483647;

  if (!query && !topic) {
    return NextResponse.json({ error: "Query is required." }, { status: 400 });
  }
  const providers = configuredProviders();
  if (providers.length === 0) {
    // Not an error for the visitor -- the picker just hides the library.
    // The setup hint goes to the server log instead, once per process.
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn("[Backgrounds] Library hidden: set PEXELS_API_KEY and/or PIXABAY_API_KEY in frontend/.env.local to enable it.");
    }
    return NextResponse.json({ enabled: false, items: [] });
  }

  const resolved = topic
    ? { queries: topic.queries, language: "en" as const }
    : await resolveSearchQuery(query, searchParams.get("lang") || "en").then((r) => ({ queries: [r.query], language: r.language }));
  // Asking for something the library never shows (a mosque, a car, people,
  // an animal...) -- say so instead of returning a puzzling empty list.
  // Checked against English too: a Turkish-UI user may type English words.
  if (!topic && (!isAllowed(resolved.queries[0], resolved.language) || !isAllowed(resolved.queries[0], "en"))) {
    return NextResponse.json({ items: [], providers, hasMore: false, notNature: true });
  }
  const { items, errors, hasMore, lastPage: firstLastPage } = await searchStock(resolved.queries, type, orientation, page, resolved.language, seed);
  if (errors.length > 0) console.warn("[Backgrounds] Provider errors:", errors);
  if (items.length === 0 && errors.length === providers.length) {
    return NextResponse.json({ error: "Background search is unavailable right now." }, { status: 502 });
  }

  // Only what the image check passes is shown -- natural scenery only, see
  // lib/natureCheck.ts. Fails closed: no check, no results.
  const onlyNatural = async (list: typeof items) => {
    const verdicts = await checkThumbnails(list.map((it) => ({ key: it.key, url: it.thumbUrl })));
    return list.filter((it) => verdicts[it.key] === true);
  };
  // A new search (page 1) starts over; its later pages skip what it sent.
  const searchKey = `${seed}|${type}|${orientation}|${topic ? `topic:${topic.id}` : resolved.queries[0]}`;
  if (page === 1) sentBySearch.delete(searchKey);
  const sent = sentKeys(searchKey);
  const perAuthor = new Map<string, number>();
  const capAuthors = (list: typeof items) =>
    list.filter((it) => {
      const count = (perAuthor.get(it.author) ?? 0) + 1;
      perAuthor.set(it.author, count);
      return count <= MAX_PER_AUTHOR;
    });
  let natural: typeof items;
  let lastPage = firstLastPage;
  let more = hasMore;
  try {
    natural = capAuthors(await onlyNatural(items.filter((it) => !sent.has(it.key))));
    for (let extra = 0; natural.length < MIN_RESULTS && more && extra < MAX_EXTRA_PAGES; extra++) {
      const next = await searchStock(resolved.queries, type, orientation, lastPage + 1, resolved.language, seed);
      lastPage = next.lastPage;
      more = next.hasMore;
      const seen = new Set(natural.map((it) => it.key));
      natural = [...natural, ...capAuthors(await onlyNatural(next.items.filter((it) => !seen.has(it.key) && !sent.has(it.key))))];
    }
  } catch (err) {
    console.error("[Backgrounds] Image check failed:", err);
    return NextResponse.json({ error: "Background check is unavailable right now." }, { status: 503 });
  }

  // Check the next page in the background, so scrolling on is already fast.
  if (more) {
    void searchStock(resolved.queries, type, orientation, lastPage + 1, resolved.language, seed)
      .then((next) => checkThumbnails(next.items.map((it) => ({ key: it.key, url: it.thumbUrl }))))
      .catch(() => undefined);
  }
  natural.forEach((it) => sent.add(it.key));
  return NextResponse.json({ items: natural, providers, hasMore: more, lastPage });
}
