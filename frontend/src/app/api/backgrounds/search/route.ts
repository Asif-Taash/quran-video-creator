import { NextResponse } from "next/server";
import { configuredProviders, isAllowed, searchStock, type StockMediaType, type StockOrientation } from "@/lib/stockBackgrounds";
import { resolveSearchQuery } from "@/lib/stockSearchQuery";
import { checkThumbnails } from "@/lib/natureCheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORIENTATIONS: StockOrientation[] = ["portrait", "landscape", "square"];
// The image check turns many results away (see lib/natureCheck.ts); a page
// left with fewer than this is topped up from the next one or two pages.
const MIN_RESULTS = 12;
const MAX_EXTRA_PAGES = 2;
let warnedNotConfigured = false;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") || "").trim().slice(0, 100);
  const type: StockMediaType = searchParams.get("type") === "photo" ? "photo" : "video";
  const orientationParam = searchParams.get("orientation") as StockOrientation | null;
  const orientation = orientationParam && ORIENTATIONS.includes(orientationParam) ? orientationParam : "portrait";
  const page = Math.max(1, Math.min(50, Number(searchParams.get("page")) || 1));
  // Picked by the client per search, so every search shows a different
  // random slice of the results (see lib/stockBackgrounds.ts).
  const seed = Math.abs(Math.floor(Number(searchParams.get("seed")) || 1)) % 2147483647;

  if (!query) {
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

  const resolved = await resolveSearchQuery(query, searchParams.get("lang") || "en");
  // Asking for something the library never shows (a mosque, a car, people,
  // an animal...) -- say so instead of returning a puzzling empty list.
  // Checked against English too: a Turkish-UI user may type English words.
  if (!isAllowed(resolved.query, resolved.language) || !isAllowed(resolved.query, "en")) {
    return NextResponse.json({ items: [], providers, hasMore: false, notNature: true });
  }
  const { items, errors, hasMore } = await searchStock(resolved.query, type, orientation, page, resolved.language, seed);
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
  let natural: typeof items;
  let lastPage = page;
  let more = hasMore;
  try {
    natural = await onlyNatural(items);
    while (natural.length < MIN_RESULTS && more && lastPage < page + MAX_EXTRA_PAGES) {
      lastPage++;
      const next = await searchStock(resolved.query, type, orientation, lastPage, resolved.language, seed);
      more = next.hasMore;
      const seen = new Set(natural.map((it) => it.key));
      natural = [...natural, ...(await onlyNatural(next.items)).filter((it) => !seen.has(it.key))];
    }
  } catch (err) {
    console.error("[Backgrounds] Image check failed:", err);
    return NextResponse.json({ error: "Background check is unavailable right now." }, { status: 503 });
  }

  // Check the next page in the background, so "load more" is already fast.
  if (more) {
    void searchStock(resolved.query, type, orientation, lastPage + 1, resolved.language, seed)
      .then((next) => checkThumbnails(next.items.map((it) => ({ key: it.key, url: it.thumbUrl }))))
      .catch(() => undefined);
  }
  return NextResponse.json({ items: natural, providers, hasMore: more, lastPage });
}
