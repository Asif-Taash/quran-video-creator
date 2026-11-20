"use client";

import { useEffect, useRef, useState } from "react";
import { LinkIcon, PaperClipIcon } from "@heroicons/react/24/outline";
import Spinner from "@/components/ui/Spinner";
import { useT } from "@/lib/LanguageContext";

// Sharing from the TikTok and Instagram apps can put text around the link.
const LINK_IN_TEXT = /https?:\/\/\S+/;

interface AudioLinkInputProps {
  isArabic: boolean;
  onAudio: (file: File) => void;
}

// The one place the user's own audio comes in (2026-11-20, was three
// boxes: a link, an audio file, a video file): paste a link, or pick or drop
// an audio or video file. Pasting a link starts right away; the button is
// for a link typed by hand. A link's audio is handed over as a File too, so
// from there on all three are the same (preview, audio preparation, drafts).
export default function AudioLinkInput({ isArabic, onAudio }: AudioLinkInputProps) {
  const tx = useT();
  const [link, setLink] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Switching back to the reciter tab abandons the download.
  useEffect(() => () => abortRef.current?.abort(), []);

  const fetchAudio = async (text: string) => {
    const url = text.match(LINK_IN_TEXT)?.[0];
    if (!url) {
      setErrorCode("unsupported");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLink(url);
    setErrorCode(null);
    setIsFetching(true);
    try {
      const res = await fetch("/api/video/audio-from-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setErrorCode(data?.code ?? "failed");
        return;
      }
      const title = decodeURIComponent(res.headers.get("X-Audio-Title") ?? "audio");
      const blob = await res.blob();
      onAudio(new File([blob], `${title}.m4a`, { type: "audio/mp4" }));
    } catch {
      if (!controller.signal.aborted) setErrorCode("failed");
    } finally {
      setIsFetching(false);
    }
  };

  const errorMessages: Record<string, string> = {
    unsupported: tx(
      "هذا الرابط غير مدعوم. الصق رابط فيديو من يوتيوب أو تيك توك أو إنستغرام.",
      "Bu bağlantı desteklenmiyor. YouTube, TikTok veya Instagram video bağlantısı yapıştırın.",
      "This link isn't supported. Paste a YouTube, TikTok or Instagram video link.",
    ),
    not_public: tx(
      "تعذر الوصول إلى هذا الفيديو: قد يكون خاصاً أو محذوفاً أو يتطلب تسجيل الدخول.",
      "Bu videoya erişilemedi: özel, silinmiş veya giriş gerektiriyor olabilir.",
      "Couldn't reach this video: it may be private, deleted or require a login.",
    ),
    too_long: tx(
      "هذا الفيديو أطول من 4 ساعات أو بث مباشر.",
      "Bu video 4 saatten uzun veya canlı yayın.",
      "This video is longer than 4 hours or is a live stream.",
    ),
    no_audio: tx("هذا الفيديو بلا صوت.", "Bu videoda ses yok.", "This video has no audio."),
    failed: tx(
      "تعذر إحضار الصوت. تحقق من اتصال الإنترنت وحاول مجدداً، أو نزّل الفيديو واختره بزر المشبك.",
      "Ses getirilemedi. İnternet bağlantınızı kontrol edip yeniden deneyin ya da videoyu indirip ataç düğmesiyle seçin.",
      "Couldn't get the audio. Check your connection and try again, or download the video and pick it with the clip button.",
    ),
  };

  return (
    <div className="flex flex-col gap-2" dir={isArabic ? "rtl" : "ltr"}>
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          const file = e.dataTransfer.files?.[0];
          setDragging(false);
          if (!file) return;
          e.preventDefault();
          setErrorCode(null);
          onAudio(file);
        }}
        className={`flex w-full items-center gap-3 rounded-2xl border bg-background py-2 pe-2 ps-5 shadow-sm transition-all duration-300 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15 hover:border-primary/30 hover:shadow-md ${
          dragging ? "border-primary bg-primary/5 ring-2 ring-primary/20" : "border-border"
        }`}
      >
        <LinkIcon className="h-5 w-5 flex-shrink-0 text-foreground/40" />
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          dir={link ? "ltr" : undefined}
          value={link}
          disabled={isFetching}
          onChange={(e) => {
            setLink(e.target.value);
            setErrorCode(null);
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (!LINK_IN_TEXT.test(text)) return;
            e.preventDefault();
            fetchAudio(text);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (link.trim()) fetchAudio(link);
          }}
          placeholder={tx(
            "الصق رابط يوتيوب أو تيك توك أو إنستغرام",
            "YouTube, TikTok veya Instagram bağlantısı yapıştırın",
            "Paste a YouTube, TikTok or Instagram link",
          )}
          className="min-w-0 flex-1 truncate bg-transparent py-1.5 text-sm font-medium outline-none placeholder:opacity-50 disabled:opacity-60"
        />
        {!isFetching && (
          <>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title={tx("ملف صوت أو فيديو من جهازك", "Cihazınızdan ses veya video dosyası", "An audio or video file from your device")}
              aria-label={tx("ملف صوت أو فيديو من جهازك", "Cihazınızdan ses veya video dosyası", "An audio or video file from your device")}
              className="flex-shrink-0 rounded-xl p-2 text-foreground/50 transition-colors hover:bg-primary/10 hover:text-primary"
            >
              <PaperClipIcon className="h-5 w-5" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,video/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Lets the same file be picked again after "إلغاء" in the dialog.
                e.target.value = "";
                if (!file) return;
                setErrorCode(null);
                onAudio(file);
              }}
            />
          </>
        )}
        {isFetching ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className="flex-shrink-0 rounded-xl px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent-red-bg/60 hover:text-accent-red"
          >
            {tx("إلغاء", "İptal", "Cancel")}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => fetchAudio(link)}
            disabled={!link.trim()}
            className="flex-shrink-0 rounded-xl bg-primary/10 px-4 py-2 text-sm text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
          >
            {tx("إحضار", "Getir", "Get audio")}
          </button>
        )}
      </div>
      {isFetching && (
        <p className="flex items-center gap-2 text-xs font-medium text-foreground">
          <Spinner size="sm" />
          {tx(
            "جاري إحضار الصوت من الرابط، قد يستغرق ذلك دقيقة أو أكثر...",
            "Ses bağlantıdan getiriliyor, bu bir dakika veya daha uzun sürebilir...",
            "Getting the audio from the link, this can take a minute or more...",
          )}
        </p>
      )}
      {!isFetching && !errorCode && (
        <p className="px-2 text-xs text-muted-foreground">
          {tx(
            "أو اختر ملف صوت أو فيديو بزر المشبك، أو اسحبه إلى هنا.",
            "Ya da ataç düğmesiyle bir ses veya video dosyası seçin veya buraya sürükleyin.",
            "Or pick an audio or video file with the clip button, or drop it here.",
          )}
        </p>
      )}
      {errorCode && !isFetching && (
        <p className="animate-fade-in text-xs text-accent-red">{errorMessages[errorCode] ?? errorMessages.failed}</p>
      )}
    </div>
  );
}
