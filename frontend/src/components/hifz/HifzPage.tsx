"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AdjustmentsHorizontalIcon,
  BookOpenIcon,
  CalendarDaysIcon,
  CheckIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  MicrophoneIcon,
  SpeakerWaveIcon,
} from "@heroicons/react/24/outline";
import Spinner from "@/components/ui/Spinner";
import { useLanguage, useT } from "@/lib/LanguageContext";
import { surahEnglishName } from "@/lib/surahEnglishNames";
import { DEFAULT_RECITER_ID, RECITERS, getReciter, reciterHasSurah } from "@/lib/reciterNames";
import { readFavoriteReciters } from "@/lib/favoriteReciters";
import { dueRanges, localDay, type AyahResult, type HifzProgress } from "@/lib/hifzSchedule";
import Dialog from "./Dialog";
import MushafView from "./MushafView";
import { ListenDock, ReadDock, ReciteDock } from "./ModeDock";
import RangeCard from "./RangeCard";
import ReviewCard from "./ReviewCard";
import { useAyahPlayer } from "./useAyahPlayer";
import { useLiveRecitation, type LiveUpdate } from "./useLiveRecitation";
import type { LiveAlert } from "./ModeDock";
import { plainHeard } from "./slipText";
import {
  wordKey,
  type CheckResult,
  type ExtraResult,
  type HideMode,
  type HifzMode,
  type Mistake,
  type Outcome,
  type RangeData,
  type WordResult,
} from "./types";

// The memorization page (/hifz). The reader picks what to do, at any time,
// from the mode bar above the mushaf (2026-11-24, after the user rejected
// the fixed listen → repeat → recite steps):
// - اقرأ لأحفظ (read): the page with its words hidden as much as they like
//   (first letters, every other word, all), an ayah played ×N on demand.
// - سمّع (recite): the ayahs hidden, read from memory from any ayah on,
//   checked live by the Quran ear -- each letter and haraka; a slip shows at
//   once -- and the result goes into the review schedule.
// - استمع (listen): the reciter, the word he is saying lit on the page,
//   each ayah or the whole passage repeated, «ردّد خلفه» pauses, speed.
// The page is the mushaf as printed, with one slim dock of the mode's tools
// at the bottom; a tap on the page's margin hides the bars.

export interface HifzSurah {
  id: number;
  name: string;
  transliteration: string;
  total: number;
}

// Where the reader is and how they like each mode, kept in this browser.
// Progress itself is on the server (api/hifz/progress).
const PREFS_KEY = "kurannuru:hifz";
const PREFS_VERSION = 4;

interface Prefs {
  surah: number;
  from: number;
  to: number;
  mode: HifzMode;
  current: number;
  reciterId: string;
  speed: number;
  zoom: number;
  showWeak: boolean;
  readHide: HideMode;
  readTimes: number;
  reciteStart: number;
  reciteHint: boolean;
  listenTimes: number;
  listenLoop: boolean;
  echo: boolean;
}

const DEFAULT_PREFS: Prefs = {
  surah: 1,
  from: 1,
  to: 7,
  mode: "read",
  current: 1,
  reciterId: DEFAULT_RECITER_ID,
  speed: 1,
  zoom: 1,
  showWeak: true,
  readHide: "show",
  readTimes: 3,
  reciteStart: 1,
  reciteHint: false,
  listenTimes: 1,
  listenLoop: false,
  echo: false,
};

const READ_TIMES = [1, 3, 5, 7, 10];
const LISTEN_TIMES = [1, 2, 3, 5, 0];
const SPEEDS = [1, 1.25, 0.75];
const next = <T,>(list: T[], v: T) => list[(list.indexOf(v) + 1) % list.length];

function readPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    if (saved && typeof saved === "object") {
      if (saved.v !== PREFS_VERSION) {
        // An earlier layout's settings: keep the passage and the voice only.
        const { surah, from, to, reciterId, speed, zoom, showWeak } = { ...DEFAULT_PREFS, ...saved };
        return { ...DEFAULT_PREFS, surah, from, to, current: from, reciteStart: from, reciterId, speed, zoom, showWeak };
      }
      return { ...DEFAULT_PREFS, ...saved };
    }
  } catch {
    // Blocked storage: defaults for this visit.
  }
  const favorite = readFavoriteReciters().find((id) => getReciter(id));
  return { ...DEFAULT_PREFS, reciterId: favorite ?? DEFAULT_RECITER_ID };
}

export default function HifzPage({ surahs }: { surahs: HifzSurah[] }) {
  const tx = useT();
  const { language } = useLanguage();
  const isArabic = language === "ar";

  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  useEffect(() => {
    setPrefs(readPrefs());
    setPrefsLoaded(true);
  }, []);
  useEffect(() => {
    if (!prefsLoaded) return;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, v: PREFS_VERSION }));
    } catch {
      // Not kept: fine.
    }
  }, [prefs, prefsLoaded]);
  const setPref = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => setPrefs((p) => ({ ...p, [key]: value })), []);

  const surah = surahs.find((s) => s.id === prefs.surah) ?? surahs[0];
  const from = Math.min(Math.max(1, prefs.from), surah.total);
  const to = Math.min(Math.max(from, prefs.to), surah.total);
  const current = Math.min(Math.max(from, prefs.current), to);
  const reciteStart = Math.min(Math.max(from, prefs.reciteStart), to);
  const mode = prefs.mode;

  const surahName = useCallback(
    (id: number) => {
      const s = surahs.find((x) => x.id === id);
      if (!s) return "";
      if (isArabic) return s.name;
      if (language === "en") return surahEnglishName(id) ?? s.transliteration;
      return s.transliteration;
    },
    [isArabic, language, surahs]
  );

  // ----- The pages shown -----
  // Whole mushaf pages: the passage's (read, listen), or -- reciting -- the
  // ones a recitation from the start ayah can reach (to the surah's end, or
  // about eight pages: ?session=, which also says how far that is).
  const [data, setData] = useState<RangeData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const loadPages = useCallback(
    async (m: HifzMode, start: number): Promise<RangeData> => {
      const q: Record<string, string> =
        m === "recite"
          ? { surah: String(surah.id), from: String(start), to: String(start), session: String(start) }
          : { surah: String(surah.id), from: String(from), to: String(to), pages: "1" };
      const res = await fetch(`/api/hifz/verses?${new URLSearchParams(q)}`);
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as RangeData;
    },
    [surah.id, from, to]
  );
  useEffect(() => {
    if (!prefsLoaded) return;
    let cancelled = false;
    setLoadError(false);
    const timer = window.setTimeout(async () => {
      try {
        const body = await loadPages(mode, reciteStart);
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadPages, mode, reciteStart, prefsLoaded]);
  // How far one recitation from the start ayah goes.
  const sessionTo = data?.sessionEnd ?? to;

  // The surah's words on the pages, in reading order (another surah's
  // ayahs on the same page are only shown), and each ayah's first word.
  const ownVerses = useMemo(() => (data?.verses ?? []).filter((v) => (v.s ?? surah.id) === surah.id), [data, surah.id]);
  const offsets = useMemo(() => {
    const map = new Map<number, number>();
    let order = 0;
    for (const v of ownVerses) {
      map.set(v.n, order);
      order += v.words.length;
    }
    return { map, total: order };
  }, [ownVerses]);
  const passageWords = useMemo(() => {
    const out: { key: string; ayah: number; text: string }[] = [];
    for (const v of ownVerses) v.words.forEach((w, i) => out.push({ key: wordKey(v.n, i), ayah: v.n, text: w.u }));
    return out;
  }, [ownVerses]);

  // ----- Progress -----
  const [progress, setProgress] = useState<HifzProgress | null>(null);
  useEffect(() => {
    fetch("/api/hifz/progress")
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => p && setProgress(p))
      .catch(() => {});
  }, []);
  const dueCount = useMemo(
    () => (progress ? dueRanges(progress, localDay()).reduce((n, d) => n + d.to - d.from + 1, 0) : 0),
    [progress]
  );
  const markRange = async (state: "known" | "forget") => {
    const res = await fetch("/api/hifz/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "mark", surah: surah.id, from, to, state, today: localDay() }),
    }).catch(() => null);
    if (res?.ok) setProgress(await res.json());
  };

  // ----- The reciter -----
  const reciterId = (() => {
    const r = getReciter(prefs.reciterId);
    return r && reciterHasSurah(r, surah.id) ? r.id : DEFAULT_RECITER_ID;
  })();
  const player = useAyahPlayer({
    reciterId,
    surah: surah.id,
    from,
    to,
    repeatAyah: prefs.listenTimes,
    repeatRange: prefs.listenLoop ? 0 : 1,
    speed: prefs.speed,
    echo: prefs.echo,
  });
  const playing = ["playing", "echo", "loading"].includes(player.status);
  // The passage's recitation gets ready while the reader looks at it.
  useEffect(() => {
    if (prefsLoaded) player.preload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsLoaded, surah.id, from, to, reciterId]);

  // ----- Reciting -----
  const [live, setLive] = useState<LiveUpdate | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [selected, setSelected] = useState<Mistake | null>(null);
  const checkedRef = useRef({ from: 1, to: 1 });
  useEffect(() => () => {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  }, [recordingUrl]);

  const clearCheck = useCallback(() => {
    setLive(null);
    setResult(null);
    setSelected(null);
  }, []);

  const ayahAt = useCallback((order: number) => passageWords[order]?.ayah ?? from, [passageWords, from]);

  const outcomeOf = useCallback(
    (res: CheckResult, base: number): Outcome => {
      let right = 0;
      let read = 0;
      let lastRead = -1;
      let unclear = 0;
      const mistakes: Mistake[] = [];
      res.words.forEach((w, k) => {
        const word = passageWords[base + k];
        if (!word || w.s === "unread") return;
        lastRead = k;
        if (w.s === "unclear") {
          unclear++;
          return;
        }
        read++;
        if (w.s === "ok" || w.s === "tashkeel") right++;
        if (w.s === "wrong" || w.s === "missing" || w.s === "tashkeel") {
          mistakes.push({ order: base + k, key: word.key, ayah: word.ayah, word: word.text, kind: w.s, heard: w.h, x: w.x, d: w.d, t0: w.t0, t1: w.t1 });
        }
      });
      for (const x of res.extras) {
        if (x.kind !== "added") continue;
        const before = passageWords[base + x.after];
        mistakes.push({ order: base + x.after + 0.5, key: `${before?.key ?? "start"}+`, ayah: before?.ayah ?? from, word: "", kind: "added", heard: x.h, t0: x.t0, t1: x.t1 });
      }
      mistakes.sort((a, b) => a.order - b.order);
      const hard = mistakes.filter((m) => m.kind !== "tashkeel").length;
      const reachedAyah = lastRead >= 0 ? ayahAt(base + lastRead) : checkedRef.current.from;
      return {
        total: read,
        right,
        mistakes,
        passed: read > 0 && hard === 0,
        reachedAyah,
        unclear,
        fixed: (res.fixed ?? [])
          .map((f) => {
            const word = passageWords[base + f.w];
            if (!word || (f.s !== "wrong" && f.s !== "tashkeel" && f.s !== "missing")) return null;
            return { order: base + f.w, key: word.key, ayah: word.ayah, word: word.text, kind: f.s, heard: f.h, x: f.x, d: f.d, corrected: true } as Mistake;
          })
          .filter((m): m is Mistake => m !== null),
        stoppedEarly: lastRead < res.words.length - 1,
        nextAyah: lastRead >= 0 && ayahAt(base + lastRead + 1) === reachedAyah && base + lastRead + 1 < passageWords.length ? reachedAyah : reachedAyah + 1,
      };
    },
    [ayahAt, from, passageWords]
  );

  // The review schedule gets the ayahs read to their end.
  const ayahResults = useCallback(
    (res: CheckResult, a1: number, a2: number): AyahResult[] => {
      const out: AyahResult[] = [];
      let k = 0;
      for (let n = a1; n <= a2; n++) {
        const size = ownVerses.find((v) => v.n === n)?.words.length ?? 0;
        const first = k;
        const r: AyahResult = { ayah: n, total: size, ok: 0, wrong: 0, missing: 0, added: 0, weak: [] };
        let unread = 0;
        for (let i = 0; i < size; i++, k++) {
          const w = res.words[k];
          if (!w || w.s === "unread") unread++;
          else if (w.s === "ok") r.ok++;
          else if (w.s === "tashkeel") {
            r.ok++;
            r.weak.push(i);
          } else {
            if (w.s === "wrong") r.wrong++;
            else r.missing++;
            r.weak.push(i);
          }
        }
        r.added = res.extras.filter((x) => x.kind === "added" && (x.after === -1 ? first === 0 : x.after >= first && x.after < k)).length;
        if (size && unread === 0) out.push(r);
      }
      return out;
    },
    [ownVerses]
  );

  const onFinal = useCallback(
    async (checked: CheckResult, recording: Blob) => {
      setLive(null);
      setRecordingUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(recording);
      });
      setResult(checked);
      setSelected(null);
      const { from: a1, to: a2 } = checkedRef.current;
      const results = ayahResults(checked, a1, a2);
      if (results.length) {
        const saved = await fetch("/api/hifz/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "review", surah: surah.id, today: localDay(), results }),
        }).catch(() => null);
        if (saved?.ok) setProgress(await saved.json());
      }
    },
    [ayahResults, surah.id]
  );
  const recorder = useLiveRecitation({ onUpdate: setLive, onFinal });

  // ----- What the mushaf shows -----
  const checkBase = offsets.map.get(checkedRef.current.from) ?? 0;
  const shown = mode === "recite" ? result ?? live : null;
  const passageResults = useMemo(() => {
    if (!shown) return null;
    const arr: (WordResult | undefined)[] = new Array(offsets.total);
    shown.words.forEach((w, k) => {
      arr[checkBase + k] = w;
    });
    return arr as WordResult[];
  }, [shown, offsets.total, checkBase]);
  const passageExtras = useMemo<ExtraResult[] | null>(
    () => (shown ? shown.extras.map((x) => ({ ...x, after: x.after === -1 ? checkBase - 1 : checkBase + x.after })) : null),
    [shown, checkBase]
  );
  // The ayahs in play: the passage, or the recitation's reach.
  const activeFrom = mode === "recite" ? (shown ? checkedRef.current.from : reciteStart) : from;
  const activeTo = mode === "recite" ? (shown ? checkedRef.current.to : sessionTo) : to;
  const hiddenAyahs = useMemo(() => {
    const out = new Set<number>();
    if ((mode === "read" && prefs.readHide !== "show") || mode === "recite") {
      for (const v of ownVerses) if (v.n >= activeFrom && v.n <= activeTo) out.add(v.n);
    }
    return out;
  }, [mode, prefs.readHide, ownVerses, activeFrom, activeTo]);
  // While reciting, the page follows the reader: the last word heard.
  const followKey = useMemo(() => {
    if (!live || mode !== "recite") return null;
    let last = -1;
    live.words.forEach((w, k) => {
      if (w.s !== "unread") last = k;
    });
    return last >= 0 ? passageWords[checkBase + last]?.key ?? null : null;
  }, [live, mode, passageWords, checkBase]);
  const hideMode: Exclude<HideMode, "show"> =
    mode === "recite" ? (prefs.reciteHint ? "hint" : "hide") : prefs.readHide === "show" ? "hide" : prefs.readHide;
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  useEffect(() => setRevealed(new Set()), [mode, prefs.readHide, surah.id, from, to]);
  const weak = useMemo(() => {
    if (!progress || !prefs.showWeak || shown) return null;
    const out: Record<string, number> = {};
    for (let a = from; a <= to; a++) {
      for (const [i, n] of Object.entries(progress.ayahs[`${surah.id}:${a}`]?.weak ?? {})) out[wordKey(a, Number(i))] = n;
    }
    return out;
  }, [progress, prefs.showWeak, shown, surah.id, from, to]);
  const activeWord = player.ayah !== null && player.word >= 0 && player.status === "playing" ? wordKey(player.ayah, player.word) : null;

  // While reciting: words said right, and the latest slip.
  const liveInfo = useMemo(() => {
    if (!live) return { right: 0, alert: null as LiveAlert | null, hard: 0 };
    let right = 0;
    let hard = 0;
    let alert: LiveAlert | null = null;
    live.words.forEach((w, k) => {
      const word = passageWords[checkBase + k];
      if (w.s === "ok" || w.s === "tashkeel") right++;
      if (!word) return;
      if (w.s === "wrong") {
        hard++;
        alert = { label: tx("انتبه:", "Dikkat:", "Check:"), word: word.text, x: w.x, d: w.d, kind: "wrong" };
      } else if (w.s === "missing") {
        hard++;
        alert = { label: tx("نسيتَ:", "Atlandı:", "Left out:"), word: word.text, kind: "missing" };
      } else if (w.s === "tashkeel") {
        alert = { label: tx("انتبه للحركة:", "Harekeye dikkat:", "Mind the vowel:"), word: word.text, x: w.x, d: w.d, kind: "tashkeel" };
      }
    });
    for (const x of live.extras) {
      if (x.kind === "added") {
        hard++;
        alert = { label: tx("زيادة:", "Fazladan:", "Added:"), word: plainHeard(x.h), kind: "added" };
      }
    }
    return { right, alert, hard };
  }, [live, passageWords, checkBase, tx]);
  // A new slip: a short buzz on a phone.
  const hardRef = useRef(0);
  useEffect(() => {
    if (liveInfo.hard > hardRef.current && recorder.recording) navigator.vibrate?.(90);
    hardRef.current = liveInfo.hard;
  }, [liveInfo.hard, recorder.recording]);

  // The ear gets ready as soon as «سمّع» is open, and stays ready while the
  // page is in view and in use (the backend frees idle models after 10
  // minutes; once freed, the first words of a recitation showed about 5 s
  // late). Untouched for 15 minutes, or left, it lets the ear go: kept ready
  // all the time it held 3.7 GB of the laptop's memory (2026-11-26).
  useEffect(() => {
    if (!prefsLoaded || mode !== "recite") return;
    let lastUse = Date.now();
    const used = () => {
      lastUse = Date.now();
    };
    // With the surah and start: its text is readied too (2 s for a long surah).
    const warm = () => {
      if (document.visibilityState === "visible" && Date.now() - lastUse < 15 * 60_000)
        fetch(`/api/hifz/warm?surah=${surah.id}&start=${reciteStart}`, { method: "POST" }).catch(() => {});
    };
    const back = () => {
      if (document.visibilityState === "visible") {
        used();
        warm();
      }
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    warm();
    const timer = window.setInterval(warm, 4 * 60_000);
    document.addEventListener("visibilitychange", back);
    events.forEach((e) => window.addEventListener(e, used, { passive: true }));
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
      events.forEach((e) => window.removeEventListener(e, used));
    };
  }, [prefsLoaded, mode, surah.id, reciteStart]);

  // ----- Moving around -----
  const halt = useCallback(() => {
    player.stop();
    recorder.cancel();
  }, [player, recorder]);

  const goMode = useCallback(
    (m: HifzMode, start?: number) => {
      halt();
      clearCheck();
      setPrefs((p) => ({ ...p, mode: m, ...(start !== undefined ? { reciteStart: start } : {}) }));
    },
    [clearCheck, halt]
  );

  const selectRange = useCallback(
    (surahId: number, a: number, b: number, m?: HifzMode) => {
      const s = surahs.find((x) => x.id === surahId);
      if (!s) return;
      const lo = Math.min(Math.max(1, a), s.total);
      const hi = Math.min(Math.max(lo, b), s.total);
      halt();
      clearCheck();
      setPrefs((p) => ({ ...p, surah: s.id, from: lo, to: hi, current: lo, reciteStart: lo, ...(m ? { mode: m } : {}) }));
    },
    [clearCheck, halt, surahs]
  );

  const onNextPassage = () => {
    const size = to - from + 1;
    if (to < surah.total) selectRange(surah.id, to + 1, to + size);
    else {
      const nextSurah = surahs.find((s) => s.id === surah.id + 1);
      if (nextSurah) selectRange(nextSurah.id, 1, Math.min(nextSurah.total, size));
    }
  };

  // One press: the reading goes on from `start` as far as the reader likes
  // -- ayah after ayah, page after page, to the surah's end (or the
  // recitation's limit, about eight pages) -- and stops when they say.
  const recite = async (start: number) => {
    player.stop();
    clearCheck();
    let pages = data;
    if (start !== reciteStart || pages?.sessionEnd === undefined) {
      try {
        pages = await loadPages("recite", start);
      } catch {
        setLoadError(true);
        return;
      }
      setData(pages);
      setPref("reciteStart", start);
    }
    const end = pages?.sessionEnd ?? start;
    checkedRef.current = { from: start, to: end };
    recorder.start(surah.id, start, end);
  };
  // After a whole recitation: on from where it could go no further, or the next surah.
  const onRecitationEnd = () => {
    const end = checkedRef.current.to;
    if (end < surah.total) recite(end + 1);
    else {
      const nextSurah = surahs.find((x) => x.id === surah.id + 1);
      if (nextSurah) selectRange(nextSurah.id, 1, Math.min(nextSurah.total, to - from + 1), "recite");
    }
  };

  // The reader's own recording, played at one place.
  const selfRef = useRef<HTMLAudioElement | null>(null);
  const selfStopRef = useRef<number | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      const el = selfRef.current;
      if (el && !el.paused && selfStopRef.current !== null && el.currentTime >= selfStopRef.current) el.pause();
    }, 50);
    return () => {
      window.clearInterval(id);
      selfRef.current?.pause();
    };
  }, []);
  const playSelf = (t0?: number, t1?: number) => {
    if (!recordingUrl) return;
    player.stop();
    if (!selfRef.current) selfRef.current = new Audio();
    const el = selfRef.current;
    if (el.src !== recordingUrl) el.src = recordingUrl;
    el.currentTime = t0 !== undefined ? Math.max(0, t0 - 0.4) : 0;
    selfStopRef.current = t1 !== undefined ? t1 + 0.4 : null;
    el.play().catch(() => {});
  };

  const micError =
    recorder.error === "too_long"
      ? tx("المقطع طويل جداً للتسميع مرة واحدة. اختر آيات أقل.", "Bölüm tek seferde okumak için çok uzun. Daha az ayet seçin.", "Too long to check at once. Choose fewer ayahs.")
      : recorder.error === "failed"
        ? tx("تعذّر تصحيح القراءة الآن، حاول مرة أخرى.", "Okuma şu an kontrol edilemedi, tekrar deneyin.", "Couldn't check the reading right now, try again.")
        : recorder.error === "unsupported"
          ? tx(
              "الميكروفون غير متاح في هذه الصفحة. المتصفح لا يسمح به إلا عبر https أو من نفس الحاسوب (localhost).",
              "Mikrofon bu sayfada kullanılamıyor. Tarayıcı yalnızca https üzerinden ya da aynı bilgisayardan (localhost) izin veriyor.",
              "The microphone isn't available here. Browsers only allow it over https or on this computer (localhost)."
            )
          : recorder.error === "refused"
            ? tx("لم يُسمح باستخدام الميكروفون. اسمح به من شريط العنوان ثم أعد المحاولة.", "Mikrofon izni verilmedi. Adres çubuğundan izin verip tekrar deneyin.", "Microphone access was refused. Allow it from the address bar and try again.")
            : recorder.error === "silent"
              ? tx("لم أسمع قراءة. قرّب الميكروفون واقرأ بصوت واضح.", "Bir okuma duyulmadı. Mikrofona yaklaşıp net okuyun.", "No reading was heard. Come closer to the microphone.")
              : null;
  const playerError =
    player.status === "error"
      ? player.error === "too_long"
        ? tx("المقطع طويل للاستماع دفعة واحدة. اختر آيات أقل.", "Bölüm bir seferde dinlemek için uzun. Daha az ayet seçin.", "Too long to play at once. Choose fewer ayahs.")
        : tx("تعذّر تجهيز التلاوة الآن. تحقق من الإنترنت ثم أعد المحاولة.", "Tilavet şu an hazırlanamadı. İnterneti kontrol edip tekrar deneyin.", "Couldn't prepare the recitation. Check the connection and try again.")
      : null;

  const [dialog, setDialog] = useState<"passage" | "review" | "settings" | null>(null);
  // A tap on the page's margin hides the bars, for the page alone.
  const [chrome, setChrome] = useState(true);
  const barsShown = chrome || recorder.recording || recorder.finishing;

  const reciterOptions = useMemo(() => {
    const favorites = readFavoriteReciters();
    const rank = (id: string) => {
      const k = favorites.indexOf(id);
      return k < 0 ? favorites.length : k;
    };
    return RECITERS.filter((r) => reciterHasSurah(r, surah.id))
      .sort((a, b) => rank(a.id) - rank(b.id))
      .map((r) => ({
        value: r.id,
        label: `${favorites.includes(r.id) ? "★ " : ""}${isArabic ? r.labelAr ?? r.nameAr : r.labelLatin ?? r.nameLatin}`,
      }));
  }, [isArabic, surah.id]);

  const outcome = mode === "recite" && result ? outcomeOf(result, checkBase) : null;
  // The result opens on its first slip, explained (said / should be).
  useEffect(() => {
    if (!result || mode !== "recite") return;
    const o = outcomeOf(result, checkBase);
    setSelected((prev) => prev ?? o.mistakes.find((m) => m.kind !== "added") ?? o.fixed[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  // Words put right by going back: marked on the page.
  const correctedOrders = useMemo(() => {
    const src = mode === "recite" ? (result ?? live) : null;
    return new Set((src?.fixed ?? []).map((f) => checkBase + f.w));
  }, [mode, result, live, checkBase]);
  const rangeText = from === to ? `${from}` : `${from}–${to}`;

  const modes: { id: HifzMode; label: string; short: string; Icon: typeof BookOpenIcon }[] = [
    { id: "read", label: tx("اقرأ لأحفظ", "Ezberle", "Memorize"), short: tx("اقرأ", "Ezberle", "Read"), Icon: BookOpenIcon },
    { id: "recite", label: tx("سمّع ما حفظت", "Ezberden oku", "Recite"), short: tx("سمّع", "Oku", "Recite"), Icon: MicrophoneIcon },
    { id: "listen", label: tx("استمع", "Dinle", "Listen"), short: tx("استمع", "Dinle", "Listen"), Icon: SpeakerWaveIcon },
  ];
  const iconButton =
    "relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary";

  return (
    <div dir={isArabic ? "rtl" : "ltr"}>
      {/* The passage, the mode, reviews and settings: always at hand. */}
      <div
        className={`sticky top-16 z-40 -mx-4 bg-background/90 px-4 pb-2 pt-2 backdrop-blur-xl transition-[transform,opacity] duration-300 sm:top-20 lg:top-24 ${
          barsShown ? "" : "pointer-events-none -translate-y-4 opacity-0"
        }`}
      >
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-2 gap-y-2">
          <button
            type="button"
            onClick={() => setDialog("passage")}
            className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full px-3 transition-colors hover:bg-primary/10 sm:flex-none"
          >
            <span className="truncate text-[15px] font-bold text-foreground">{isArabic ? `سورة ${surah.name}` : surahName(surah.id)}</span>
            <span className="flex-shrink-0 text-sm tabular-nums text-muted-foreground">{rangeText}</span>
            <ChevronDownIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          </button>

          <div
            role="tablist"
            aria-label={tx("ماذا تريد الآن؟", "Ne yapmak istersiniz?", "What would you like to do?")}
            className="order-last flex w-full rounded-full bg-foreground/[0.05] p-1 dark:bg-white/[0.06] sm:order-none sm:mx-auto sm:w-auto"
          >
            {modes.map(({ id, label, short, Icon }) => {
              const active = mode === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => !active && goMode(id)}
                  className={`flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold transition-colors sm:flex-none sm:px-4 ${
                    active ? "bg-primary text-white shadow-sm dark:text-background" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-[18px] w-[18px] flex-shrink-0" />
                  <span className="sm:hidden">{short}</span>
                  <span className="hidden sm:inline">{label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-shrink-0 items-center">
            <button type="button" onClick={() => setDialog("review")} className={iconButton} title={tx("مراجعتي", "Tekrarlarım", "My reviews")} aria-label={tx("مراجعتي", "Tekrarlarım", "My reviews")}>
              <CalendarDaysIcon className="h-[22px] w-[22px]" />
              {dueCount > 0 && (
                <span className="absolute end-0 top-0 min-w-[1.1rem] rounded-full bg-accent-red px-1 text-center text-[10px] font-bold leading-[1.1rem] text-white">
                  {dueCount}
                </span>
              )}
            </button>
            <button type="button" onClick={() => setDialog("settings")} className={iconButton} title={tx("الإعدادات", "Ayarlar", "Settings")} aria-label={tx("الإعدادات", "Ayarlar", "Settings")}>
              <AdjustmentsHorizontalIcon className="h-[22px] w-[22px]" />
            </button>
          </div>
        </div>
      </div>

      {/* The mushaf page. A tap outside the words shows or hides the bars. */}
      <div
        className="mx-auto max-w-3xl pb-60 pt-3"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("[data-unit]") && !recorder.recording) setChrome((c) => !c);
        }}
      >
        <div className="mushaf-page !mx-0 !my-0 px-3 py-6 sm:px-8 sm:py-9 md:px-12">
          {data ? (
            <MushafView
              data={data}
              surah={surah.id}
              surahNameAr={(id) => surahs.find((x) => x.id === id)?.name ?? ""}
              activeFrom={activeFrom}
              activeTo={activeTo}
              followKey={followKey}
              hiddenAyahs={hiddenAyahs}
              hideMode={hideMode}
              focusAyah={mode === "read" && !playing ? current : null}
              activeWord={mode === "recite" ? null : activeWord}
              revealed={revealed}
              results={passageResults}
              extras={passageExtras}
              live={!result && Boolean(live)}
              reached={live && !result ? checkBase + live.stop : -1}
              blank={mode === "recite"}
              corrected={correctedOrders}
              playingAyah={playing && mode !== "recite" ? player.ayah : null}
              weak={weak}
              selectedKey={selected?.key ?? null}
              zoom={prefs.zoom}
              onWordTap={(key) => {
                if (hiddenAyahs.size) {
                  setRevealed((prev) => {
                    const nextSet = new Set(prev);
                    if (nextSet.has(key)) nextSet.delete(key);
                    else nextSet.add(key);
                    return nextSet;
                  });
                }
              }}
              onAyahTap={(n) => {
                if (mode === "read") {
                  if (n < from || n > to) return;
                  player.stop();
                  setPref("current", n);
                } else if (mode === "listen") {
                  if (n >= from && n <= to) player.play(n);
                } else if (!recorder.recording && !recorder.finishing) {
                  clearCheck();
                  setPref("reciteStart", n);
                }
              }}
            />
          ) : loadError ? (
            <p className="py-10 text-center text-sm text-accent-red">{tx("تعذّر تحميل الآيات.", "Ayetler yüklenemedi.", "Couldn't load the ayahs.")}</p>
          ) : (
            <div className="flex justify-center py-16">
              <Spinner size="lg" />
            </div>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground/80">
          {mode === "read"
            ? tx("اضغط على رقم الآية لاختيارها، وعلى الكلمة المخفية لتراها.", "Ayeti seçmek için numarasına, gizli kelimeyi görmek için üstüne dokunun.", "Tap an ayah number to pick it, a hidden word to see it.")
            : mode === "recite"
              ? tx("اضغط على رقم آية لتبدأ التسميع منها.", "Oradan başlamak için bir ayet numarasına dokunun.", "Tap an ayah number to start reciting from there.")
              : tx("اضغط على رقم آية ليبدأ القارئ منها.", "Kari oradan başlasın diye ayet numarasına dokunun.", "Tap an ayah number to play from there.")}
        </p>
      </div>

      {/* The mode's tools. */}
      <div
        className={`fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-[transform,opacity] duration-300 ${
          barsShown ? "" : "pointer-events-none translate-y-6 opacity-0"
        }`}
      >
        <div className="custom-scrollbar mx-auto max-h-[70dvh] max-w-xl overflow-y-auto rounded-[1.75rem] border border-border/70 bg-surface/95 p-3 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.35)] backdrop-blur-xl">
          {mode === "read" ? (
            <ReadDock
              hide={prefs.readHide}
              onHide={(h) => setPref("readHide", h)}
              current={current}
              from={from}
              to={to}
              onAyah={(n) => {
                player.stop();
                setPref("current", n);
              }}
              times={prefs.readTimes}
              onTimes={() => setPref("readTimes", next(READ_TIMES, prefs.readTimes))}
              playing={playing}
              preparing={player.status === "preparing" && player.ayah !== null}
              rep={player.rep}
              playerError={playerError}
              onPlay={() => player.play(current, { times: prefs.readTimes })}
              onStop={player.stop}
              onReciteThis={() => goMode("recite", current)}
            />
          ) : mode === "recite" ? (
            <ReciteDock
              start={reciteStart}
              from={1}
              to={surah.total}
              onStart={(n) => {
                clearCheck();
                setPref("reciteStart", n);
              }}
              hint={prefs.reciteHint}
              onHint={() => setPref("reciteHint", !prefs.reciteHint)}
              recording={recorder.recording}
              finishing={recorder.finishing}
              level={recorder.level}
              elapsed={recorder.elapsed}
              micError={micError}
              liveAlert={liveInfo.alert}
              quiet={Boolean(live?.quiet)}
              repeating={Boolean(live && (live.repeating ?? live.extras.some((x) => x.kind === "restart" && x.t1 >= (live.duration ?? 0) - 4)))}
              liveRight={liveInfo.right}
              onRecite={() => recite(result ? checkedRef.current.from : reciteStart)}
              onStop={recorder.stop}
              onCancel={() => {
                recorder.cancel();
                clearCheck();
              }}
              outcome={outcome}
              selected={selected}
              onSelect={setSelected}
              canPlaySelf={Boolean(recordingUrl)}
              onPlaySelf={playSelf}
              onHearAyah={(n) => {
                selfRef.current?.pause();
                player.play(n, { times: 1 });
              }}
              onContinue={(n) => recite(n)}
              onNextLesson={onRecitationEnd}
              nextLabel={
                checkedRef.current.to < surah.total
                  ? tx(`تابع من ${checkedRef.current.to + 1}`, `${checkedRef.current.to + 1}. ayetten devam`, `Go on from ${checkedRef.current.to + 1}`)
                  : tx("السورة التالية", "Sonraki sure", "Next surah")
              }
              onDone={clearCheck}
            />
          ) : (
            <ListenDock
              status={player.status}
              ayah={player.ayah}
              rep={player.rep}
              from={from}
              to={to}
              ayahTimes={prefs.listenTimes}
              onAyahTimes={() => setPref("listenTimes", next(LISTEN_TIMES, prefs.listenTimes))}
              loop={prefs.listenLoop}
              onLoop={() => setPref("listenLoop", !prefs.listenLoop)}
              speed={prefs.speed}
              onSpeed={() => setPref("speed", next(SPEEDS, prefs.speed))}
              echo={prefs.echo}
              onEcho={() => setPref("echo", !prefs.echo)}
              playerError={playerError}
              onToggle={() => {
                if (player.status === "paused") player.resume();
                else if (["playing", "echo", "loading", "preparing"].includes(player.status) && player.ayah !== null) player.pause();
                else player.play();
              }}
              onStep={player.step}
            />
          )}
        </div>
      </div>

      {dialog === "passage" && (
        <Dialog
          title={tx("ماذا تحفظ؟", "Ne ezberleyeceksiniz?", "What to memorize?")}
          subtitle={tx("ابحث عن آية، أو اختر السورة والآيات.", "Bir ayet arayın ya da sure ve ayetleri seçin.", "Search for an ayah, or pick the surah and ayahs.")}
          icon={<BookOpenIcon className="h-5 w-5" />}
          onClose={() => setDialog(null)}
          footer={
            <button
              type="button"
              onClick={() => setDialog(null)}
              className="flex h-12 w-full items-center justify-center rounded-2xl bg-primary text-[15px] font-semibold text-white shadow-sm transition-colors hover:bg-primary-dark dark:text-background"
            >
              {tx(`تم: ${isArabic ? `سورة ${surah.name}` : surahName(surah.id)} ${rangeText}`, `Tamam: ${surahName(surah.id)} ${rangeText}`, `Done: ${surahName(surah.id)} ${rangeText}`)}
            </button>
          }
        >
          <RangeCard
            bare
            surahs={surahs}
            surahName={surahName}
            surah={surah}
            from={from}
            to={to}
            onSelect={(s, a, b) => selectRange(s, a, b)}
            progress={progress}
            onMark={markRange}
          />
        </Dialog>
      )}

      {dialog === "review" && (
        <Dialog
          title={tx("مراجعتي", "Tekrarlarım", "My reviews")}
          subtitle={tx("ما حان وقت مراجعته اليوم، وآخر تسميعاتك.", "Bugün tekrar zamanı gelenler ve son okumalarınız.", "What's due today, and your latest recitations.")}
          icon={<CalendarDaysIcon className="h-5 w-5" />}
          onClose={() => setDialog(null)}
        >
          {progress && Object.keys(progress.ayahs).length > 0 ? (
            <ReviewCard
              bare
              progress={progress}
              surahs={surahs}
              surahName={surahName}
              onStart={(s, a, b) => {
                selectRange(s, a, b, "recite");
                setDialog(null);
              }}
            />
          ) : (
            <p className="text-[15px] leading-relaxed text-muted-foreground">
              {tx(
                "لا مراجعات بعد. كل آية تسمّعها إلى آخرها تُضاف هنا، وتعود إليك في وقت مراجعتها.",
                "Henüz tekrar yok. Sonuna kadar ezberden okuduğunuz her ayet buraya eklenir ve zamanı gelince karşınıza çıkar.",
                "No reviews yet. Every ayah you recite to its end shows up here when it's due."
              )}
            </p>
          )}
        </Dialog>
      )}

      {dialog === "settings" && (
        <Dialog title={tx("الإعدادات", "Ayarlar", "Settings")} icon={<AdjustmentsHorizontalIcon className="h-5 w-5" />} onClose={() => setDialog(null)}>
          <div className="space-y-6">
            <section className="space-y-2.5">
              <h3 className="text-[15px] font-semibold text-foreground">{tx("القارئ", "Kari", "Reciter")}</h3>
              <ReciterPicker options={reciterOptions} value={reciterId} onChange={(v) => setPref("reciterId", v)} />
            </section>

            <section className="flex items-center justify-between gap-4 rounded-2xl bg-foreground/[0.03] px-4 py-3 dark:bg-white/[0.04]">
              <div>
                <h3 className="text-[15px] font-semibold text-foreground">{tx("حجم خط المصحف", "Mushaf yazı boyutu", "Mushaf text size")}</h3>
                <p className="text-xs text-muted-foreground">{tx("يُضبط تلقائياً على عرض الشاشة، وهذا تكبير فوقه.", "Ekran genişliğine göre ayarlanır; bu, üstüne büyütmedir.", "Fitted to the screen; this zooms on top.")}</p>
              </div>
              <div className="flex flex-shrink-0 items-center rounded-full border border-border bg-surface" dir="ltr">
                <button type="button" onClick={() => setPref("zoom", Math.max(0.7, Math.round((prefs.zoom - 0.1) * 10) / 10))} disabled={prefs.zoom <= 0.7} className="flex h-10 w-10 items-center justify-center rounded-full text-lg font-semibold text-muted-foreground hover:text-primary disabled:opacity-30" aria-label={tx("تصغير", "Küçült", "Smaller")}>
                  −
                </button>
                <span className="w-14 text-center text-sm font-semibold tabular-nums">{Math.round(prefs.zoom * 100)}%</span>
                <button type="button" onClick={() => setPref("zoom", Math.min(1.8, Math.round((prefs.zoom + 0.1) * 10) / 10))} disabled={prefs.zoom >= 1.8} className="flex h-10 w-10 items-center justify-center rounded-full text-lg font-semibold text-muted-foreground hover:text-primary disabled:opacity-30" aria-label={tx("تكبير", "Büyüt", "Larger")}>
                  +
                </button>
              </div>
            </section>

            <section className="flex items-center justify-between gap-4 rounded-2xl bg-foreground/[0.03] px-4 py-3 dark:bg-white/[0.04]">
              <div>
                <h3 className="text-[15px] font-semibold text-foreground">{tx("علامة الكلمات الضعيفة", "Zayıf kelime işareti", "Mark weak words")}</h3>
                <p className="text-xs text-muted-foreground">{tx("نقطة تحت الكلمات التي أخطأت فيها سابقاً (لا تظهر أثناء التسميع).", "Daha önce hata yapılan kelimelerin altında nokta (ezberden okurken görünmez).", "A dot under words you slipped on before (hidden while reciting).")}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={prefs.showWeak}
                onClick={() => setPref("showWeak", !prefs.showWeak)}
                className={`relative h-7 w-12 flex-shrink-0 rounded-full transition-colors ${prefs.showWeak ? "bg-primary" : "bg-foreground/15"}`}
              >
                <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${prefs.showWeak ? "start-6" : "start-1"}`} />
              </button>
            </section>
          </div>
        </Dialog>
      )}
    </div>
  );
}

// The reciters, listed in the settings window (a dropdown's list was cut off
// inside it): a search box, favourites first, the chosen one marked.
function ReciterPicker({ options, value, onChange }: { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
  const tx = useT();
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>("[aria-selected=true]");
    if (list && el) list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
  }, []);
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3.5">
        <MagnifyingGlassIcon className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tx("ابحث عن قارئ", "Kari ara", "Search reciters")}
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div ref={listRef} role="listbox" className="custom-scrollbar relative h-64 overflow-y-auto p-1.5">
        {shown.length ? (
          shown.map((o) => {
            const active = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => onChange(o.value)}
                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-start text-[15px] transition-colors ${
                  active ? "bg-primary/10 font-semibold text-primary-dark dark:text-primary-light" : "text-foreground hover:bg-foreground/[0.05]"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {active && <CheckIcon className="h-5 w-5 flex-shrink-0" />}
              </button>
            );
          })
        ) : (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">{tx("لا يوجد قارئ بهذا الاسم.", "Bu isimde kari yok.", "No reciter by that name.")}</p>
        )}
      </div>
    </div>
  );
}
