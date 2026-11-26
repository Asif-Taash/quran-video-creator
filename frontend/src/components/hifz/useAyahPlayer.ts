"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Listen and repeat (the memorization page): plays the chosen ayahs in a
// reciter's voice, each ayah `repeatAyah` times, the whole range
// `repeatRange` times (0 = until stopped; repeatAyah 0 too), at `speed`, and -- with `echo`
// -- leaves a silence after each ayah as long as the ayah, for the reader
// to say it back.
//
// The ayahs are cut from the reciter's recording by the video's aligner
// (api/hifz/prepare): its ayah boundaries come from the audio itself, so an
// ayah never runs into the next one's first words -- mp3quran's own timing,
// used at first, is seconds off for many reciters (2026-11-21). The first
// time a range is played it is prepared (seconds); after that the backend
// has the cut ready. The cut is fetched whole and played from memory.

export interface PlayerSettings {
  reciterId: string;
  surah: number;
  from: number;
  to: number;
  repeatAyah: number;
  repeatRange: number;
  speed: number;
  echo: boolean;
}

interface Prepared {
  key: string;
  url: string;
  // Ayah -> [start, end] seconds in the cut.
  ayahs: Record<string, [number, number]>;
  // Ayah -> each word's [start, end], when the aligner's words match the page's.
  words: Record<string, [number, number][]>;
}

export type PlayerStatus = "idle" | "preparing" | "loading" | "playing" | "echo" | "paused" | "error";

// One ayah N times (the memorization steps): "listen ×3", "repeat after
// him ×3" (echo: a silence after each time, as long as the ayah).
export interface PlayOptions {
  only?: boolean;
  times?: number;
  echo?: boolean;
}
export type PlayerError = "unavailable" | "too_long";

// After an ayah's last word, a little of its tail (a madd fading out) --
// never into the next ayah.
const TAIL_SEC = 0.15;
const LEAD_SEC = 0.04;
// Prepared cuts kept in memory (blob URLs).
const KEEP = 4;

export function useAyahPlayer(settings: PlayerSettings) {
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [ayah, setAyah] = useState<number | null>(null);
  const [rep, setRep] = useState(0);
  const [round, setRound] = useState(0);
  const [error, setError] = useState<PlayerError | null>(null);
  // Bumped each time a playback ends by itself (not stopped): the steps
  // move on when "listen ×3" is over.
  const [finished, setFinished] = useState(0);
  // The word being recited (index in the playing ayah), -1 between words
  // or when the word times aren't known.
  const [word, setWord] = useState(-1);
  const wordRef = useRef(-1);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const posRef = useRef({ ayah: 0, rep: 0, round: 0 });
  const preparedRef = useRef<Prepared[]>([]);
  const currentRef = useRef<Prepared | null>(null);
  // Stop time (seconds in the cut) of the ayah playing.
  const stopAtRef = useRef<number | null>(null);
  // Every start/stop bumps it: a stale timer, fetch or event then does nothing.
  const ticketRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // Playing one ayah (times, echo) instead of the range.
  const onlyRef = useRef(false);
  const optsRef = useRef<PlayOptions>({});
  const preparingRef = useRef<{ key: string; promise: Promise<Prepared | null> } | null>(null);
  const jobRef = useRef<string | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  const audio = () => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
    }
    return audioRef.current;
  };

  // A preparation in flight is cancelled on the backend when it's no longer wanted.
  const cancelJob = () => {
    const job = jobRef.current;
    jobRef.current = null;
    if (job) fetch(`/api/video/prepare-audio/job?jobId=${job}`, { method: "DELETE" }).catch(() => {});
  };

  const stop = useCallback(() => {
    ticketRef.current++;
    clearTimer();
    cancelJob();
    // Its job is cancelled now: the next play must start a new one, not wait
    // on this one (that ended in 409 and showed "unavailable").
    preparingRef.current = null;
    stopAtRef.current = null;
    audioRef.current?.pause();
    setStatus("idle");
    setAyah(null);
  }, []);

  useEffect(
    () => () => {
      ticketRef.current++;
      clearTimer();
      cancelJob();
      audioRef.current?.pause();
      for (const p of preparedRef.current) URL.revokeObjectURL(p.url);
    },
    []
  );

  // Another reciter, surah or range is another cut.
  useEffect(() => {
    stop();
  }, [settings.reciterId, settings.surah, settings.from, settings.to, stop]);

  const prepare = useCallback(async (ticket: number): Promise<Prepared | null> => {
    const { reciterId, surah, from, to } = settingsRef.current;
    const key = `${reciterId}:${surah}:${from}-${to}`;
    const cached = preparedRef.current.find((p) => p.key === key);
    if (cached) return cached;
    setStatus("preparing");
    if (preparingRef.current?.key === key) {
      const result = await preparingRef.current.promise;
      return ticket === ticketRef.current ? result : null;
    }
    const run = prepareCut(key);
    preparingRef.current = { key, promise: run };
    try {
      const result = await run;
      return ticket === ticketRef.current ? result : null;
    } finally {
      if (preparingRef.current?.promise === run) preparingRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prepareCut = useCallback(async (key: string): Promise<Prepared | null> => {
    const { reciterId, surah, from, to } = settingsRef.current;
    const jobId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `hifz-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    jobRef.current = jobId;
    const res = await fetch("/api/hifz/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reciter: reciterId, surah, from, to, jobId }),
    }).catch(() => null);
    if (jobRef.current === jobId) jobRef.current = null;
    if (!res?.ok) throw new Error(res?.status === 413 ? "too_long" : "unavailable");
    const data = (await res.json()) as { audio: string; ayahs: Record<string, [number, number]>; words?: Record<string, [number, number][]> };
    const blob = await fetch(data.audio).then((r) => {
      if (!r.ok) throw new Error("unavailable");
      return r.blob();
    });
    const prepared: Prepared = { key, url: URL.createObjectURL(blob), ayahs: data.ayahs, words: data.words ?? {} };
    preparedRef.current = [prepared, ...preparedRef.current];
    for (const old of preparedRef.current.slice(KEEP)) URL.revokeObjectURL(old.url);
    preparedRef.current = preparedRef.current.slice(0, KEEP);
    return prepared;
  }, []);

  const stopTimeOf = (p: Prepared, n: number) => {
    const [, end] = p.ayahs[String(n)];
    const next = p.ayahs[String(n + 1)];
    return next ? Math.min(end + TAIL_SEC, Math.max(end, next[0] - LEAD_SEC)) : end + TAIL_SEC;
  };

  // Plays one ayah (posRef.current.ayah) from its start.
  const playAyah = useCallback(async () => {
    const ticket = ticketRef.current;
    const n = posRef.current.ayah;
    setAyah(n);
    setRep(posRef.current.rep);
    setRound(posRef.current.round);
    let prepared: Prepared | null;
    try {
      prepared = await prepare(ticket);
    } catch (err) {
      if (ticket !== ticketRef.current) return;
      setError((err as Error).message === "too_long" ? "too_long" : "unavailable");
      setStatus("error");
      return;
    }
    if (!prepared || ticket !== ticketRef.current) return;
    const time = prepared.ayahs[String(n)];
    if (!time) {
      setError("unavailable");
      setStatus("error");
      return;
    }
    const el = audio();
    try {
      if (currentRef.current?.key !== prepared.key || el.src !== prepared.url) {
        setStatus("loading");
        el.src = prepared.url;
        currentRef.current = prepared;
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            el.removeEventListener("loadedmetadata", done);
            el.removeEventListener("error", fail);
            resolve();
          };
          const fail = () => {
            el.removeEventListener("loadedmetadata", done);
            el.removeEventListener("error", fail);
            reject(new Error("media"));
          };
          el.addEventListener("loadedmetadata", done);
          el.addEventListener("error", fail);
        });
        if (ticket !== ticketRef.current) return;
      }
      el.currentTime = Math.max(0, time[0] - LEAD_SEC);
      stopAtRef.current = stopTimeOf(prepared, n);
      el.playbackRate = settingsRef.current.speed;
      await el.play();
      if (ticket !== ticketRef.current) {
        el.pause();
        return;
      }
      setError(null);
      setStatus("playing");
    } catch {
      if (ticket !== ticketRef.current) return;
      setError("unavailable");
      setStatus("error");
    }
  }, [prepare]);

  // After an ayah ends: the echo pause, then the next repetition, ayah or
  // round -- or the end.
  const advance = useCallback(() => {
    const s = settingsRef.current;
    const pos = posRef.current;
    if (onlyRef.current) {
      if (pos.rep + 1 < (optsRef.current.times ?? 1)) {
        pos.rep += 1;
        playAyah();
        return;
      }
      stop();
      setFinished((n) => n + 1);
      return;
    }
    if (s.repeatAyah === 0 || pos.rep + 1 < s.repeatAyah) {
      pos.rep += 1;
    } else if (pos.ayah + 1 <= s.to) {
      pos.ayah += 1;
      pos.rep = 0;
    } else if (s.repeatRange === 0 || pos.round + 1 < s.repeatRange) {
      pos.round += 1;
      pos.ayah = s.from;
      pos.rep = 0;
    } else {
      stop();
      setFinished((n) => n + 1);
      return;
    }
    playAyah();
  }, [playAyah, stop]);

  const ayahEnded = useCallback(() => {
    const el = audioRef.current;
    const s = settingsRef.current;
    const pos = posRef.current;
    const prepared = currentRef.current;
    // Straight on to the next ayah, no repetition or pause between: no seek.
    if (!onlyRef.current && !s.echo && prepared && s.repeatAyah !== 0 && pos.rep + 1 >= s.repeatAyah && pos.ayah + 1 <= s.to && prepared.ayahs[String(pos.ayah + 1)]) {
      pos.ayah += 1;
      pos.rep = 0;
      stopAtRef.current = stopTimeOf(prepared, pos.ayah);
      setAyah(pos.ayah);
      setRep(0);
      return;
    }
    el?.pause();
    const echo = onlyRef.current ? Boolean(optsRef.current.echo) : s.echo;
    if (echo && prepared) {
      const [start, end] = prepared.ayahs[String(pos.ayah)] ?? [0, 4];
      setStatus("echo");
      const ticket = ticketRef.current;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        if (ticket === ticketRef.current) advance();
      }, ((end - start) / s.speed) * 1000 + 600);
    } else {
      advance();
    }
  }, [advance]);

  // Watch the playhead.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el && !el.paused && stopAtRef.current !== null && el.currentTime >= stopAtRef.current) {
        stopAtRef.current = null;
        ayahEnded();
      }
      // The word being said now.
      let w = -1;
      const times = el && !el.paused ? currentRef.current?.words[String(posRef.current.ayah)] : undefined;
      if (times && el) {
        const t = el.currentTime + 0.05;
        for (let k = times.length - 1; k >= 0; k--) {
          if (times[k][0] <= t) {
            w = k;
            break;
          }
        }
      }
      if (w !== wordRef.current) {
        wordRef.current = w;
        setWord(w);
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    const el = audio();
    const onEnded = () => {
      if (stopAtRef.current !== null) {
        stopAtRef.current = null;
        ayahEnded();
      }
    };
    el.addEventListener("ended", onEnded);
    return () => {
      window.cancelAnimationFrame(frame);
      el.removeEventListener("ended", onEnded);
    };
  }, [ayahEnded]);

  // Speed changes apply at once.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = settings.speed;
  }, [settings.speed]);

  const play = useCallback(
    (fromAyah?: number, options: boolean | PlayOptions = false) => {
      const s = settingsRef.current;
      const opts = typeof options === "boolean" ? { only: options } : options;
      onlyRef.current = Boolean(opts.only || opts.times || opts.echo);
      optsRef.current = opts;
      ticketRef.current++;
      clearTimer();
      const start = fromAyah && fromAyah >= s.from && fromAyah <= s.to ? fromAyah : s.from;
      posRef.current = { ayah: start, rep: 0, round: 0 };
      playAyah();
    },
    [playAyah]
  );

  // Paused in the echo silence: resuming goes on to what comes next.
  const pausedInEchoRef = useRef(false);

  const pause = useCallback(() => {
    pausedInEchoRef.current = status === "echo";
    ticketRef.current++;
    clearTimer();
    audioRef.current?.pause();
    setStatus("paused");
  }, [status]);

  const resume = useCallback(() => {
    const el = audioRef.current;
    if (!el || status !== "paused") return play();
    ticketRef.current++;
    if (pausedInEchoRef.current) {
      pausedInEchoRef.current = false;
      advance();
      return;
    }
    el.play().then(
      () => setStatus("playing"),
      () => setStatus("error")
    );
  }, [advance, play, status]);

  const step = useCallback(
    (delta: number) => {
      const s = settingsRef.current;
      const current = posRef.current.ayah || s.from;
      play(Math.min(s.to, Math.max(s.from, current + delta)));
    },
    [play]
  );

  // Gets the range's cut ready ahead of the first "play" (the aligner takes
  // seconds the first time).
  const preload = useCallback(() => {
    prepare(ticketRef.current)
      .then(() => setStatus((st) => (st === "preparing" ? "idle" : st)))
      .catch(() => setStatus((st) => (st === "preparing" ? "idle" : st)));
  }, [prepare]);

  return { status, ayah, word, rep, round, error, finished, play, pause, resume, stop, step, preload };
}
