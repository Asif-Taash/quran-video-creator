"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/LanguageContext";
import WordWithSlip from "./WordWithSlip";
import { wordKey, type ExtraResult, type HideMode, type RangeData, type WordResult } from "./types";

// The chosen ayahs as printed in the Madinah mushaf: the same QCF v2 page
// fonts as the video (pua-fonts.css declares p1..p604), line by line as on
// the page -- a full printed line is justified edge to edge, a line the
// range only partly covers starts at the right -- on the mushaf paper with
// its gold frame (globals.css .mushaf-page, from Kuran Nuru's reader).
//
// Ayahs read from memory are hidden (their glyphs kept, transparent, under a
// pill, so the line keeps its shape and the reader sees how long each word
// is; tap a word to see it): all their words, every other word, or with
// each word's first letter showing (hideMode). While a reciter plays, the
// word he is saying is lit (activeWord). After a recitation check every
// checked word shows how it went.

// Al-Fatiha 1:1 in its own page font: the basmala heading a surah.
const BASMALA_GLYPHS = "ﱁ ﱂ ﱃ ﱄ";

// The word's first letter with its marks: the hint on a hidden word.
function firstLetter(uthmani: string): string {
  const chars = Array.from(uthmani);
  const start = chars.findIndex((c) => /[ء-يٱ]/.test(c));
  if (start < 0) return "";
  let out = chars[start];
  for (let k = start + 1; k < chars.length && /[ً-ٰٟۖ-ۭ]/.test(chars[k]); k++) out += chars[k];
  return out;
}

interface Unit {
  key: string;
  kind: "word" | "end";
  ayah: number;
  index: number;
  glyph: string;
  uthmani: string;
  // Order over the surah's words shown (the check's word list), -1 for an
  // ayah end or another surah's word.
  order: number;
  // A word of another surah printed on the same page: shown, faded, inert.
  foreign: boolean;
}

interface Line {
  id: string;
  page: number;
  full: boolean;
  units: Unit[];
  // A surah starting on this line: its title (and basmala) go before it.
  opens?: number;
}

export interface MushafViewProps {
  data: RangeData;
  surahNameAr: (id: number) => string;
  surah: number;
  // The surah's ayahs in play (the passage, or the recitation); the rest of
  // the page is faded.
  activeFrom: number;
  activeTo: number;
  // Keep this word in view (the reciter's place while reciting).
  followKey?: string | null;
  hiddenAyahs: Set<number>;
  hideMode: Exclude<HideMode, "show">;
  focusAyah: number | null;
  activeWord?: string | null;
  revealed: Set<string>;
  results: WordResult[] | null;
  extras: ExtraResult[] | null;
  playingAyah: number | null;
  // Results of a reading still going on: words not reached yet keep the
  // memorizing look (hidden stays hidden) instead of fading.
  live?: boolean;
  // While reciting: words up to here (order) are reached -- the one being
  // said shows faintly before it is judged.
  reached?: number;
  // Reciting: a hidden word is simply blank -- no pill, no dot -- only the
  // ayah numbers show (2026-11-24, the user: "what are the circles for?").
  blank?: boolean;
  // Words (order) the reader got wrong, then right by going back.
  corrected?: Set<number>;
  // Word key -> how often it slipped lately (shown as a dot when on).
  weak: Record<string, number> | null;
  selectedKey: string | null;
  zoom: number;
  onWordTap: (key: string, order: number) => void;
  onAyahTap: (ayah: number) => void;
}

export default function MushafView({
  data,
  surahNameAr,
  surah,
  activeFrom,
  activeTo,
  followKey = null,
  hiddenAyahs,
  hideMode,
  focusAyah,
  activeWord = null,
  revealed,
  results,
  extras,
  playingAyah,
  live = false,
  reached = -1,
  blank = false,
  corrected,
  weak,
  selectedKey,
  zoom,
  onWordTap,
  onAyahTap,
}: MushafViewProps) {
  const tx = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [fitPx, setFitPx] = useState(26);
  // The fit is measured without the reader's zoom.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const { lines, pages } = useMemo(() => {
    const out: Line[] = [];
    let order = 0;
    const byId = new Map<string, Line>();
    const push = (u: Unit, page: number, line: number) => {
      const id = `${page}:${line}`;
      let l = byId.get(id);
      if (!l) {
        l = { id, page, full: false, units: [] };
        byId.set(id, l);
        out.push(l);
      }
      l.units.push(u);
    };
    for (const v of data.verses) {
      const vs = v.s ?? surah;
      const foreign = vs !== surah;
      v.words.forEach((w, i) => {
        const key = foreign ? `${vs}:${v.n}:${i}` : wordKey(v.n, i);
        push({ key, kind: "word", ayah: v.n, index: i, glyph: w.g, uthmani: w.u, order: foreign ? -1 : order++, foreign }, w.p, w.l);
        if (v.n === 1 && i === 0) byId.get(`${w.p}:${w.l}`)!.opens = vs;
      });
      if (v.end)
        push({ key: foreign ? `${vs}:${v.n}:e` : `${v.n}:e`, kind: "end", ayah: v.n, index: -1, glyph: v.end.g, uthmani: "", order: -1, foreign }, v.end.p, v.end.l);
    }
    for (const l of out) l.full = l.units.length >= (data.lines[l.id] ?? Infinity);
    return { lines: out, pages: Array.from(new Set(out.map((l) => l.page))) };
  }, [data, surah]);

  const extrasAfter = useMemo(() => {
    const map = new Map<number, ExtraResult[]>();
    for (const x of extras ?? []) map.set(x.after, [...(map.get(x.after) ?? []), x]);
    return map;
  }, [extras]);

  // The size that makes the widest full line fill the page: glyph widths
  // scale with the font size, so one measurement gives it. Again once the
  // page fonts have loaded, and when the page gets narrower or wider.
  const pagesKey = pages.join(",");
  useEffect(() => {
    let cancelled = false;
    const fit = async () => {
      const el = containerRef.current;
      if (!el) return;
      try {
        await Promise.all(pagesKey.split(",").filter(Boolean).map((p) => document.fonts.load(`32px p${p}`)));
      } catch {
        // A font that failed keeps the fallback size.
      }
      if (cancelled || !containerRef.current) return;
      const avail = el.clientWidth;
      const current = parseFloat(getComputedStyle(el).fontSize) / zoomRef.current;
      let widest = 0;
      el.querySelectorAll<HTMLElement>("[data-line]").forEach((line) => {
        const units = line.querySelectorAll<HTMLElement>(":scope > [data-unit]");
        // The words, and the gaps a centred or partial line keeps between them.
        let width = (parseFloat(getComputedStyle(line).columnGap) || 0) * Math.max(0, units.length - 1);
        units.forEach((u) => (width += u.getBoundingClientRect().width));
        widest = Math.max(widest, width / zoomRef.current);
      });
      if (widest <= 0 || avail <= 0) return;
      const next = Math.max(14, Math.min(44, (current * avail * 0.93) / widest));
      if (Math.abs(next - current) > 0.4) setFitPx(next);
    };
    fit();
    const observer = new ResizeObserver(() => fit());
    if (containerRef.current) observer.observe(containerRef.current);
    // A page font arriving after the first measure changes every width.
    const onFonts = () => fit();
    document.fonts.addEventListener?.("loadingdone", onFonts);
    const late = window.setTimeout(fit, 1200);
    return () => {
      cancelled = true;
      observer.disconnect();
      document.fonts.removeEventListener?.("loadingdone", onFonts);
      window.clearTimeout(late);
    };
  }, [pagesKey]);

  // Keep the word being recited -- or the ayah playing or learned -- in
  // view, clear of the bars above and below the page.
  const inView = activeWord ? `[data-key="${activeWord}"]` : followKey ? `[data-key="${followKey}"]` : (playingAyah ?? focusAyah) !== null ? `[data-ayah="${playingAyah ?? focusAyah}"]` : null;
  useEffect(() => {
    if (!inView) return;
    const el = containerRef.current?.querySelector<HTMLElement>(inView);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < 190 || rect.bottom > window.innerHeight - 180) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [inView]);

  const outside = (u: Unit) => u.foreign || u.ayah < activeFrom || u.ayah > activeTo;

  // className: the glyph's own colour; mark: a soft patch behind the letters
  // (a background on the glyph's box would be far taller than the word).
  const wordClass = (u: Unit): { className: string; hidden: boolean; hint: boolean; mark?: string } => {
    if (u.foreign) return { className: "opacity-35", hidden: false, hint: false };
    const result = u.order >= 0 ? results?.[u.order] : undefined;
    if (result && live && result.s === "unread" && u.order < reached) {
      // Being said: the word shows, faintly, until it is judged.
      return { className: "opacity-45", hidden: false, hint: false };
    }
    if (result?.s === "unclear") {
      // Said too faintly to judge: shown, greyed, neither right nor wrong.
      return { className: "opacity-30", hidden: false, hint: false };
    }
    if (result && !(live && result.s === "unread")) {
      if (result.s === "wrong") return { className: "text-accent-red", mark: "bg-accent-red/15", hidden: false, hint: false };
      if (result.s === "missing") return { className: "text-accent-amber", mark: "bg-accent-amber/20", hidden: false, hint: false };
      if (result.s === "tashkeel")
        return { className: "underline decoration-accent-amber decoration-dotted decoration-[0.07em] underline-offset-[0.35em] text-accent-amber", hidden: false, hint: false };
      if (result.s === "unread") return { className: "opacity-30", hidden: false, hint: false };
      if (corrected?.has(u.order))
        return { className: "underline decoration-accent-green decoration-dotted decoration-[0.07em] underline-offset-[0.35em]", hidden: false, hint: false };
      return { className: "", hidden: false, hint: false };
    }
    const hiddenAyah = hiddenAyahs.has(u.ayah) && !(hideMode === "alternate" && u.index % 2 === 0);
    if (hiddenAyah && !revealed.has(u.key)) return { className: "text-transparent", hidden: true, hint: hideMode === "hint" };
    if (hiddenAyah) return { className: "", mark: "bg-primary/[0.08]", hidden: false, hint: false };
    if (activeWord === u.key) return { className: "text-primary-dark dark:text-primary-light", mark: "bg-primary/25 dark:bg-primary/30", hidden: false, hint: false };
    return { className: outside(u) ? "opacity-35" : "", hidden: false, hint: false };
  };

  return (
    <div
      ref={containerRef}
      dir="rtl"
      className="select-none text-foreground"
      style={{ fontSize: `${fitPx * zoom}px` }}
    >
      {lines.map((line, k) => {
        const newPage = k > 0 && line.page !== lines[k - 1].page;
        const faded = line.opens !== undefined && line.opens !== surah;
        return (
          <React.Fragment key={line.id}>
            {newPage && (
              <div className="my-[0.5em] flex items-center gap-3 font-sans text-xs text-muted-foreground" style={{ fontSize: "0.75rem" }} aria-hidden>
                <span className="h-px flex-1 bg-gradient-to-l from-transparent via-primary/30 to-primary/30" />
                <span className="tabular-nums">{tx("صفحة", "Sayfa", "Page")} {line.page}</span>
                <span className="h-px flex-1 bg-gradient-to-r from-transparent via-primary/30 to-primary/30" />
              </div>
            )}
            {line.opens !== undefined && (
              <div className={`${k > 0 ? "mt-[0.5em]" : ""} ${faded ? "opacity-40" : ""}`}>
                <div className="mb-[0.4em] font-sans" style={{ fontSize: "1rem" }}>
                  <div className="surah-title-frame mx-auto max-w-md">
                    <span className="surah-title-text font-uthmanic-hafs">سورة {surahNameAr(line.opens)}</span>
                  </div>
                </div>
                {line.opens !== 1 && line.opens !== 9 && (
                  <p className="mb-[0.2em] text-center leading-[2.1] text-foreground" style={{ fontFamily: "p1" }}>
                    {BASMALA_GLYPHS}
                  </p>
                )}
              </div>
            )}
            <div
              data-line={line.id}
              className={`flex flex-wrap items-center leading-[2.15] ${
                // Pages 1 and 2 (Al-Fatiha, the start of Al-Baqara) are
                // printed with short centred lines; every other full line
                // runs edge to edge.
                line.page <= 2 ? "justify-center gap-x-[0.3em]" : line.full ? "justify-between" : "justify-start gap-x-[0.18em]"
              }`}
              style={{ fontFamily: `p${line.page}` }}
            >
              {line.units.map((u) => {
                const playing = playingAyah === u.ayah && !u.foreign;
                if (u.kind === "end") {
                  if (u.foreign)
                    return (
                      <span key={u.key} data-unit className="text-primary opacity-35">
                        {u.glyph}
                      </span>
                    );
                  return (
                    <span
                      key={u.key}
                      data-unit
                      data-ayah={u.ayah}
                      role="button"
                      tabIndex={-1}
                      onClick={() => onAyahTap(u.ayah)}
                      title={tx(`الآية ${u.ayah}`, `${u.ayah}. ayet`, `Ayah ${u.ayah}`)}
                      className={`cursor-pointer transition-colors duration-300 ${
                        // The ayah playing or chosen: its number a deeper
                        // colour, nothing drawn round it (the user, 2026-11-24).
                        playing || (focusAyah === u.ayah && !results) || (blank && !outside(u)) ? "text-primary-dark dark:text-primary-light" : "text-primary"
                      } ${outside(u) ? "opacity-35" : ""}`}
                    >
                      {u.glyph}
                    </span>
                  );
                }
                const { className, hidden, hint, mark } = wordClass(u);
                // A slip in the word: the word written out above it, the
                // wrong letter in colour.
                const r = u.order >= 0 ? results?.[u.order] : undefined;
                const slip = r && (r.s === "wrong" || r.s === "tashkeel") && r.x?.length ? r : null;
                const before = u.order === 0 ? extrasAfter.get(-1) : undefined;
                const after = u.order >= 0 ? extrasAfter.get(u.order) : undefined;
                const weakCount = weak?.[u.key] ?? 0;
                return (
                  <React.Fragment key={u.key}>
                    {before && <ExtraMarks extras={before} />}
                    <span
                      data-unit
                      data-key={u.key}
                      data-ayah={u.index === 0 && !u.foreign ? u.ayah : undefined}
                      role="button"
                      tabIndex={-1}
                      onClick={() => !u.foreign && onWordTap(u.key, u.order)}
                      className={`relative isolate cursor-pointer px-[0.02em] transition-[opacity,color] duration-300 ${className}`}
                    >
                      {(mark || selectedKey === u.key) && (
                        <span
                          aria-hidden
                          className={`pointer-events-none absolute inset-x-[-0.04em] bottom-[14%] top-[22%] -z-10 rounded-[0.3em] transition-colors duration-200 ${mark ?? ""} ${
                            selectedKey === u.key ? "ring-2 ring-primary/60" : ""
                          }`}
                        />
                      )}
                      {u.glyph}
                      {slip && (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute bottom-[78%] left-1/2 z-20 -translate-x-1/2 animate-fade-in whitespace-nowrap rounded-[0.5em] bg-surface px-[0.4em] font-sans text-foreground shadow-md ring-1 ring-border"
                          style={{ fontSize: "0.62em", lineHeight: 1.8 }}
                        >
                          <WordWithSlip text={u.uthmani} x={slip.x} kind={slip.s as "wrong" | "tashkeel"} />
                        </span>
                      )}
                      {/* A hidden word: a pill over the middle of its glyph's
                          box (the page fonts' boxes are far taller than the
                          letters), with its first letter as the hint. */}
                      {hidden && (!blank || hint) && (
                        <span
                          aria-hidden
                          className={`pointer-events-none absolute inset-x-[0.04em] bottom-[16%] top-[26%] flex items-center justify-center rounded-full ${
                            blank ? "" : "bg-primary/[0.14] ring-1 ring-inset ring-primary/20 dark:bg-primary/[0.2]"
                          }`}
                        >
                          {hint && (
                            <span className="font-uthmanic-hafs text-[0.62em] leading-none text-primary-dark dark:text-primary-light">
                              {firstLetter(u.uthmani)}
                            </span>
                          )}
                        </span>
                      )}
                      {weakCount >= 1 && !results && !blank && (
                        <span
                          aria-hidden
                          className={`pointer-events-none absolute bottom-[12%] left-1/2 h-[0.16em] w-[0.16em] -translate-x-1/2 rounded-full ${
                            weakCount >= 2 ? "bg-accent-red" : "bg-accent-amber"
                          }`}
                        />
                      )}
                    </span>
                    {after && <ExtraMarks extras={after} />}
                  </React.Fragment>
                );
              })}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// Between two words: what was said there that isn't in the text. An added
// word is a mistake (red +); a restart -- going back a few words -- isn't,
// it's only noted (↺).
function ExtraMarks({ extras }: { extras: ExtraResult[] }) {
  const tx = useT();
  return (
    <>
      {extras.map((x, i) => (
        <span
          key={i}
          data-unit
          title={
            x.kind === "added"
              ? tx(`زيادة: «${x.h}»`, `Fazladan: «${x.h}»`, `Added: «${x.h}»`)
              : tx(`رجعتَ وأعدت: «${x.h}»`, `Geri dönüp tekrar: «${x.h}»`, `Went back: «${x.h}»`)
          }
          className={`mx-[0.08em] inline-flex h-[0.8em] min-w-[0.8em] items-center justify-center self-center rounded-full px-[0.2em] font-sans font-bold leading-none ${
            x.kind === "added" ? "bg-accent-red/15 text-accent-red" : "bg-muted/15 text-muted-foreground"
          }`}
          style={{ fontSize: "0.42em" }}
        >
          {x.kind === "added" ? "+" : "↺"}
        </span>
      ))}
    </>
  );
}
