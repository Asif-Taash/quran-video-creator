"use client";

import { useEffect, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import {
  PlayIcon,
  PauseIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  ArrowsPointingOutIcon,
  ArrowsPointingInIcon,
} from "@heroicons/react/24/solid";
import { ExclamationTriangleIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import { QuranVideo } from "@/remotion/QuranVideo";
import { ASPECT_RATIO_DIMENSIONS, type QuranVideoProps } from "@/remotion/types";
import { useLanguage } from "@/lib/LanguageContext";

interface VideoPreviewPlayerProps {
  inputProps: QuranVideoProps;
  // All optional so this component still works read-only (e.g. if ever
  // rendered somewhere without an owner to report drag changes back to).
  // Arabic verse and translation are fully independent -- see QuranVideo.tsx.
  // The segmentKey argument identifies exactly which displayed segment was
  // being edited (see QuranVideo.tsx's own segmentKey -- `${verseId}:${idx}`
  // when the block currently on screen belongs to a real mapping, or null
  // for the no-mappings whole-verse fallback, in which case the caller
  // should fall back to the old video-wide behavior).
  onArabicTextScaleChange?: (segmentKey: string | null, scale: number) => void;
  onArabicWidthScaleChange?: (segmentKey: string | null, scale: number) => void;
  onTranslationTextScaleChange?: (segmentKey: string | null, scale: number) => void;
  onTranslationWidthScaleChange?: (segmentKey: string | null, scale: number) => void;
}

type TextBlock = "arabic" | "translation";

const FPS = 30;

const MIN_TEXT_SCALE = 0.7;
const MAX_TEXT_SCALE = 1.4;
// How far (as a % of the preview's width/height) the corner size handle
// needs to travel to cover the entire MIN_TEXT_SCALE..MAX_TEXT_SCALE range.
// Purely a feel/sensitivity knob -- pick by eye, not derived from anything
// else.
const SIZE_DRAG_SPAN_PERCENT = 40;

// Kept in sync with render/route.ts's own clamp on arabicWidthScale/
// translationWidthScale. MAX_WIDTH_SCALE > 1 lets the box widen past the
// original default -- enough for already-short-enough text to collapse
// down to fewer lines, even a single one (see QuranVideo.tsx's
// formatInvertedPyramid/formatArabicVerse) -- while 1.04 stays safely
// under the least spare margin of any aspect ratio (landscape) before the
// box would start extending past the actual video frame edge. Narrowing
// below 1 (down to MIN_WIDTH_SCALE) still only ever forces MORE line
// breaks, same as before.
const MIN_WIDTH_SCALE = 0.4;
const MAX_WIDTH_SCALE = 1.04;
// Visual inset (from each side, as a % of the preview's width) shown at
// MIN_WIDTH_SCALE. Purely a display range for the drag handles -- pick by
// eye, not derived from anything else.
const MAX_INSET_PERCENT = 18;

function scaleToInsetPercent(scale: number): number {
  const t = (MAX_WIDTH_SCALE - scale) / (MAX_WIDTH_SCALE - MIN_WIDTH_SCALE);
  return Math.max(0, Math.min(MAX_INSET_PERCENT, t * MAX_INSET_PERCENT));
}

function insetPercentToScale(insetPercent: number): number {
  const clamped = Math.max(0, Math.min(MAX_INSET_PERCENT, insetPercent));
  const t = clamped / MAX_INSET_PERCENT;
  return MAX_WIDTH_SCALE - t * (MAX_WIDTH_SCALE - MIN_WIDTH_SCALE);
}

// Only used for the INITIAL hover trigger, before any real measurement
// exists yet -- a rough, generous "is the mouse roughly over this text"
// guess. Narrow-ish bands so the two blocks' initial zones don't overlap.
// Once hovering starts, the real measured box (see measureBlock) takes
// over entirely for both what's drawn AND what keeps the hover active --
// see HoverRegion's own comment for why that distinction matters.
const BLOCK_LAYOUT: Record<TextBlock, { portraitCenterTop: number; compactCenterTop: number; accent: "amber" | "primary" }> = {
  arabic: { portraitCenterTop: 44, compactCenterTop: 48, accent: "amber" },
  translation: { portraitCenterTop: 64, compactCenterTop: 60, accent: "primary" },
};
const INITIAL_HOTZONE_HEIGHT_PERCENT = 18;

// Small, fixed margin (as a % of the preview's width/height) added around
// the real measured text bounding box for the visible dashed outline and
// handles -- just enough that the box doesn't look glued to the glyphs.
const BOX_PADDING_PERCENT = 1.5;
// Extra room (beyond BOX_PADDING_PERCENT) the HOVERABLE region itself gets,
// so nudging the mouse slightly past a handle doesn't drop the hover the
// instant the cursor tip crosses the handle's own tiny edge. Only affects
// DISAPPEARING (see triggerRect in renderTextBlockControl, which shows the
// box only once the pointer is on the real text itself, unaffected by
// this) -- kept small since the Arabic verse and translation sit close
// together: too generous here and moving toward the translation to switch
// to IT gets stuck still inside the Arabic region instead, exactly the
// "doesn't let go" the user reported. The corner handle sits right at the
// two boxes' own shared edge (see outlineBottom above) now, not further
// below it, so it no longer needs much extra room to stay reachable.
const HOVER_MARGIN_PERCENT = 1.5;
const HOVER_BOTTOM_EXTRA_PERCENT = 1.5;

type BoxRect = { top: number; left: number; width: number; height: number };

type DragState =
  | { kind: "width"; block: TextBlock; side: "left" | "right"; insetPercent: number; startX: number; segmentKey: string | null }
  | { kind: "size"; block: TextBlock; scale: number; startX: number; startY: number; segmentKey: string | null };

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// The exact message Remotion's dev-mode <Audio> ref-registration race
// throws (see the "error" listener in the component below) -- verified via
// real browser testing to fire on essentially every mute/unmute/volume
// change during playback in dev mode, not "rarely after rapid interaction"
// as originally assumed. That made the crash-loop circuit breaker (see
// recentCrashTimestampsRef) trip after just a few completely normal mute
// toggles, well before it could ever matter for its actual intended job:
// catching a GENUINELY broken, unbounded crash loop from some other,
// unknown cause. Recognizing this one specific, always-recoverable
// signature and exempting it from the breaker's count (still recovers via
// a remount every single time, just never burns down the safety budget)
// keeps that protection intact for real failures while letting a normal
// user toggle mute/volume as much as they like. If a future
// @remotion/player version changes this message, matching simply stops
// (falls back to counting toward the breaker like any other error) rather
// than failing in a surprising way -- see this file's own git history for
// whether a newer version has fixed the underlying race entirely by then.
const KNOWN_AUDIO_REF_RACE_MESSAGE = "No audio ref found";

function isKnownAudioRefRace(error: unknown): boolean {
  return error instanceof Error && error.message === KNOWN_AUDIO_REF_RACE_MESSAGE;
}

// The crash-loop circuit breaker's own budget (see recentCrashTimestampsRef)
// -- how many UNKNOWN-error recoveries within this window are tolerated
// before giving up and showing the static "Tekrar Dene" overlay instead of
// remounting forever. The known Audio-ref race above is exempted from this
// count entirely, so on its own this budget would only ever need to catch a
// genuinely different failure. Widened from an original 3-in-8s anyway, as
// defense-in-depth: if a future @remotion/player version changes the known
// race's exact message and isKnownAudioRefRace stops matching it (falling
// back to counting here like any other error), a normal user's handful of
// mute/volume toggles still shouldn't be enough to trip this on their own.
const CRASH_LOOP_WINDOW_MS = 12000;
const CRASH_LOOP_THRESHOLD = 5;

// Renders the SAME composition (QuranVideo) the server-side render uses, fed
// the SAME inputProps computed by render/route.ts (via its "preview" mode) --
// content and timing are guaranteed identical to the final export by
// construction. Controls are custom-built (driven by the Player's imperative
// ref API, not Remotion's own default control skin) -- this preview is now
// the ONLY visual representation of the video the user ever sees (the real
// rendered file is downloaded directly, never shown), so its controls are
// styled to look like a finished video's own player would.
//
// Text size/width: a PowerPoint/Canva-style hover-to-select box, not a
// slider -- hovering the Arabic verse or the translation shows a bounding
// box around it with a left/right edge (drag = width, i.e. line-wrap) and a
// bottom-right corner handle (drag = font size, scaled radially from the
// box's own center). The two blocks are completely independent selections.
export default function VideoPreviewPlayer({
  inputProps,
  onArabicTextScaleChange,
  onArabicWidthScaleChange,
  onTranslationTextScaleChange,
  onTranslationWidthScaleChange,
}: VideoPreviewPlayerProps) {
  const { language } = useLanguage();
  const isArabic = language === "ar";
  const playerRef = useRef<PlayerRef>(null);
  // Bumped only to force a clean remount of the inner <Player> after a
  // crash -- see the "error" listener below. Carries the frame across that
  // remount via resumeAfterCrashRef, so recovering from the crash doesn't
  // ALSO reset playback to the start on top of it (left paused there
  // rather than resumed automatically -- see the effect below for why).
  const [crashRecoveryKey, setCrashRecoveryKey] = useState(0);
  const resumeAfterCrashRef = useRef<{ frame: number; resumePlaying: boolean } | null>(null);
  // Tracks whether the user actually WANTS playback running, independent
  // of the Player's own reported isPlaying()/"pause" event -- crucial
  // because Remotion's error-catching itself calls its internal pause()
  // BEFORE dispatching the "error" event (confirmed in
  // @remotion/player's source: `onError = () => { playerPause();
  // playerDispatchError(error); }`), so by the time our own "error"
  // listener below runs, player.isPlaying() ALWAYS already reads false --
  // using it there to decide whether to resume made a mute-triggered
  // crash during playback look like it silently stopped the video
  // instead of continuing (reported behavior). This ref instead mirrors
  // real user intent: set true on "play"/"frameupdate" (proof playback is
  // genuinely advancing), and set false only by an explicit user pause
  // (see togglePlay) or "ended" -- never by the generic "pause" event,
  // which is exactly what the crash's own internal pause fires and must
  // NOT be mistaken for the user wanting to stop.
  const wasPlayingIntentRef = useRef(false);
  // True only in the brief window right after toggleMute/handleVolumeChange
  // themselves called player.mute()/unmute()/setVolume() -- distinguishes
  // "this crash was caused BY the button the user just pressed" (a real,
  // current gesture) from "this crash happened to occur mid-playback with
  // no click behind it at all" (the ONLY case the existing silent-resume
  // check below was written for). Set true immediately before each such
  // call; cleared ONLY by markExplicitAudioGesture's own short timeout, not
  // by onError on read -- see that read site's own comment for why a
  // clear-on-consume there broke this for clicks that cascade into more
  // than one crash.
  const explicitAudioGestureRef = useRef(false);
  // True for the brief window between a crash-recovery remount and our own
  // deferred seekTo(frame) actually landing (see the resume effect below).
  // The fresh <Player> instance fires its OWN genuine "frameupdate" for
  // frame 0 immediately on mount -- before our rAF-deferred seekTo gets a
  // chance to correct it -- and onFrameUpdate normally applies every such
  // event unconditionally, which briefly flashed the on-screen timer (and
  // currentFrameRef, which recovery itself reads) down to 0:00 on every
  // single crash. Suppressing onFrameUpdate's writes while this is true
  // discards that one spurious pre-seek report; once our own seekTo runs,
  // it's cleared and real ticking resumes from the correct frame.
  const suppressFrameUpdatesRef = useRef(false);
  // Circuit breaker: if the SAME crash keeps recurring right after each
  // recovery remount (observed in practice -- muting can retrigger it
  // instantly on the fresh instance too), retrying forever would just spin
  // in a tight crash loop. After a few recoveries within a short window,
  // stop retrying and show our own static message instead of endlessly
  // remounting. See CRASH_LOOP_WINDOW_MS/CRASH_LOOP_THRESHOLD's own
  // comment for why the known Remotion Audio-ref race doesn't even count
  // toward this.
  const recentCrashTimestampsRef = useRef<number[]>([]);
  const [permanentlyCrashed, setPermanentlyCrashed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  // Mirrors currentFrame for synchronous reads from onError (see below).
  // Two reasons this can't just read the currentFrame STATE variable or
  // player.getCurrentFrame() instead: the main effect below is mount-only
  // (deps [crashRecoveryKey]), so its onError closure would otherwise
  // capture currentFrame's value from whenever that effect last ran, not
  // the latest one -- and by the time onError runs, the player instance
  // that just crashed has already had Remotion's own internal pause()
  // called against it (see wasPlayingIntentRef's comment), so querying
  // ITS getCurrentFrame() risked reading stale/reset state from an
  // instance already mid-teardown, which is what was producing the
  // "recovery restarts from frame 0" symptom. Updated from every source
  // that changes the real position (frame ticks, manual seeks) so it's
  // always current regardless of play state.
  const currentFrameRef = useRef(0);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Which block's box is currently shown -- hover-triggered, and also kept
  // shown for whichever block is actively being dragged even if the pointer
  // has since left its hotzone (standard drag UX: don't hide what you're
  // mid-drag on).
  const [hoveredBlock, setHoveredBlock] = useState<TextBlock | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const dragStartRef = useRef<DragState | null>(null);
  // The REAL rendered bounding box of each text block, in percent of the
  // container -- QuranVideo.tsx tags the Arabic verse/translation divs with
  // data-text-block for exactly this. Remotion's Player renders actual DOM
  // (not a canvas/iframe), so getBoundingClientRect() here is exact, not an
  // approximation -- and already accounts for the Player's own internal
  // scale-to-fit transform, no extra math needed.
  const [boxRects, setBoxRects] = useState<Record<TextBlock, BoxRect | null>>({ arabic: null, translation: null });
  // Which exact segment (verse + mapping index, see QuranVideo.tsx's own
  // data-segment-key) each block's box is CURRENTLY sitting over -- null
  // for the no-mappings whole-verse fallback. Read alongside boxRects in
  // the same per-frame measurement loop below, since both change for the
  // same reason (playback advancing to a different segment).
  const [activeSegmentKeys, setActiveSegmentKeys] = useState<Record<TextBlock, string | null>>({ arabic: null, translation: null });

  // Each falls back to inputProps.textScale (the older, shared field) so a
  // draft/render saved before these two were split independently still
  // shows the same size it always did.
  const arabicTextScale = inputProps.arabicTextScale ?? inputProps.textScale ?? 1;
  const arabicWidthScale = inputProps.arabicWidthScale ?? 1;
  const translationTextScale = inputProps.translationTextScale ?? inputProps.textScale ?? 1;
  const translationWidthScale = inputProps.translationWidthScale ?? 1;

  const durationInFrames = Math.max(1, Math.round(inputProps.totalDurationInFrames));
  const { width: compositionWidth, height: compositionHeight } =
    ASPECT_RATIO_DIMENSIONS[inputProps.aspectRatio ?? "portrait"];
  const cssAspectRatio = `${compositionWidth} / ${compositionHeight}`;
  const isPortraitLayout = (inputProps.aspectRatio ?? "portrait") === "portrait";

  // Mount-only (see the empty deps array below) -- this used to depend on
  // [inputProps], which is a NEW object reference on every single prop
  // change (translation edit, background swap, and especially every one of
  // the many drag-tick updates the resize boxes below produce), so it was
  // resetting playback to frame 0 and pausing on virtually every edit,
  // including mid-drag. The player itself only genuinely needs fresh
  // listeners/state once per real mount -- Step5Generate already forces an
  // actual remount (via its `key={previewVersion}`) on the one case that
  // SHOULD reset playback, an actual audio-source change, and a fresh mount
  // re-runs this effect naturally since it's a new component instance.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;

    const onPlay = () => {
      wasPlayingIntentRef.current = true;
      setIsPlaying(true);
    };
    // Deliberately does NOT unconditionally flip isPlaying -- Remotion's
    // own error handling calls this internal pause() BEFORE dispatching
    // "error" (see wasPlayingIntentRef's comment), and naively setting
    // isPlaying(false) here made the play/pause icon flash to "paused"
    // for every mute-triggered crash, even ones that immediately
    // auto-resume uninterrupted underneath. wasPlayingIntentRef is only
    // ever cleared by an explicit user pause (see togglePlay, which
    // clears it BEFORE calling toggle()) or "ended" -- never by this
    // event -- so checking it here distinguishes "user actually paused"
    // (already cleared, so this correctly still hides the icon) from
    // "Remotion's internal pre-error pause" (still true, so skip -- the
    // error handler below decides the real end state once it knows
    // whether recovery can resume).
    const onPause = () => {
      if (!wasPlayingIntentRef.current) setIsPlaying(false);
    };
    const onEnded = () => {
      wasPlayingIntentRef.current = false;
      setIsPlaying(false);
    };
    const onFrameUpdate = (e: { detail: { frame: number } }) => {
      // Discard the fresh post-crash mount's own transient frame-0 report
      // (see suppressFrameUpdatesRef's declaration) -- applying it here
      // would both flash the visible timer to 0:00 and corrupt
      // currentFrameRef with a wrong value for a subsequent crash to read.
      if (suppressFrameUpdatesRef.current) return;
      // Only fires while actually advancing -- the most reliable proof
      // playback is genuinely running, kept fresh every frame so it can't
      // go stale the way a one-off "play" event flag could.
      wasPlayingIntentRef.current = true;
      currentFrameRef.current = e.detail.frame;
      setCurrentFrame(e.detail.frame);
    };
    const onMuteChange = (e: { detail: { isMuted: boolean } }) => setIsMuted(e.detail.isMuted);
    const onVolumeChange = (e: { detail: { volume: number } }) => setVolume(e.detail.volume);
    // Remotion's own dev-mode <Audio>/<Video> elements can throw ("No audio
    // ref found") from a timing race in their internal ref-registration --
    // a known Remotion Player quirk in preview/dev mode only (never happens
    // in the actual server-side render). Once thrown, Remotion's internal
    // ErrorBoundary shows a bare "⚠️" and never recovers on its own -- a
    // React error boundary only resets via an actual remount. Rather than
    // leave the user stuck on that forever, remember where playback was and
    // force exactly that (bump crashRecoveryKey -> new `key` on <Player>
    // below -> fresh mount, no stale error-boundary state) then resume from
    // the same spot once the fresh Player is back.
    const onError = (e: { detail?: { error?: unknown } }) => {
      const error = e?.detail?.error;
      // See isKnownAudioRefRace's own comment -- this ALWAYS still recovers
      // via a remount below, it just doesn't count toward the circuit
      // breaker's budget, since real browser testing showed it firing on
      // essentially every mute/volume change and tripping the breaker
      // after only a few completely normal toggles.
      const isKnownRace = isKnownAudioRefRace(error);

      if (!isKnownRace) {
        const now = Date.now();
        const recent = recentCrashTimestampsRef.current.filter((t) => now - t < CRASH_LOOP_WINDOW_MS);
        recent.push(now);
        recentCrashTimestampsRef.current = recent;

        if (recent.length > CRASH_LOOP_THRESHOLD) {
          console.error(
            "[VideoPreviewPlayer] Remotion Player keeps crashing right after each recovery -- giving up auto-recovery:",
            error ?? e
          );
          setPermanentlyCrashed(true);
          return;
        }
      }

      console.error(
        isKnownRace
          ? "[VideoPreviewPlayer] Known Remotion dev-mode Audio-ref race -- auto-recovering with a fresh mount (does not count toward the crash-loop breaker):"
          : "[VideoPreviewPlayer] Remotion Player error -- auto-recovering with a fresh mount:",
        error ?? e
      );
      // Safe to auto-resume playback across the remount when it's either
      // silent either way (muted, or volume at 0 -- browsers always allow
      // MUTED autoplay with no user-gesture requirement, unlike unmuted
      // autoplay) OR this exact crash was caused by an explicit
      // mute/unmute/volume click the user just made (explicitAudioGestureRef
      // -- see its own declaration comment): that click IS a real gesture,
      // so an unmuted resume is attempted too, not just left paused. This
      // is what lets a crash while muted recover completely transparently
      // -- exactly the "must be able to keep watching muted, uninterrupted"
      // requirement -- without reintroducing the unreliable
      // pause-then-resume-later approach reverted above.
      //
      // Deliberately reads wasPlayingIntentRef here, NOT
      // player.isPlaying() -- Remotion's own error handling already
      // paused the player internally before dispatching this "error"
      // event (see wasPlayingIntentRef's own declaration comment), so
      // player.isPlaying() is always already false by this point and
      // using it here made a mute-triggered crash during playback look
      // like the video had simply stopped instead of continuing.
      const resumePlaying =
        wasPlayingIntentRef.current &&
        (player.isMuted() || player.getVolume() <= 0 || explicitAudioGestureRef.current);
      // Deliberately NOT cleared here -- a single mute/unmute/volume click
      // commonly cascades into a SECOND, separate crash (the shared
      // audio-tag pool's own "unregisterAudio" throw, torn down by our own
      // recovery remount -- see this file's own diagnosis history), which
      // fires its OWN independent onError call moments later. Clearing the
      // ref the instant the FIRST crash consumed it made that second,
      // still-same-click crash read it as false and overwrite this
      // decision with a wrongly-paused one -- intermittently, depending on
      // whether that particular click happened to cascade. Left alone
      // here, it only actually clears via markExplicitAudioGesture's own
      // short fallback timeout, so it stays true across a whole cascade
      // from the same click.
      resumeAfterCrashRef.current = {
        // Reads the ref mirror, NOT player.getCurrentFrame() -- by this
        // point the crashed instance has already had Remotion's own
        // internal pause() called against it (see above), so its own
        // getCurrentFrame() risked reading stale/reset state from an
        // instance already mid-teardown, which is what was producing the
        // "recovery restarts from frame 0" symptom. currentFrameRef is
        // updated independently of this player instance's health.
        frame: currentFrameRef.current,
        resumePlaying,
      };
      if (!resumePlaying) {
        // onPause above deliberately skipped updating isPlaying for this
        // same internal pre-error pause (see its own comment), leaving
        // the icon showing "playing" -- correct while recovery is about
        // to resume, but wrong here: this branch means it WON'T
        // auto-resume (unmuted case), so reflect that the user now needs
        // a fresh manual play click, same as the existing comment below
        // on why that click can't happen automatically.
        wasPlayingIntentRef.current = false;
        setIsPlaying(false);
      }
      setCrashRecoveryKey((k) => k + 1);
    };

    player.addEventListener("play", onPlay);
    player.addEventListener("pause", onPause);
    player.addEventListener("ended", onEnded);
    player.addEventListener("frameupdate", onFrameUpdate);
    player.addEventListener("mutechange", onMuteChange);
    player.addEventListener("volumechange", onVolumeChange);
    player.addEventListener("error", onError);

    // If this mount is the fresh one right after a crash recovery, put
    // playback back at the same FRAME instead of leaving it at frame 0.
    // Whether it also resumes PLAYING automatically depends on
    // resumePlaying (set above, in onError): calling seekTo/play in the
    // very same tick this effect runs raced against the fresh <Audio>'s
    // own ref attaching (observed as the SAME crash firing again
    // immediately, over and over -- a couple of animation frames' delay
    // avoids that part), so it's always deferred either way. When it WAS
    // playing muted/silent, resuming here is safe -- muted autoplay needs
    // no user gesture, so playback continues with no visible interruption
    // at all. When it was playing unmuted with NO explicit gesture behind
    // this particular crash, resuming here is deliberately skipped: a
    // play() call at this point is no longer inside any user gesture at
    // all (the crash happened spontaneously mid-playback), and browsers
    // only allow UNMUTED autoplay within a real gesture window -- calling
    // it anyway silently played video-only, no audio, exactly as
    // reported. Leaving it paused there means the user's own next play
    // click is a fresh, genuine gesture -- audio just works. When the
    // crash instead came from the user's OWN mute/unmute/volume click
    // (explicitAudioGestureRef, factored into resumePlaying above), that
    // click IS the real gesture, so resuming unmuted here is attempted --
    // still deferred the same one-rAF amount as every other case above.
    // Verified via a real Playwright .click() (genuine user activation,
    // not a synthetic event) that this deferral is still close enough to
    // the original click for the browser to allow it -- see this file's
    // git history for that verification if this ever regresses.
    let resumeRaf = 0;
    if (resumeAfterCrashRef.current) {
      // Block onFrameUpdate from applying the fresh Player's own transient
      // frame-0 report (see suppressFrameUpdatesRef's declaration) for the
      // brief window until the seekTo below actually lands.
      suppressFrameUpdatesRef.current = true;
      const { frame, resumePlaying } = resumeAfterCrashRef.current;
      resumeAfterCrashRef.current = null;
      resumeRaf = requestAnimationFrame(() => {
        playerRef.current?.seekTo(frame);
        if (resumePlaying) playerRef.current?.play();
        suppressFrameUpdatesRef.current = false;
      });
    }

    const onFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFullscreenChange);

    return () => {
      cancelAnimationFrame(resumeRaf);
      // Guards against a pathological back-to-back-crash edge case: if a
      // SECOND crash arrives before this mount's own deferred seekTo (just
      // cancelled above) ever ran, this cleanup -- not that cancelled
      // callback -- is what would otherwise leave onFrameUpdate silently
      // stuck discarding every frame forever. The next mount (for the new
      // crashRecoveryKey) sets this true again itself if IT also needs to
      // resume-seek, so clearing it here unconditionally is always safe.
      suppressFrameUpdatesRef.current = false;
      player.removeEventListener("play", onPlay);
      player.removeEventListener("pause", onPause);
      player.removeEventListener("ended", onEnded);
      player.removeEventListener("frameupdate", onFrameUpdate);
      player.removeEventListener("mutechange", onMuteChange);
      player.removeEventListener("volumechange", onVolumeChange);
      player.removeEventListener("error", onError);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
    // crashRecoveryKey is intentionally the only dep besides mount --
    // re-attaching (to the NEW <Player> instance) only when we ourselves
    // just forced that remount, never on the unrelated prop churn
    // (translation edits, drag ticks, etc.) the comment above/on
    // crashRecoveryKey's declaration already explains was the reason this
    // effect became mount-only in the first place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crashRecoveryKey]);

  const measureBlock = (block: TextBlock): BoxRect | null => {
    const container = containerRef.current;
    if (!container) return null;
    const el = container.querySelector<HTMLElement>(`[data-text-block="${block}"]`);
    if (!el) return null;
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (!containerRect.width || !containerRect.height) return null;
    return {
      top: ((elRect.top - containerRect.top) / containerRect.height) * 100,
      left: ((elRect.left - containerRect.left) / containerRect.width) * 100,
      width: (elRect.width / containerRect.width) * 100,
      height: (elRect.height / containerRect.height) * 100,
    };
  };

  // QuranVideo.tsx stamps the currently-displayed segment's own key onto
  // this same data-text-block element (see its own data-segment-key,
  // `${verseId}:${idx}`) -- reading it back here is how the box knows WHICH
  // segment it's about to resize, without duplicating any of QuranVideo's
  // own frame/timing-to-segment math on this side.
  const readSegmentKey = (block: TextBlock): string | null => {
    const container = containerRef.current;
    if (!container) return null;
    const el = container.querySelector<HTMLElement>(`[data-text-block="${block}"]`);
    return el?.getAttribute("data-segment-key") ?? null;
  };

  // Re-measures every frame while either block is relevant (hovered, or
  // being dragged even if the pointer has since left its hotzone) -- cheap
  // (two getBoundingClientRect calls), and needs to track live: the box's
  // real size visibly changes as a corner-drag changes font size, and which
  // verse/segment is on screen changes as the video plays.
  useEffect(() => {
    if (!hoveredBlock && !dragging) return;
    let raf = 0;
    const tick = () => {
      setBoxRects({ arabic: measureBlock("arabic"), translation: measureBlock("translation") });
      setActiveSegmentKeys({ arabic: readSegmentKey("arabic"), translation: readSegmentKey("translation") });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredBlock, dragging]);

  // On a mouse, moving the pointer off the block (onMouseLeave, above) is
  // what dismisses its box -- there's no equivalent "left" event for a tap,
  // so a block revealed via the onClick tap-to-reveal above would otherwise
  // stay stuck open forever on a phone. Tapping anywhere outside the player
  // closes it instead, same as a standard popover/tooltip. Skipped entirely
  // while dragging so a drag that momentarily tracks the pointer past the
  // player's own edge (e.g. a fast corner-resize gesture) never cancels
  // itself mid-drag.
  useEffect(() => {
    if (!hoveredBlock || dragging) return;
    const onPointerDownOutside = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setHoveredBlock(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDownOutside);
    return () => document.removeEventListener("pointerdown", onPointerDownOutside);
  }, [hoveredBlock, dragging]);

  const togglePlay = () => {
    const player = playerRef.current;
    if (!player) return;
    // The only place playback is ever EXPLICITLY paused by the user --
    // mark that real intent here, before toggling, so wasPlayingIntentRef
    // (see its declaration above) reflects "user chose to stop" and not
    // just "Player happens to be paused right now" (which is also true,
    // misleadingly, during a mute-triggered crash's own internal pause).
    if (player.isPlaying()) wasPlayingIntentRef.current = false;
    player.toggle();
  };

  // Pausing playback across the mute/volume call (an earlier attempt at
  // this) turned out worse than the crash it was trying to prevent -- the
  // deferred resume it depended on didn't reliably come back, so muting
  // could leave playback stuck paused entirely, which is a harder
  // requirement to break than the underlying Remotion bug itself (the
  // user must always be able to watch the video muted/quiet, playback
  // continuing regardless). Reverted to applying the change directly.
  // If the underlying Remotion crash fires (see the "error" listener
  // above), the crash-recovery there now leaves playback paused at the
  // correct frame rather than trying to silently resume it -- one extra
  // manual play click in that case, but it always works.
  // Marks explicitAudioGestureRef right before an actual mute/unmute/volume
  // call below (see the ref's own declaration). This timeout is the ONLY
  // place it's ever cleared (onError deliberately does NOT clear it on
  // consumption -- see that comment for why: a single click commonly
  // cascades into a second, separate crash that needs to see the SAME
  // click's gesture too). 2s is generous enough to cover any realistic
  // cascade depth while still being short enough that it won't plausibly
  // still be true by the time a genuinely later, unrelated crash occurs.
  const markExplicitAudioGesture = () => {
    explicitAudioGestureRef.current = true;
    setTimeout(() => {
      explicitAudioGestureRef.current = false;
    }, 2000);
  };

  const toggleMute = () => {
    const player = playerRef.current;
    if (!player) return;
    markExplicitAudioGesture();
    if (player.isMuted()) {
      player.unmute();
      if (volume === 0) {
        setVolume(1);
        player.setVolume(1);
      }
    } else {
      player.mute();
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = Number(e.target.value);
    setVolume(newVolume);
    const player = playerRef.current;
    if (!player) return;
    markExplicitAudioGesture();
    player.setVolume(newVolume);
    if (newVolume === 0 && !isMuted) {
      player.mute();
    } else if (newVolume > 0 && isMuted) {
      player.unmute();
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen().catch(console.error);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const frame = Number(e.target.value);
    playerRef.current?.seekTo(frame);
    currentFrameRef.current = frame;
    setCurrentFrame(frame);
  };

  // Resolves EITHER the currently-hovered/dragged segment's own override
  // (see VerseMapping's per-segment scale fields in types.ts) or, when
  // there isn't one (no mappings for this verse, or the segment has never
  // been individually resized), the same video-wide value QuranVideo.tsx
  // itself falls back to -- so a segment you've never touched displays and
  // drags starting from exactly what's already on screen, not some
  // unrelated default.
  const resolveMappingScale = (
    segmentKey: string | null,
    field: "arabicTextScale" | "arabicWidthScale" | "translationTextScale" | "translationWidthScale",
    fallback: number
  ): number => {
    if (!segmentKey) return fallback;
    const [verseIdStr, idxStr] = segmentKey.split(":");
    const verseId = Number(verseIdStr);
    const idx = Number(idxStr);
    if (!Number.isFinite(verseId) || !Number.isFinite(idx)) return fallback;
    const mapping = inputProps.verses.find((v) => v.id === verseId)?.mappings?.[idx];
    return mapping?.[field] ?? fallback;
  };

  const widthScaleOf = (block: TextBlock, segmentKey: string | null) =>
    resolveMappingScale(
      segmentKey,
      block === "arabic" ? "arabicWidthScale" : "translationWidthScale",
      block === "arabic" ? arabicWidthScale : translationWidthScale
    );
  const textScaleOf = (block: TextBlock, segmentKey: string | null) =>
    resolveMappingScale(
      segmentKey,
      block === "arabic" ? "arabicTextScale" : "translationTextScale",
      block === "arabic" ? arabicTextScale : translationTextScale
    );
  const centerTopOf = (block: TextBlock) => {
    const layout = BLOCK_LAYOUT[block];
    return isPortraitLayout ? layout.portraitCenterTop : layout.compactCenterTop;
  };

  const startWidthDrag = (block: TextBlock, side: "left" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Read fresh at the exact moment the drag starts (not the last polled
    // value) -- the box is only actively re-measured/re-tracked while
    // hovered, so this is the one moment a stale key could otherwise slip
    // through right as playback crosses into a new segment.
    const segmentKey = readSegmentKey(block);
    const state: DragState = {
      kind: "width",
      block,
      side,
      insetPercent: scaleToInsetPercent(widthScaleOf(block, segmentKey)),
      startX: e.clientX,
      segmentKey,
    };
    dragStartRef.current = state;
    setDragging(state);
  };

  const startSizeDrag = (block: TextBlock) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const segmentKey = readSegmentKey(block);
    const scale = textScaleOf(block, segmentKey);
    const state: DragState = { kind: "size", block, scale, startX: e.clientX, startY: e.clientY, segmentKey };
    dragStartRef.current = state;
    setDragging(state);
  };

  useEffect(() => {
    if (!dragging) return;

    const onPointerMove = (e: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;

      if (start.kind === "width") {
        const containerWidth = containerRef.current?.getBoundingClientRect().width;
        if (!containerWidth) return;
        const deltaPercent = ((e.clientX - start.startX) / containerWidth) * 100;
        // Dragging a handle OUTWARD (left handle further left, right handle
        // further right) must always widen the box (lower inset).
        const signedDelta = start.side === "left" ? deltaPercent : -deltaPercent;
        const newInsetPercent = Math.max(0, Math.min(MAX_INSET_PERCENT, start.insetPercent + signedDelta));
        const newScale = insetPercentToScale(newInsetPercent);
        (start.block === "arabic" ? onArabicWidthScaleChange : onTranslationWidthScaleChange)?.(start.segmentKey, newScale);
      } else {
        // Corner resize: dragging right or down grows the text, left or up
        // shrinks it -- matches the handle's own bottom-right position
        // directly, rather than the previous distance-from-the-box-center
        // convention (which pointed the same way along that one diagonal,
        // but felt inconsistent for a mostly-horizontal or mostly-vertical
        // drag since it blended both axes through Euclidean distance).
        const containerRect = containerRef.current?.getBoundingClientRect();
        if (!containerRect) return;
        const dxPercent = ((e.clientX - start.startX) / containerRect.width) * 100;
        const dyPercent = ((e.clientY - start.startY) / containerRect.height) * 100;
        const outwardPercent = (dxPercent + dyPercent) / 2;
        const range = MAX_TEXT_SCALE - MIN_TEXT_SCALE;
        // A drag spanning SIZE_DRAG_SPAN_PERCENT of the container covers the
        // whole MIN..MAX range from wherever the scale started.
        const newScale = Math.max(
          MIN_TEXT_SCALE,
          Math.min(MAX_TEXT_SCALE, start.scale + (outwardPercent / SIZE_DRAG_SPAN_PERCENT) * range)
        );
        (start.block === "arabic" ? onArabicTextScaleChange : onTranslationTextScaleChange)?.(start.segmentKey, newScale);
      }
    };
    const onPointerUp = () => {
      setDragging(null);
      dragStartRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dragging, onArabicWidthScaleChange, onArabicTextScaleChange, onTranslationWidthScaleChange, onTranslationTextScaleChange]);

  const renderTextBlockControl = (block: TextBlock) => {
    const layout = BLOCK_LAYOUT[block];
    const centerTop = centerTopOf(block);
    const scale = textScaleOf(block, activeSegmentKeys[block]);
    const widthScale = widthScaleOf(block, activeSegmentKeys[block]);
    const isActive = hoveredBlock === block || dragging?.block === block;
    const box = boxRects[block];
    const otherBox = boxRects[block === "arabic" ? "translation" : "arabic"];
    const accentBorder = layout.accent === "amber" ? "border-accent-amber" : "border-primary-light";
    const accentBg = layout.accent === "amber" ? "bg-accent-amber" : "bg-primary-light";

    // The padded top/bottom edges of THIS block's own outline (and, for the
    // bottom edge, its corner size handle too). Independently padding each
    // block's facing edge left a visible sliver of gap between the two
    // outlines -- the Arabic verse and translation sit right on top of each
    // other (only TRANSLATION_MARGIN_TOP apart), so it read as two
    // disconnected boxes. Once both are measured, the shared edge (Arabic's
    // bottom / translation's top) snaps to one line split evenly between
    // the two real boxes instead, so they visibly share one border.
    let outlineTop = box ? box.top - BOX_PADDING_PERCENT : 0;
    let outlineBottom = box ? box.top + box.height + BOX_PADDING_PERCENT : 0;
    if (box && otherBox) {
      if (block === "arabic") {
        outlineBottom = (box.top + box.height + otherBox.top) / 2;
      } else {
        outlineTop = (otherBox.top + otherBox.height + box.top) / 2;
      }
    }

    // The single hoverable/draggable region for this block, in OUTER-
    // container percent. Before any real measurement exists, it's the
    // rough guessed band (just enough to trigger the first hover). Once
    // `box` is known, it instead tightly wraps the REAL box plus generous
    // margin -- and, critically, the outline/handles below are rendered as
    // DOM CHILDREN of this same region rather than separate siblings, so
    // moving the mouse from the region onto a handle never fires
    // mouseleave (mouseenter/mouseleave ignore boundary crossings between
    // an element and its own descendants -- crossing between SIBLINGS,
    // which is what the old layout did, does not have that protection,
    // and was exactly why nudging onto a handle made everything vanish).
    const region = box
      ? {
          top: box.top - HOVER_MARGIN_PERCENT,
          left: box.left - HOVER_MARGIN_PERCENT,
          width: box.width + HOVER_MARGIN_PERCENT * 2,
          height: box.height + HOVER_MARGIN_PERCENT * 2 + HOVER_BOTTOM_EXTRA_PERCENT,
        }
      : {
          top: centerTop - INITIAL_HOTZONE_HEIGHT_PERCENT / 2,
          left: 0,
          width: 100,
          height: INITIAL_HOTZONE_HEIGHT_PERCENT,
        };

    // Converts an outer-container percent coordinate into one relative to
    // `region`'s own box -- needed since the region itself is
    // position:absolute (to place it in the outer container), which makes
    // it the containing block for its own position:absolute children.
    const toRegionX = (outerPercent: number) => ((outerPercent - region.left) / region.width) * 100;
    const toRegionY = (outerPercent: number) => ((outerPercent - region.top) / region.height) * 100;

    // APPEARING and DISAPPEARING deliberately use two different rects, not
    // one shared one. `region` (the padded, generous one above) is only
    // for staying visible/interactive once already active -- moving the
    // pointer onto a handle, or lingering in the margin around the text,
    // must never dismiss the box (that was the earlier "vanishes the
    // instant you approach a handle" bug). But using that SAME generous
    // rect to trigger the box in the first place made it pop up before the
    // pointer ever actually reached the text, from anywhere in that margin
    // -- wrong per the user's report. `triggerRect` is the real measured
    // box with NO padding at all: only crossing directly onto the text
    // itself shows the box. It's a separate, tighter DOM child (mouseenter
    // only) nested inside the same outer region (mouseleave only), so
    // approaching from the margin never shows it, but once shown, leaving
    // through that same margin still doesn't hide it until the pointer
    // exits the whole padded region.
    const triggerRect = box ?? region;

    return (
      <div
        key={block}
        className="absolute"
        style={{
          top: `${region.top}%`,
          left: `${region.left}%`,
          width: `${region.width}%`,
          height: `${region.height}%`,
          // The Arabic verse and translation sit close together (only
          // TRANSLATION_MARGIN_TOP apart in QuranVideo.tsx), so their hover
          // regions -- and in particular the Arabic corner handle, which
          // sits just below its own box -- can genuinely overlap the
          // translation region's own margin above IT. Both wrapper divs are
          // always present (needed to detect the initial hover at all), so
          // whichever is later in the DOM would otherwise always win that
          // overlap by default, making the other block's handle
          // unreachable there. Raising the currently-engaged block (the one
          // actually hovered or being dragged) above the other one fixes
          // this: by the time the pointer reaches into the shared area, the
          // block the user is already interacting with was entered through
          // its own unambiguous territory first, so it's already on top.
          zIndex: isActive ? 2 : 1,
        }}
        onMouseLeave={() => setHoveredBlock((v) => (v === block ? null : v))}
      >
        <div
          className="absolute"
          style={{
            top: `${toRegionY(triggerRect.top)}%`,
            left: `${toRegionX(triggerRect.left)}%`,
            width: `${(triggerRect.width / region.width) * 100}%`,
            height: `${(triggerRect.height / region.height) * 100}%`,
          }}
          onMouseEnter={() => setHoveredBlock(block)}
          // Touch has no hover at all -- onMouseEnter above never fires on a
          // phone, so the box/handles this reveals (see isActive below)
          // would otherwise be permanently undiscoverable there: nothing to
          // see, nowhere to know a drag handle even exists. A tap toggles
          // the SAME state onMouseEnter/onMouseLeave already drive, so nothing
          // else about the reveal/handle logic needs to know touch exists.
          // Harmless on desktop too -- hovering already shows this, a click
          // on top of that either changes nothing (still hovered) or, if it
          // happens to toggle off while the mouse sits still, comes back the
          // moment the pointer actually leaves and re-enters.
          onClick={() => setHoveredBlock((v) => (v === block ? null : block))}
        />
        {isActive && box && (
          <>
            <div
              className={`pointer-events-none absolute rounded-sm border border-dashed ${accentBorder}/70`}
              style={{
                top: `${toRegionY(outlineTop)}%`,
                bottom: `${100 - toRegionY(outlineBottom)}%`,
                left: `${toRegionX(box.left - BOX_PADDING_PERCENT)}%`,
                right: `${100 - toRegionX(box.left + box.width + BOX_PADDING_PERCENT)}%`,
              }}
            />
            {(["left", "right"] as const).map((side) => (
              <div
                key={side}
                onPointerDown={startWidthDrag(block, side)}
                role="slider"
                aria-label={`${block} text width`}
                aria-valuemin={MIN_WIDTH_SCALE}
                aria-valuemax={MAX_WIDTH_SCALE}
                aria-valuenow={widthScale}
                className={`absolute flex h-6 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center rounded-full border bg-black/60 backdrop-blur-sm ${accentBorder}/70`}
                style={{
                  top: `${toRegionY(box.top + box.height / 2)}%`,
                  left: `${toRegionX(side === "left" ? box.left - BOX_PADDING_PERCENT : box.left + box.width + BOX_PADDING_PERCENT)}%`,
                }}
              >
                <div className="h-3 w-0.5 rounded-full bg-white/80" />
              </div>
            ))}
            <div
              onPointerDown={startSizeDrag(block)}
              role="slider"
              aria-label={`${block} text size`}
              aria-valuemin={MIN_TEXT_SCALE}
              aria-valuemax={MAX_TEXT_SCALE}
              aria-valuenow={scale}
              className={`absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize touch-none rounded-full border-2 border-black/60 ${accentBg}`}
              style={{
                top: `${toRegionY(outlineBottom)}%`,
                left: `${toRegionX(box.left + box.width + BOX_PADDING_PERCENT)}%`,
              }}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className={`relative mx-auto w-full overflow-hidden bg-black flex items-center justify-center ${isFullscreen ? '' : 'rounded-xl'}`}
      style={isFullscreen ? { width: "100%", height: "100%" } : { maxWidth: 560, aspectRatio: cssAspectRatio }}
    >
      <div
        className={`relative h-full flex flex-col justify-center ${isFullscreen ? '' : 'w-full'}`}
        style={isFullscreen ? { aspectRatio: cssAspectRatio } : {}}
      >
        <Player
          key={crashRecoveryKey}
          ref={playerRef}
          component={QuranVideo}
          inputProps={inputProps}
          durationInFrames={durationInFrames}
          fps={FPS}
          compositionWidth={compositionWidth}
          compositionHeight={compositionHeight}
          style={{ width: "100%", height: "100%" }}
          controls={false}
          clickToPlay={false}
          // Only read on MOUNT (Remotion seeds its own internal
          // playerMuted/mediaVolume state from these once, same as any
          // other "initial*" prop) -- but that's exactly what's needed
          // here: every mount this component ever produces, including a
          // crash-recovery remount via crashRecoveryKey above, picks up
          // OUR current isMuted/volume state instead of always resetting
          // to Remotion's own defaults (unmuted, full volume). Without
          // this, a crash recovered while the user had muted came back
          // audibly unmuted -- the opposite of what they'd chosen, and
          // the "stop losing sound on recovery" this component already
          // aims for elsewhere.
          initiallyMuted={isMuted}
          initialVolume={volume}
          // Default fallback is a bare "⚠️" -- exactly the visible flash
          // the user reported as "gives an error" the instant a crash is
          // caught, even though auto-recovery (the "error" listener
          // above) is about to remount and fix it moments later. Render
          // nothing instead: the black container behind the Player stays
          // as the only thing visible for that one brief frame, same as
          // a normal paused-on-black moment rather than a visible error.
          errorFallback={() => null}
        />

        {permanentlyCrashed && (
          <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/90 px-6 text-center">
            <ExclamationTriangleIcon className="h-10 w-10 text-accent-amber" />
            <p className="max-w-xs text-sm text-white/90">
              {isArabic
                ? "تعذّر تشغيل المعاينة بسبب خلل متكرر في أداة العرض. أعد تحميل الصفحة."
                : "Önizleme oynatıcıda tekrarlayan bir hata oluştu. Sayfayı yeniden yükleyin."}
            </p>
            <button
              type="button"
              onClick={() => {
                recentCrashTimestampsRef.current = [];
                setPermanentlyCrashed(false);
                setCrashRecoveryKey((k) => k + 1);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/30 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              <ArrowPathIcon className="h-4 w-4" />
              {isArabic ? "إعادة المحاولة" : "Tekrar Dene"}
            </button>
          </div>
        )}

        {renderTextBlockControl("arabic")}
        {renderTextBlockControl("translation")}

        {/* pointer-events-none on the wrapper: this bar is painted AFTER (on
            top of) the two text-block hover/drag regions above, so without
            this its padded gradient area would silently swallow every
            pointer event over its (fairly tall) rectangle -- including
            wherever a text box's handles happen to sit underneath it (the
            translation block in particular often reaches down that far).
            A resize/width drag started there never even reached our own
            handle: the browser dispatched it to this bar's seek-bar <input>
            instead, which (range inputs jump straight to the clicked
            position) could snap playback to near frame 0 -- indistinguishable
            from "editing the box reset the video". Each actually-interactive
            control below opts back in with pointer-events-auto so the real
            controls keep working normally. */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-3 pb-6 pt-12 flex flex-col gap-3 pointer-events-none">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <button onClick={togglePlay} className="pointer-events-auto text-white transition-colors hover:text-primary-light">
                {isPlaying ? <PauseIcon className="h-5 w-5" /> : <PlayIcon className="h-5 w-5" />}
              </button>
              <span className="font-mono text-xs text-white/90" dir="ltr">
                {formatTime(currentFrame / FPS)} / {formatTime(durationInFrames / FPS)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <div className="pointer-events-auto flex items-center gap-1.5 sm:gap-2 group" dir="ltr">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="pointer-events-auto w-16 h-1 cursor-pointer accent-primary hidden sm:block opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                  dir="ltr"
                />
                <button onClick={toggleMute} className="pointer-events-auto text-white transition-colors hover:text-primary-light">
                  {isMuted || volume === 0 ? <SpeakerXMarkIcon className="h-5 w-5" /> : <SpeakerWaveIcon className="h-5 w-5" />}
                </button>
              </div>
              <button onClick={toggleFullscreen} className="pointer-events-auto text-white transition-colors hover:text-primary-light">
                {isFullscreen ? <ArrowsPointingInIcon className="h-5 w-5" /> : <ArrowsPointingOutIcon className="h-5 w-5" />}
              </button>
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={durationInFrames}
            step={1}
            value={currentFrame}
            onChange={handleSeek}
            className="pointer-events-auto h-1 w-full cursor-pointer accent-primary"
            dir="ltr"
          />
        </div>
      </div>
    </div>
  );
}
