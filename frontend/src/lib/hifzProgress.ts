import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import {
  MAX_SESSIONS,
  emptyProgress,
  markKnown,
  review,
  type AyahResult,
  type HifzProgress,
} from "@/lib/hifzSchedule";

// The memorization progress on the server (src/data/hifz-progress.json), so
// the phone and the computer see the same reviews. One file for the one
// person using this app; writes go one at a time and replace the file
// whole (a crash mid-write leaves the old one).

const FILE = path.join(process.cwd(), "src", "data", "hifz-progress.json");

let queue: Promise<unknown> = Promise.resolve();

export async function readProgress(): Promise<HifzProgress> {
  try {
    const data = JSON.parse(await fs.readFile(FILE, "utf8")) as HifzProgress;
    if (data && data.version === 1 && data.ayahs && Array.isArray(data.sessions)) return data;
  } catch {
    // No file yet (or unreadable): start empty.
  }
  return emptyProgress();
}

async function write(progress: HifzProgress) {
  const tmp = `${FILE}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(progress));
    await fs.rename(tmp, FILE);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

function update(change: (p: HifzProgress) => void): Promise<HifzProgress> {
  const run = queue.then(async () => {
    const progress = await readProgress();
    change(progress);
    await write(progress);
    return progress;
  });
  queue = run.catch(() => {});
  return run;
}

/** Records one recitation check: each ayah that was reached, and the session. */
export function recordReview(surah: number, results: AyahResult[], today: string) {
  return update((p) => {
    let words = 0;
    let ok = 0;
    let mistakes = 0;
    for (const r of results) {
      const key = `${surah}:${r.ayah}`;
      p.ayahs[key] = review(p.ayahs[key], r, today);
      words += r.total;
      ok += r.ok;
      mistakes += r.wrong + r.missing + r.added;
    }
    if (results.length) {
      p.sessions.unshift({
        date: today,
        surah,
        from: Math.min(...results.map((r) => r.ayah)),
        to: Math.max(...results.map((r) => r.ayah)),
        score: words ? Math.round((ok / words) * 1000) / 1000 : 0,
        words,
        mistakes,
      });
      p.sessions = p.sessions.slice(0, MAX_SESSIONS);
    }
  });
}

/** Marks ayahs as already memorized, or forgets their progress. */
export function markAyahs(surah: number, from: number, to: number, state: "known" | "forget", today: string) {
  return update((p) => {
    for (let a = from; a <= to; a++) {
      const key = `${surah}:${a}`;
      if (state === "forget") delete p.ayahs[key];
      else p.ayahs[key] = markKnown(today);
    }
  });
}
