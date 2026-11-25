"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckResult, ExtraResult, FixedResult, WordResult } from "./types";

// The microphone for the recitation check (تسميع), checked live: while the
// reader recites, the audio goes to the backend every 0.3 s
// (api/hifz/live/audio) and each answer is the reading so far, word by word
// -- a word said wrong shows at once, and clears when the reader goes back
// and says it right. Stopping runs the full check on the whole recording.
//
// The browser's echo cancellation, noise suppression and gain control are
// off: they are made for calls, and they cut a recitation's long madd as
// noise, and a reciter played from the same computer's speakers as echo
// (two 2026-11-21 checks heard 11 of 29 words, or doubted 19).
//
// The audio is resampled here to 16 kHz 16-bit mono -- what the backend
// hears with -- and kept, so the reader can listen to themselves after.

// Audio goes out every 0.3 s (a check takes 0.1-0.3 s on the GPU; one
// request at a time), so the page keeps up with the voice.
const SEND_MS = 300;
const SILENCE_MS = 60_000;
const NO_VOICE_MS = 30_000;
const MAX_MS = 15 * 60_000;
const RATE = 16000;

export type LiveError = "unsupported" | "refused" | "silent" | "failed" | "too_long";

export interface LiveUpdate {
  words: WordResult[];
  extras: ExtraResult[];
  stop: number;
  // The reader is speaking, but too faintly to be heard well.
  quiet?: boolean;
  // Seconds of audio judged.
  duration?: number;
  fixed?: FixedResult[];
  // Saying again what was already read (the reading's path is behind the
  // furthest place reached).
  repeating?: boolean;
}

function wav(chunks: Int16Array[]): Blob {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const c of chunks) {
    new Int16Array(buffer, offset, c.length).set(c);
    offset += c.length * 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function useLiveRecitation({
  onUpdate,
  onFinal,
}: {
  onUpdate: (u: LiveUpdate) => void;
  onFinal: (result: CheckResult, recording: Blob) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [voiceHeard, setVoiceHeard] = useState(false);
  const [error, setError] = useState<LiveError | null>(null);
  const stopRef = useRef<((cancel: boolean) => void) | null>(null);
  const cbRef = useRef({ onUpdate, onFinal });
  cbRef.current = { onUpdate, onFinal };

  useEffect(() => () => stopRef.current?.(true), []);

  const start = useCallback(async (surah: number, from: number, to: number) => {
    stopRef.current?.(true);
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      setError("unsupported");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch {
      setError("refused");
      return;
    }
    // Recording starts at once -- the reader starts at once -- and the
    // backend session opens meanwhile; what comes before it waits.
    let session: string | null = null;
    const opening = fetch("/api/hifz/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surah, from, to }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 413 ? "too_long" : "failed");
        session = ((await r.json()) as { session: string }).session;
      })
      .catch((err: Error) => {
        stopRef.current?.(true);
        setError(err.message === "too_long" ? "too_long" : "failed");
      });

    const ctx = new AudioContext();
    await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(ctx.destination);

    // Resampling to 16 kHz: each output sample is the mean of the input
    // samples around it (a box filter, enough against aliasing for speech).
    const ratio = ctx.sampleRate / RATE;
    let carry = new Float32Array(0);
    let next = 0;
    const all: Int16Array[] = [];
    let pending: Int16Array[] = [];

    let smooth = 0;
    let floor = Infinity;
    let peak = 0;
    let voiceMs = 0;
    let spoke = false;
    let lastVoiceAt = 0;
    const startedAt = performance.now();

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const buf = new Float32Array(carry.length + input.length);
      buf.set(carry);
      buf.set(input, carry.length);
      const half = ratio / 2;
      const out: number[] = [];
      while (next + half < buf.length) {
        const a = Math.max(0, Math.floor(next - half));
        const b = Math.min(buf.length, Math.ceil(next + half));
        let sum = 0;
        for (let i = a; i < b; i++) sum += buf[i];
        const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
        out.push(v < 0 ? v * 32768 : v * 32767);
        next += ratio;
      }
      const keep = Math.max(0, Math.floor(next - half) - 1);
      carry = buf.slice(keep);
      next -= keep;
      const chunk = Int16Array.from(out);
      all.push(chunk);
      pending.push(chunk);

      let energy = 0;
      for (let i = 0; i < input.length; i++) energy += input[i] * input[i];
      const rms = Math.sqrt(energy / input.length);
      smooth = smooth === 0 ? rms : smooth * 0.6 + rms * 0.4;
      floor = Math.min(floor, smooth);
      peak = Math.max(peak * 0.999, smooth);
      const threshold = Math.max(0.004, floor * 2.5, peak * 0.12);
      const now = performance.now() - startedAt;
      if (smooth > threshold) {
        voiceMs += (input.length / ctx.sampleRate) * 1000;
        lastVoiceAt = now;
        if (!spoke && voiceMs >= 400) {
          spoke = true;
          setVoiceHeard(true);
        }
      }
      setLevel(Math.min(1, smooth / Math.max(threshold * 4, 0.02)));
      setElapsed(now);
      if ((spoke && now - lastVoiceAt >= SILENCE_MS) || (!spoke && now >= NO_VOICE_MS) || now >= MAX_MS) stop(false);
    };

    // One request at a time; what came in meanwhile goes with the next.
    let inFlight: Promise<void> | null = null;
    let ended = false;
    const send = (final: boolean) => {
      const length = pending.reduce((n, c) => n + c.length, 0);
      const body = new Int16Array(length);
      let offset = 0;
      for (const c of pending) {
        body.set(c, offset);
        offset += c.length;
      }
      pending = [];
      return fetch(`/api/hifz/live/audio?session=${session}&final=${final ? 1 : 0}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: body.buffer,
      }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
    };
    let lastSent = 0;
    const timer = window.setInterval(() => {
      if (inFlight || ended || !session || !pending.length || performance.now() - lastSent < SEND_MS) return;
      lastSent = performance.now();
      inFlight = send(false)
        .then((u: LiveUpdate) => {
          if (!ended) cbRef.current.onUpdate(u);
        })
        .catch(() => {})
        .finally(() => {
          inFlight = null;
        });
    }, 100);

    const stop = (cancel: boolean) => {
      if (stopRef.current !== stop) return;
      stopRef.current = null;
      ended = true;
      window.clearInterval(timer);
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      setRecording(false);
      if (cancel) return;
      if (!spoke) {
        setError("silent");
        return;
      }
      setFinishing(true);
      const recordingBlob = wav(all);
      Promise.all([opening, inFlight])
        .then(() => {
          if (!session) throw new Error("failed");
          return send(true);
        })
        .then((result: CheckResult) => cbRef.current.onFinal(result, recordingBlob))
        .catch(() => setError("failed"))
        .finally(() => setFinishing(false));
    };
    stopRef.current = stop;
    setElapsed(0);
    setLevel(0);
    setVoiceHeard(false);
    setRecording(true);
  }, []);

  const stop = useCallback(() => stopRef.current?.(false), []);
  const cancel = useCallback(() => stopRef.current?.(true), []);

  return { recording, finishing, elapsed, level, voiceHeard, error, start, stop, cancel };
}
