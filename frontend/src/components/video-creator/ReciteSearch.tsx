import React, { useEffect, useRef, useState } from "react";
import { ArrowPathIcon, MicrophoneIcon, StopIcon, XMarkIcon } from "@heroicons/react/24/outline";
import Spinner from "@/components/ui/Spinner";
import { useT } from "@/lib/LanguageContext";

// Find ayahs by reciting them (2026-11-20): the 🎤 button records the
// user reading a part of an ayah or several ayahs, the backend hears it
// (backend/scripts/recite_search.py) and the closest places in the Quran
// come back -- even with a mistake in the reading. One tap on a result
// selects its ayahs.
//
// Recording stops on the stop button, or by itself once the reading has
// been followed by SILENCE_MS of quiet (a breath between ayahs is shorter),
// or after MAX_MS.

const SILENCE_MS = 3000;
const NO_VOICE_MS = 15000;
const MAX_MS = 180000;
const TICK_MS = 100;

interface Match {
  surah: number;
  from: number;
  to: number;
  score: number;
  text: string;
}

type Phase =
  | { kind: "idle" }
  | { kind: "recording" }
  | { kind: "working" }
  | { kind: "done"; heard: string; results: Match[] }
  | { kind: "error"; message: string };

interface ReciteSearchProps {
  getSurahName: (surahNumber: number) => string;
  onSelect: (surahNumber: number, fromAyah: number, toAyah: number) => void;
}

export default function ReciteSearch({ getSurahName, onSelect }: ReciteSearchProps) {
  const tx = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [voiceHeard, setVoiceHeard] = useState(false);
  // stop(true) cancels: the recording is thrown away.
  const stopRef = useRef<((cancel: boolean) => void) | null>(null);

  useEffect(() => () => stopRef.current?.(true), []);

  const send = async (blob: Blob) => {
    setPhase({ kind: "working" });
    try {
      const form = new FormData();
      form.append("audio", blob, "recitation");
      const res = await fetch("/api/quran/recognize", { method: "POST", body: form });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(String(res.status));
      setPhase({ kind: "done", heard: data.heard ?? "", results: data.results ?? [] });
    } catch (err) {
      console.error("[ReciteSearch] recognize failed:", err);
      setPhase({
        kind: "error",
        message: tx("تعذّر التعرّف على القراءة الآن، حاول مرة أخرى.", "Okuma şu an tanınamadı, tekrar deneyin.", "Couldn't recognize the reading right now, try again."),
      });
    }
  };

  const start = async () => {
    stopRef.current?.(true);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setPhase({
        kind: "error",
        message: tx(
          "الميكروفون غير متاح هنا. افتح البرنامج من نفس الحاسوب (localhost) ليعمل.",
          "Mikrofon burada kullanılamıyor. Programı aynı bilgisayardan (localhost) açın.",
          "The microphone isn't available here. Open the app on this computer (localhost)."
        ),
      });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      console.error("[ReciteSearch] microphone refused:", err);
      setPhase({
        kind: "error",
        message: tx(
          "لم يُسمح باستخدام الميكروفون. اسمح به من شريط العنوان في المتصفح ثم أعد المحاولة.",
          "Mikrofon izni verilmedi. Tarayıcının adres çubuğundan izin verip tekrar deneyin.",
          "Microphone access was refused. Allow it from the browser's address bar and try again."
        ),
      });
      return;
    }

    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    // Voice = loud enough above the quietest moment so far (the room) and
    // not far below the loudest (the reader) -- no fixed level, since
    // microphones differ a lot.
    let smooth = 0;
    let floor = Infinity;
    let peak = 0;
    let voiceMs = 0;
    let spoke = false;
    let lastVoiceAt = 0;
    const startedAt = performance.now();
    let cancelled = false;

    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      smooth = smooth === 0 ? rms : smooth * 0.6 + rms * 0.4;
      floor = Math.min(floor, smooth);
      peak = Math.max(peak * 0.999, smooth);
      const threshold = Math.max(0.006, floor * 2.5, peak * 0.12);
      const now = performance.now() - startedAt;
      if (smooth > threshold) {
        voiceMs += TICK_MS;
        lastVoiceAt = now;
        if (!spoke && voiceMs >= 400) {
          spoke = true;
          setVoiceHeard(true);
        }
      }
      setLevel(Math.min(1, smooth / Math.max(threshold * 4, 0.02)));
      setElapsed(now);
      if ((spoke && now - lastVoiceAt >= SILENCE_MS) || (!spoke && now >= NO_VOICE_MS) || now >= MAX_MS) {
        stop(false);
      }
    }, TICK_MS);

    const stop = (cancel: boolean) => {
      if (stopRef.current !== stop) return;
      stopRef.current = null;
      cancelled = cancel;
      window.clearInterval(timer);
      if (recorder.state !== "inactive") recorder.stop();
      else finish();
    };
    const finish = () => {
      stream.getTracks().forEach((t) => t.stop());
      audioContext.close().catch(() => {});
      if (cancelled) {
        setPhase({ kind: "idle" });
      } else if (!spoke) {
        setPhase({
          kind: "error",
          message: tx(
            "لم أسمع قراءة. قرّب الميكروفون واقرأ بصوت واضح، ثم أعد المحاولة.",
            "Bir okuma duyulmadı. Mikrofona yaklaşıp net bir sesle tekrar deneyin.",
            "No reading was heard. Come closer to the microphone and try again."
          ),
        });
      } else {
        send(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      }
    };
    recorder.onstop = finish;

    stopRef.current = stop;
    setElapsed(0);
    setLevel(0);
    setVoiceHeard(false);
    setPhase({ kind: "recording" });
    recorder.start(250);
  };

  const seconds = Math.floor(elapsed / 1000);
  const rangeLabel = (m: Match) =>
    `${getSurahName(m.surah)} ${m.from === m.to ? m.from : `${m.from}-${m.to}`}`;

  return (
    <>
      <button
        type="button"
        onClick={() => (phase.kind === "recording" ? stopRef.current?.(false) : start())}
        disabled={phase.kind === "working"}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
          phase.kind === "recording"
            ? "border-accent-red bg-accent-red-bg/60 text-accent-red"
            : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"
        }`}
      >
        {phase.kind === "recording" ? <StopIcon className="h-4 w-4" /> : <MicrophoneIcon className="h-4 w-4" />}
        {phase.kind === "recording" ? tx("إيقاف", "Durdur", "Stop") : tx("ابحث بصوتك", "Sesle ara", "Search by voice")}
      </button>

      {phase.kind !== "idle" && (
        <div className="basis-full rounded-xl border border-border bg-surface p-3 text-sm" dir="rtl">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {phase.kind === "recording" && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 font-medium text-foreground">
                    <span className="h-2.5 w-2.5 flex-shrink-0 animate-pulse rounded-full bg-accent-red" />
                    {voiceHeard
                      ? tx("أستمع... أكمل القراءة", "Dinliyorum... okumaya devam edin", "Listening... keep reading")
                      : tx("أستمع... اقرأ الآية الآن", "Dinliyorum... ayeti şimdi okuyun", "Listening... read the ayah now")}
                    <span className="ms-auto tabular-nums text-xs text-muted-foreground" dir="ltr">
                      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
                    <div className="h-full rounded-full bg-primary transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {tx(
                      "اقرأ جزءاً من الآية أو الآية كاملة أو عدة آيات. يتوقف التسجيل وحده بعد انتهائك بثلاث ثوانٍ، أو اضغط «إيقاف».",
                      "Ayetin bir kısmını, tamamını ya da birkaç ayeti okuyun. Bitirdikten 3 saniye sonra kayıt kendiliğinden durur, ya da «Durdur»a basın.",
                      "Read part of an ayah, a whole ayah or several. Recording stops 3 seconds after you finish, or press Stop."
                    )}
                  </p>
                </div>
              )}

              {phase.kind === "working" && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Spinner size="sm" />
                  {tx("أتعرّف على الآيات...", "Ayetler tanınıyor...", "Recognizing the ayahs...")}
                </div>
              )}

              {phase.kind === "error" && <p className="text-accent-red">{phase.message}</p>}

              {phase.kind === "done" && (
                <div className="space-y-2">
                  {phase.heard && (
                    <p className="text-xs text-muted-foreground">
                      {tx("سمعتُ:", "Duyulan:", "Heard:")} <span className="font-arabic text-sm text-foreground">«{phase.heard}»</span>
                    </p>
                  )}
                  {phase.results.length === 0 ? (
                    <p className="text-accent-red">
                      {phase.heard
                        ? tx(
                            "هذا قليل لأعرف الآية. اقرأ أكثر: الآية كاملة أو جزءاً أطول منها.",
                            "Ayeti bulmak için bu kısa. Daha fazla okuyun: ayetin tamamını ya da daha uzun bir kısmını.",
                            "That's too short to find the ayah. Read more: the whole ayah or a longer part."
                          )
                        : tx(
                            "لم أسمع قراءة واضحة. قرّب الميكروفون وأعد المحاولة.",
                            "Net bir okuma duyulmadı. Mikrofona yaklaşıp tekrar deneyin.",
                            "No clear reading was heard. Come closer to the microphone and try again."
                          )}
                    </p>
                  ) : (
                    <>
                      {phase.results[0].score < 0.6 && (
                        <p className="text-xs text-muted-foreground">
                          {tx("لست متأكداً تماماً، هذه أقرب الآيات لما قرأت:", "Tam emin değilim, okuduğunuza en yakın ayetler:", "Not quite sure; these are the closest ayahs:")}
                        </p>
                      )}
                      <ul className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60">
                        {phase.results.map((m, i) => (
                          <li key={`${m.surah}:${m.from}-${m.to}`}>
                            <button
                              type="button"
                              onClick={() => {
                                onSelect(m.surah, m.from, m.to);
                                setPhase({ kind: "idle" });
                              }}
                              className="flex w-full items-start gap-3 p-3 text-right transition-colors hover:bg-primary/5"
                            >
                              <span className="mt-1 flex flex-shrink-0 flex-col items-start gap-1">
                                <span className="inline-flex items-center whitespace-nowrap rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary ring-1 ring-inset ring-primary/20">
                                  [{rangeLabel(m)}]
                                </span>
                                {i === 0 && phase.results.length > 1 && (
                                  <span className="text-[10px] font-medium text-primary">{tx("الأقرب", "En yakın", "Closest")}</span>
                                )}
                              </span>
                              <span className="line-clamp-2 flex-1 font-arabic text-lg leading-loose text-foreground">{m.text}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
            {phase.kind !== "recording" && phase.kind !== "working" && (
              <div className="flex flex-shrink-0 flex-col gap-1">
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "idle" })}
                  title={tx("إغلاق", "Kapat", "Close")}
                  className="rounded-lg p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={start}
                  title={tx("أعد القراءة", "Tekrar oku", "Read again")}
                  className="rounded-lg p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <ArrowPathIcon className="h-4 w-4" />
                </button>
              </div>
            )}
            {phase.kind === "recording" && (
              <button
                type="button"
                onClick={() => stopRef.current?.(true)}
                title={tx("إلغاء", "İptal", "Cancel")}
                className="flex-shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
