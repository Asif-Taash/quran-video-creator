import React from "react";

// A word with the very letter that went wrong in colour (2026-11-24, the
// user: a slip must show at once, and where in the word it is). The ear
// says which letters of the word as shown (backend hifz_judge: "x", letter
// indices; a haraka belongs to the letter it is on). The mushaf's page fonts
// draw a whole word as one glyph, so the word is written out here in the
// Uthmani font, letter by letter.

// A letter (the rest are its marks); not the tatweel. As the backend counts.
const LETTER = /[ء-غف-يٱ]/;

export function letterClusters(word: string): string[] {
  const out: string[] = [];
  for (const c of Array.from(word)) {
    if (LETTER.test(c) || !out.length) out.push(c);
    else out[out.length - 1] += c;
  }
  return out;
}

export default function WordWithSlip({
  text,
  x,
  kind,
  className = "",
}: {
  text: string;
  x?: number[];
  kind: "wrong" | "tashkeel" | "missing" | "added";
  className?: string;
}) {
  const bad = new Set(x ?? []);
  if (!bad.size) return <span className={`font-uthmanic-hafs ${className}`} dir="rtl">{text}</span>;
  const tone = kind === "tashkeel" ? "text-accent-amber" : "text-accent-red";
  return (
    <span className={`font-uthmanic-hafs ${className}`} dir="rtl">
      {letterClusters(text).map((c, i) =>
        bad.has(i) ? (
          <span key={i} className={`${tone} font-bold`}>
            {c}
          </span>
        ) : (
          <React.Fragment key={i}>{c}</React.Fragment>
        )
      )}
    </span>
  );
}
