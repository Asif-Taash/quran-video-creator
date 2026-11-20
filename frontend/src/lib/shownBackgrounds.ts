import fs from "fs/promises";
import path from "path";

// Every library result the search route has sent, and when -- so a new
// search shows what was never shown before first. Each search used to start
// from the same top results of every wording (only reshuffled), and a
// regular user kept getting the same few hundred photos, many of them
// already in their older videos, while thousands more were never reached
// (the user, 2026-11-14: one topic had 5,867 photos, 1,785 ever shown).
// Only an ordering preference: a missing or unreadable file just means
// "nothing shown yet".
const SHOWN_PATH = path.join(process.cwd(), "src", "data", "shown-backgrounds.json");
// ~35 bytes per entry; the oldest are forgotten first.
const SHOWN_MAX = 100_000;
// Scrolling sends a request every second or two: one write per pause.
const WRITE_DELAY_MS = 3000;

type State = {
  shown: Map<string, number> | null;
  loading: Promise<Map<string, number>> | null;
  timer: ReturnType<typeof setTimeout> | null;
  writing: Promise<void>;
};
// On globalThis so a dev-server recompile of this module keeps it.
const state = ((globalThis as { __shownBackgrounds?: unknown }).__shownBackgrounds ??= {
  shown: null,
  loading: null,
  timer: null,
  writing: Promise.resolve(),
}) as State;

function load(): Promise<Map<string, number>> {
  if (state.shown) return Promise.resolve(state.shown);
  state.loading ??= fs
    .readFile(SHOWN_PATH, "utf-8")
    .then((raw) => {
      const list: unknown = JSON.parse(raw)?.shown;
      const entries = Array.isArray(list)
        ? list.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number")
        : [];
      return new Map(entries);
    })
    .catch(() => new Map<string, number>())
    .then((map) => (state.shown = map));
  return state.loading;
}

async function save(): Promise<void> {
  const shown = state.shown;
  if (!shown) return;
  const tmp = `${SHOWN_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, shown: [...shown] }));
  await fs.rename(tmp, SHOWN_PATH);
}

/** (stock key) -> was it sent by an earlier search? */
export async function shownBeforeCheck(): Promise<(key: string) => boolean> {
  const shown = await load();
  return (key) => shown.has(key);
}

export async function rememberShown(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const shown = await load();
  const now = Date.now();
  for (const key of keys) {
    shown.delete(key);
    shown.set(key, now);
  }
  while (shown.size > SHOWN_MAX) {
    const oldest = shown.keys().next().value;
    if (oldest === undefined) break;
    shown.delete(oldest);
  }
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.writing = state.writing
      .then(save)
      .catch((err) => console.warn("[Backgrounds] Could not save the list of shown results:", err));
  }, WRITE_DELAY_MS);
}
