"use client";

import React from "react";
import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  BackwardIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ForwardIcon,
  MicrophoneIcon,
  PauseIcon,
  PlayIcon,
  SpeakerWaveIcon,
  StopIcon,
} from "@heroicons/react/24/solid";
import Spinner from "@/components/ui/Spinner";
import { useLanguage, useT } from "@/lib/LanguageContext";
import type { HideMode, Mistake, Outcome } from "./types";
import WordWithSlip from "./WordWithSlip";
import { describeSlip, plainHeard } from "./slipText";
import type { SlipDetail } from "./types";

// The latest slip while reciting: the word, its wrong letter in colour, and how.
export interface LiveAlert {
  label: string;
  word: string;
  x?: number[];
  d?: SlipDetail[];
  kind: "wrong" | "tashkeel" | "missing" | "added";
}

// The tools of the mode the reader picked, in one slim dock at the bottom
// of the screen (2026-11-24: the user found the step-by-step lesson, its
// cards and buttons, cluttered; they want to choose what to do). Each dock
// has one main button and a single row of small choices.

const mainButton =
  "flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-[15px] font-semibold text-white shadow-sm transition-[transform,background-color] hover:bg-primary-dark active:scale-[0.98] disabled:opacity-60 dark:text-background";
const roundButton =
  "flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl text-foreground/80 transition-colors hover:bg-primary/10 hover:text-primary disabled:pointer-events-none disabled:opacity-30";
const chip =
  "inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors";
const chipOff = `${chip} bg-foreground/[0.05] text-muted-foreground hover:bg-primary/10 hover:text-foreground dark:bg-white/[0.06]`;
const chipOn = `${chip} bg-primary/15 text-primary-dark ring-1 ring-inset ring-primary/30 dark:text-primary-light`;

function Row({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`no-scrollbar flex items-center gap-1.5 overflow-x-auto ${className}`}>{children}</div>;
}

function Note({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "red" }) {
  return <p className={`px-1 text-center text-[13px] leading-relaxed ${tone === "red" ? "text-accent-red" : "text-muted-foreground"}`}>{children}</p>;
}

function useArrows() {
  const { language } = useLanguage();
  const rtl = language === "ar";
  // "Previous" points the way the page reads back: right in Arabic.
  return { Prev: rtl ? ChevronRightIcon : ChevronLeftIcon, Next: rtl ? ChevronLeftIcon : ChevronRightIcon, rtl };
}

// An ayah picker: ‹ الآية 3 ›
function AyahStepper({ value, from, to, onChange, label }: { value: number; from: number; to: number; onChange: (n: number) => void; label: string }) {
  const tx = useT();
  const { Prev, Next } = useArrows();
  return (
    <div className="flex flex-shrink-0 items-center rounded-full bg-foreground/[0.05] dark:bg-white/[0.06]">
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= from} className="flex h-9 w-8 items-center justify-center rounded-full text-muted-foreground hover:text-primary disabled:opacity-30" aria-label={tx("الآية السابقة", "Önceki ayet", "Previous ayah")}>
        <Prev className="h-4 w-4" />
      </button>
      <span className="min-w-[4.5rem] text-center text-[13px] font-semibold tabular-nums text-foreground">{label}</span>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= to} className="flex h-9 w-8 items-center justify-center rounded-full text-muted-foreground hover:text-primary disabled:opacity-30" aria-label={tx("الآية التالية", "Sonraki ayet", "Next ayah")}>
        <Next className="h-4 w-4" />
      </button>
    </div>
  );
}

const timesLabel = (n: number) => (n === 0 ? "∞" : `×${n}`);

// ───────────────────────── Read to memorize ─────────────────────────

export function ReadDock(p: {
  hide: HideMode;
  onHide: (h: HideMode) => void;
  current: number;
  from: number;
  to: number;
  onAyah: (n: number) => void;
  times: number;
  onTimes: () => void;
  playing: boolean;
  preparing: boolean;
  rep: number;
  playerError: string | null;
  onPlay: () => void;
  onStop: () => void;
  onReciteThis: () => void;
}) {
  const tx = useT();
  const levels: { id: HideMode; label: string }[] = [
    { id: "show", label: tx("ظاهر", "Açık", "Shown") },
    { id: "hint", label: tx("أول حرف", "İlk harf", "First letter") },
    { id: "alternate", label: tx("بالتناوب", "Bir atlayarak", "Every other") },
    { id: "hide", label: tx("مخفي", "Gizli", "Hidden") },
  ];
  return (
    <div className="space-y-2.5">
      <div className="flex rounded-full bg-foreground/[0.05] p-1 dark:bg-white/[0.06]" role="radiogroup" aria-label={tx("إخفاء النص", "Metni gizle", "Hide the text")}>
        {levels.map((l) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={p.hide === l.id}
            onClick={() => p.onHide(l.id)}
            className={`h-8 flex-1 rounded-full text-[13px] font-medium transition-colors ${
              p.hide === l.id ? "bg-surface text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <AyahStepper value={p.current} from={p.from} to={p.to} onChange={p.onAyah} label={tx(`الآية ${p.current}`, `${p.current}. ayet`, `Ayah ${p.current}`)} />
        {p.playing || p.preparing ? (
          <button type="button" onClick={p.onStop} className={mainButton}>
            {p.preparing ? <Spinner size="sm" className="border-white/30 border-t-white" /> : <StopIcon className="h-5 w-5" />}
            {p.preparing ? tx("أجهّز التلاوة…", "Hazırlanıyor…", "Preparing…") : `${p.rep + 1} / ${p.times}`}
          </button>
        ) : (
          <button type="button" onClick={p.onPlay} className={mainButton}>
            <SpeakerWaveIcon className="h-5 w-5" />
            {tx("استمع", "Dinle", "Listen")}
          </button>
        )}
        <button type="button" onClick={p.onTimes} className={`${chipOff} !h-12 !rounded-2xl !px-3 tabular-nums`} title={tx("مرات التكرار", "Tekrar sayısı", "Times")} dir="ltr">
          {timesLabel(p.times)}
        </button>
        <button type="button" onClick={p.onReciteThis} className={roundButton} title={tx("سمّعها من حفظك", "Ezberden oku", "Recite it from memory")} aria-label={tx("سمّعها من حفظك", "Ezberden oku", "Recite it from memory")}>
          <MicrophoneIcon className="h-5 w-5" />
        </button>
      </div>
      {p.playerError && <Note tone="red">{p.playerError}</Note>}
    </div>
  );
}

// ───────────────────────── Recite from memory ─────────────────────────

export function ReciteDock(p: {
  start: number;
  from: number;
  to: number;
  onStart: (n: number) => void;
  hint: boolean;
  onHint: () => void;
  recording: boolean;
  finishing: boolean;
  level: number;
  elapsed: number;
  micError: string | null;
  liveAlert: LiveAlert | null;
  quiet: boolean;
  // The reader went back and is saying again what they read: fine.
  repeating: boolean;
  liveRight: number;
  onRecite: () => void;
  onStop: () => void;
  onCancel: () => void;
  outcome: Outcome | null;
  selected: Mistake | null;
  onSelect: (m: Mistake | null) => void;
  canPlaySelf: boolean;
  onPlaySelf: (t0?: number, t1?: number) => void;
  onHearAyah: (n: number) => void;
  onContinue: (n: number) => void;
  onNextLesson: () => void;
  nextLabel: string;
  onDone: () => void;
}) {
  const tx = useT();
  const seconds = Math.floor(p.elapsed / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  if (p.recording) {
    return (
      <div className="space-y-2.5">
        <div className="flex min-h-[1.5rem] items-center gap-3 px-1 text-sm">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-red/60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent-red" />
          </span>
          {p.liveAlert ? (
            <span
              className={`flex min-w-0 flex-1 items-baseline gap-2 truncate font-semibold ${
                p.liveAlert.kind === "tashkeel" || p.liveAlert.kind === "missing" ? "text-accent-amber" : "text-accent-red"
              }`}
              dir="rtl"
            >
              <span className="flex-shrink-0">{p.liveAlert.label}</span>
              <WordWithSlip text={p.liveAlert.word} x={p.liveAlert.x} kind={p.liveAlert.kind} className="text-2xl font-normal leading-none text-foreground" />
            </span>
          ) : p.repeating ? (
            <span className="min-w-0 flex-1 truncate font-semibold text-primary-dark dark:text-primary-light">
              {tx("↺ تكرار، تابع", "↺ Tekrar, devam edin", "↺ Repeating, go on")}
            </span>
          ) : p.quiet ? (
            <span className="min-w-0 flex-1 truncate font-semibold text-accent-amber">
              {tx("صوتك منخفض، قرّب الميكروفون", "Sesiniz alçak, mikrofona yaklaşın", "You're faint: come closer to the mic")}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{tx("أستمع إليك…", "Dinliyorum…", "Listening…")}</span>
          )}
          <span className="flex-shrink-0 tabular-nums text-accent-green">✓ {p.liveRight}</span>
        </div>
        {p.liveAlert?.d?.length ? (
          <p className="-mt-1 truncate px-1 text-[13px] text-muted-foreground" dir="rtl">
            {describeSlip(p.liveAlert.d[0], p.liveAlert.word, tx)}
          </p>
        ) : null}
        <div className="h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
          <div className="h-full rounded-full bg-primary transition-[width] duration-100" style={{ width: `${Math.round(p.level * 100)}%` }} />
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={p.onCancel} className={`${chipOff} !h-12 !rounded-2xl`}>
            {tx("إلغاء", "İptal", "Cancel")}
          </button>
          <button type="button" onClick={p.onStop} className={`${mainButton} !bg-accent-red hover:!bg-accent-red/90 dark:!text-white`}>
            <StopIcon className="h-5 w-5" />
            {tx("انتهيت", "Bitirdim", "Done")}
            <span className="text-sm font-normal tabular-nums opacity-80" dir="ltr">
              {clock}
            </span>
          </button>
        </div>
      </div>
    );
  }

  if (p.finishing) {
    return (
      <div className="flex h-12 items-center justify-center gap-2 text-sm font-medium text-muted-foreground">
        <Spinner size="sm" />
        {tx("أصحّح قراءتك…", "Okumanız kontrol ediliyor…", "Checking your reading…")}
      </div>
    );
  }

  if (p.outcome) {
    const o = p.outcome;
    const hard = o.mistakes.filter((m) => m.kind !== "tashkeel").length;
    const soft = o.mistakes.length - hard;
    const pct = o.total ? Math.round((o.right / o.total) * 100) : 0;
    const headline = !o.total
      ? tx("لم أسمعك بوضوح. قرّب الميكروفون واقرأ بصوت أعلى.", "Sizi net duyamadım. Mikrofona yaklaşıp daha yüksek okuyun.", "I couldn't hear you clearly. Come closer and recite louder.")
      : o.passed
      ? soft
        ? tx("حفظك سليم، وانتبه للحركات المعلَّمة.", "Ezber sağlam; işaretli harekelere dikkat.", "Well memorized; mind the marked vowels.")
        : tx("أحسنت! قراءة بلا خطأ.", "Maşallah! Hatasız.", "Well done! Not a slip.")
      : (() => {
          const ar = hard === 1 ? "موضع واحد يحتاج مراجعة" : hard === 2 ? "موضعان يحتاجان مراجعة" : hard <= 10 ? `${hard} مواضع تحتاج مراجعة` : `${hard} موضعاً تحتاج مراجعة`;
          return tx(ar, `${hard} yer tekrar istiyor`, hard === 1 ? "1 spot to review" : `${hard} spots to review`);
        })();
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold tabular-nums ${
              o.passed ? "bg-accent-green/15 text-accent-green" : "bg-accent-red/10 text-accent-red"
            }`}
          >
            {pct}%
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold text-foreground">{headline}</p>
            {o.stoppedEarly && (
              <p className="truncate text-xs text-muted-foreground">{tx(`توقفت عند الآية ${o.reachedAyah}`, `${o.reachedAyah}. ayette durdunuz`, `Stopped at ayah ${o.reachedAyah}`)}</p>
            )}
            {o.unclear > 0 && (
              <p className="truncate text-xs text-accent-amber">
                {tx(
                  `${o.unclear === 1 ? "كلمة لم أسمعها" : o.unclear === 2 ? "كلمتان لم أسمعهما" : `${o.unclear} كلمات لم أسمعها`} بوضوح، قرّب الميكروفون`,
                  `${o.unclear} kelime net duyulmadı; mikrofona yaklaşın`,
                  `${o.unclear} word${o.unclear === 1 ? "" : "s"} too faint to judge; come closer to the mic`
                )}
              </p>
            )}
          </div>
          {p.canPlaySelf && (
            <button type="button" onClick={() => p.onPlaySelf()} className={`${chipOff}`} title={tx("استمع لتسجيلك", "Kaydınızı dinleyin", "Hear yourself")}>
              <PlayIcon className="h-4 w-4" />
              {tx("تسجيلك", "Kaydınız", "You")}
            </button>
          )}
        </div>

        {o.mistakes.length > 0 && (
          <Row>
            {o.mistakes.map((m, i) => {
              const tone =
                m.kind === "wrong" || m.kind === "added"
                  ? "bg-accent-red/[0.08] text-accent-red ring-1 ring-inset ring-accent-red/25"
                  : m.kind === "missing"
                    ? "bg-accent-amber/10 text-accent-amber ring-1 ring-inset ring-accent-amber/30"
                    : "border border-dashed border-accent-amber/60 text-accent-amber";
              return (
                <button
                  key={`${m.key}-${m.kind}-${i}`}
                  type="button"
                  onClick={() => p.onSelect(p.selected?.key === m.key && p.selected.kind === m.kind ? null : m)}
                  className={`${chip} ${tone} ${p.selected?.key === m.key && p.selected.kind === m.kind ? "!ring-2 !ring-primary/60" : ""}`}
                >
                  <span className="text-[11px] opacity-75">
                    {m.kind === "wrong" ? tx("خطأ", "Yanlış", "Wrong") : m.kind === "missing" ? tx("نسيت", "Atlandı", "Left out") : m.kind === "tashkeel" ? tx("حركة", "Hareke", "Vowel") : tx("زيادة", "Fazla", "Added")}
                  </span>
                  {m.kind === "added" ? (
                    <span className="font-arabic text-[15px]" dir="rtl">
                      {plainHeard(m.heard ?? "")}
                    </span>
                  ) : (
                    <WordWithSlip text={m.word} x={m.x} kind={m.kind} className="text-lg leading-none text-foreground" />
                  )}
                </button>
              );
            })}
          </Row>
        )}

        {o.fixed.length > 0 && (
          <Row>
            <span className="flex-shrink-0 px-1 text-[12px] font-medium text-accent-green">{tx("صحّحتَ:", "Düzelttiniz:", "Put right:")}</span>
            {o.fixed.map((m, i) => (
              <button
                key={`fixed-${m.key}-${i}`}
                type="button"
                onClick={() => p.onSelect(p.selected?.key === m.key && p.selected.corrected ? null : m)}
                className={`${chip} bg-accent-green/[0.08] text-accent-green ring-1 ring-inset ring-accent-green/30 ${
                  p.selected?.key === m.key && p.selected.corrected ? "!ring-2 !ring-primary/60" : ""
                }`}
              >
                <span className="text-[11px]">↺</span>
                <WordWithSlip text={m.word} x={m.x} kind={m.kind} className="text-lg leading-none text-foreground" />
              </button>
            ))}
          </Row>
        )}

        {p.selected && (
          <div className="space-y-2 rounded-2xl bg-foreground/[0.04] px-3.5 py-3 text-sm dark:bg-white/[0.05]">
            <div className="flex items-center gap-2">
              <span className={`text-[13px] font-semibold ${p.selected.corrected ? "text-accent-green" : p.selected.kind === "wrong" || p.selected.kind === "added" ? "text-accent-red" : "text-accent-amber"}`}>
                {p.selected.corrected
                  ? tx("أخطأتَ هنا ثم أعدتها صحيحة", "Burada hata yapıp doğru tekrar ettiniz", "You slipped here, then said it right")
                  : p.selected.kind === "wrong"
                    ? tx("خطأ في الكلمة", "Kelimede hata", "A wrong letter or word")
                    : p.selected.kind === "tashkeel"
                      ? tx("خطأ في الحركة", "Hareke hatası", "A wrong vowel")
                      : p.selected.kind === "missing"
                        ? tx("نسيتَ هذه الكلمة", "Bu kelime atlandı", "This word was left out")
                        : tx("زيادة ليست في الآية", "Ayette olmayan fazlalık", "Something not in the ayah")}
              </span>
              <span className="ms-auto flex flex-shrink-0 gap-1">
              {p.canPlaySelf && p.selected.t0 !== undefined && (
                <button type="button" onClick={() => p.onPlaySelf(p.selected?.t0, p.selected?.t1)} className={chipOff}>
                  <PlayIcon className="h-3.5 w-3.5" />
                  {tx("قراءتك", "Siz", "You")}
                </button>
              )}
              {p.selected.kind !== "added" && (
                <button type="button" onClick={() => p.selected && p.onHearAyah(p.selected.ayah)} className={chipOff}>
                  <SpeakerWaveIcon className="h-3.5 w-3.5" />
                  {tx("الصواب", "Doğrusu", "Correct")}
                </button>
              )}
              </span>
            </div>
            {p.selected.kind !== "added" && (
              <div className="grid grid-cols-2 gap-2" dir="rtl">
                <div className="rounded-xl bg-surface px-3 py-2 ring-1 ring-border/70">
                  <div className="text-[11px] text-muted-foreground">{tx("قلتَ", "Okuduğunuz", "You said")}</div>
                  <div className={`font-uthmanic-hafs text-2xl leading-relaxed ${p.selected.corrected ? "text-muted-foreground" : "text-accent-red"}`}>
                    {p.selected.heard ? plainHeard(p.selected.heard) : "—"}
                  </div>
                </div>
                <div className="rounded-xl bg-surface px-3 py-2 ring-1 ring-accent-green/30">
                  <div className="text-[11px] text-muted-foreground">{tx("الصواب", "Doğrusu", "Should be")}</div>
                  <WordWithSlip text={p.selected.word} x={p.selected.x} kind={p.selected.kind} className="text-2xl leading-relaxed text-foreground" />
                </div>
              </div>
            )}
            {p.selected.kind === "added" && (
              <div className="font-uthmanic-hafs text-xl" dir="rtl">
                {plainHeard(p.selected.heard ?? "")}
              </div>
            )}
            {p.selected.d?.length ? (
              <ul className="space-y-0.5 text-[13px] text-foreground/80" dir="rtl">
                {p.selected.d.map((d, i) => (
                  <li key={i}>• {describeSlip(d, p.selected!.word, tx)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <button type="button" onClick={p.onDone} className={roundButton} title={tx("إخفاء النتيجة", "Sonucu kapat", "Close the result")} aria-label={tx("إخفاء النتيجة", "Sonucu kapat", "Close the result")}>
            <ArrowUturnLeftIcon className="h-5 w-5" />
          </button>
          <button type="button" onClick={p.onRecite} className={o.passed && !o.stoppedEarly ? `${chipOff} !h-12 !rounded-2xl` : mainButton}>
            <ArrowPathIcon className="h-5 w-5" />
            {tx("أعد التسميع", "Tekrar oku", "Again")}
          </button>
          {o.stoppedEarly ? (
            <button type="button" onClick={() => p.onContinue(Math.min(p.to, o.nextAyah))} className={o.passed ? mainButton : `${chipOff} !h-12 !rounded-2xl`}>
              {tx(`تابع من ${Math.min(p.to, o.nextAyah)}`, `${Math.min(p.to, o.nextAyah)}. ayetten devam`, `Go on from ${Math.min(p.to, o.nextAyah)}`)}
            </button>
          ) : (
            o.passed && (
              <button type="button" onClick={p.onNextLesson} className={mainButton}>
                {p.nextLabel}
              </button>
            )
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <Row>
        <AyahStepper value={p.start} from={p.from} to={p.to} onChange={p.onStart} label={tx(`من الآية ${p.start}`, `${p.start}. ayetten`, `From ayah ${p.start}`)} />
        <button type="button" onClick={p.onHint} aria-pressed={p.hint} className={p.hint ? chipOn : chipOff}>
          {tx("تلميح: أول حرف", "İpucu: ilk harf", "Hint: first letter")}
        </button>
      </Row>
      <button type="button" onClick={p.onRecite} className={`${mainButton} w-full`}>
        <MicrophoneIcon className="h-5 w-5" />
        {tx("ابدأ التسميع", "Ezberden okumaya başla", "Start reciting")}
      </button>
      {p.micError ? (
        <Note tone="red">{p.micError}</Note>
      ) : (
        <Note>{tx("اضغط مرة واحدة واقرأ ما شئت: آية بعد آية وصفحة بعد صفحة. أنبّهك فور الخطأ في حرف أو حركة، واضغط «انتهيت» متى شئت.", "Bir kez basın ve dilediğiniz kadar okuyun: ayet ayet, sayfa sayfa. Harf ya da hareke hatası anında gösterilir; istediğiniz an «Bitirdim»e basın.", "Press once and recite as far as you like, ayah after ayah, page after page. A wrong letter or vowel shows at once; press Done whenever you like.")}</Note>
      )}
    </div>
  );
}

// ───────────────────────── Listen ─────────────────────────

export function ListenDock(p: {
  status: "idle" | "preparing" | "loading" | "playing" | "echo" | "paused" | "error";
  ayah: number | null;
  rep: number;
  from: number;
  to: number;
  ayahTimes: number;
  onAyahTimes: () => void;
  loop: boolean;
  onLoop: () => void;
  speed: number;
  onSpeed: () => void;
  echo: boolean;
  onEcho: () => void;
  playerError: string | null;
  onToggle: () => void;
  onStep: (delta: number) => void;
}) {
  const tx = useT();
  const { rtl } = useArrows();
  const active = ["playing", "echo", "loading", "preparing"].includes(p.status);
  const busy = p.status === "preparing" || p.status === "loading";
  // Back and forward point the way the page reads.
  const Back = rtl ? ForwardIcon : BackwardIcon;
  const Fwd = rtl ? BackwardIcon : ForwardIcon;
  const where =
    p.ayah !== null
      ? p.status === "echo"
        ? tx(`دورك: الآية ${p.ayah}`, `Sıra sizde: ${p.ayah}. ayet`, `Your turn: ayah ${p.ayah}`)
        : `${tx(`الآية ${p.ayah}`, `${p.ayah}. ayet`, `Ayah ${p.ayah}`)}${p.ayahTimes !== 1 ? ` · ${p.rep + 1}${p.ayahTimes ? `/${p.ayahTimes}` : ""}` : ""}`
      : p.from === p.to
        ? tx(`الآية ${p.from}`, `${p.from}. ayet`, `Ayah ${p.from}`)
        : tx(`الآيات ${p.from}–${p.to}`, `${p.from}–${p.to}. ayetler`, `Ayahs ${p.from}–${p.to}`);
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => p.onStep(-1)} className={roundButton} aria-label={tx("الآية السابقة", "Önceki ayet", "Previous ayah")} disabled={p.ayah === null}>
          <Back className="h-5 w-5" />
        </button>
        <button type="button" onClick={p.onToggle} className={mainButton}>
          {busy ? <Spinner size="sm" className="border-white/30 border-t-white" /> : active ? <PauseIcon className="h-5 w-5" /> : <PlayIcon className="h-5 w-5" />}
          <span className="truncate">{p.status === "preparing" ? tx("أجهّز التلاوة…", "Hazırlanıyor…", "Preparing…") : where}</span>
        </button>
        <button type="button" onClick={() => p.onStep(1)} className={roundButton} aria-label={tx("الآية التالية", "Sonraki ayet", "Next ayah")} disabled={p.ayah === null}>
          <Fwd className="h-5 w-5" />
        </button>
      </div>
      <Row className="justify-center">
        <button type="button" onClick={p.onAyahTimes} className={p.ayahTimes !== 1 ? chipOn : chipOff}>
          {tx("كرّر كل آية", "Her ayeti", "Each ayah")} <span dir="ltr" className="tabular-nums">{timesLabel(p.ayahTimes)}</span>
        </button>
        <button type="button" onClick={p.onLoop} aria-pressed={p.loop} className={p.loop ? chipOn : chipOff}>
          <ArrowPathIcon className="h-3.5 w-3.5" />
          {tx("أعد المقطع", "Baştan al", "Loop")}
        </button>
        <button type="button" onClick={p.onEcho} aria-pressed={p.echo} className={p.echo ? chipOn : chipOff} title={tx("يقرأ القارئ ثم يسكت لتردّد خلفه", "Kari okur, susar; siz tekrarlarsınız", "The reciter reads, then pauses for you to repeat")}>
          {tx("ردّد خلفه", "Arkasından", "Repeat after")}
        </button>
        <button type="button" onClick={p.onSpeed} className={p.speed !== 1 ? chipOn : chipOff} dir="ltr">
          <span className="tabular-nums">{p.speed}×</span>
        </button>
      </Row>
      {p.playerError && <Note tone="red">{p.playerError}</Note>}
    </div>
  );
}
