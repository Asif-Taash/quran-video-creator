// Shared canvas-based text measurement for QuranVideo.tsx's line-wrapping.
// A single offscreen 2D context is reused across calls (module-level
// singleton) instead of creating one per measurement -- this runs inside
// VerseScene's render body on every frame/prop change, so avoiding a fresh
// canvas allocation each time matters. Canvas measureText reads the exact
// same font-rasterization tables CSS text layout uses (including custom
// self-hosted fonts, once loaded), is synchronous, and works identically in
// both the live @remotion/player browser context and Remotion's headless-
// Chromium server-side renderer -- unlike DOM-node measurement, it needs no
// element to actually be mounted first. document.fonts.ready is already
// awaited via QuranVideo.tsx's own delayRender/continueRender gate before
// any frame is captured, so by the time this runs for a displayed frame,
// every custom font (including the per-page QCF glyph fonts) is loaded and
// these measurements are accurate.
let measureCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  if (typeof document === "undefined") {
    measureCtx = null;
    return measureCtx;
  }
  const canvas = document.createElement("canvas");
  measureCtx = canvas.getContext("2d");
  return measureCtx;
}

// Builds the exact same font string for both the CSS `style` object (via
// its own family/fontSize/fontWeight fields) and this module's ctx.font --
// callers must derive both from this one helper so the measured widths can
// never silently drift from what's actually rendered.
export function resolveFontCss(family: string, pxSize: number, weight: number | string = 400): string {
  return `${weight} ${pxSize}px ${family}`;
}

// Falls back to a crude per-character estimate if canvas is ever
// unavailable (e.g. this module were imported into a non-browser context) --
// keeps line-wrapping from throwing outright rather than being pixel-exact,
// mirroring this codebase's established "log and continue" tolerance for
// environment edge cases (see handleMediaError/handleImageError above).
export function measureTokenWidths(tokens: string[], fontCss: string): number[] {
  const ctx = getMeasureContext();
  if (!ctx) return tokens.map((t) => t.length * 10);
  ctx.font = fontCss;
  return tokens.map((t) => ctx.measureText(t).width);
}

export function measureTextWidth(text: string, fontCss: string): number {
  const ctx = getMeasureContext();
  if (!ctx) return text.length * 10;
  ctx.font = fontCss;
  return ctx.measureText(text).width;
}

export function measureSpaceWidth(fontCss: string): number {
  return measureTextWidth(" ", fontCss);
}

// The authoritative, synchronous "is this exact font actually usable right
// now" check -- `FontFaceSet.check()` reflects the browser's real current
// font cache, unlike a bookkeeping boolean derived from a bundle of
// `document.fonts.load()` promises (QuranVideo.tsx's own preload effect):
// that bundle can go stale after a re-entrant effect re-run (a NEW run
// starts before an OLDER one's promises settle, and the older one's
// `.then()` can still fire and flip global "ready" state after the newer
// run superseded it), and `Promise.allSettled` treats a genuinely REJECTED
// load the same as a successful one -- both silently produce a `ready`
// state that doesn't actually mean this specific font is safe to measure.
// Calling `check()` fresh at the point of use sidesteps both failure modes
// entirely, since it has no memory of past load attempts to get stale.
export function isFontUsable(fontCss: string): boolean {
  if (typeof document === "undefined" || !document.fonts?.check) return true;
  try {
    return document.fonts.check(fontCss);
  } catch {
    return true;
  }
}
