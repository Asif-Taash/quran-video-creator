"use client";

import { useEffect, useRef, useState } from "react";
import { LinkIcon } from "@heroicons/react/24/outline";
import Spinner from "@/components/ui/Spinner";
import { useT } from "@/lib/LanguageContext";

// Sharing from the TikTok and Instagram apps can put text around the link.
const LINK_IN_TEXT = /https?:\/\/\S+/;

interface AudioLinkInputProps {
  isArabic: boolean;
  onAudio: (file: File) => void;
}

// Pasting a link starts right away; the button is for a link typed by hand.
// The result is handed over as a File, so from there on it's the same as a
// file the user picked (preview, audio preparation, drafts).
export default function AudioLinkInput({ isArabic, onAudio }: AudioLinkInputProps) {
  const tx = useT();
  const [link, setLink] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
      "تعذر إحضار الصوت. تحقق من اتصال الإنترنت وحاول مجدداً، أو نزّل الفيديو وارفعه من الخانة أدناه.",
      "Ses getirilemedi. İnternet bağlantınızı kontrol edip yeniden deneyin ya da videoyu indirip aşağıdan yükleyin.",
      "Couldn't get the audio. Check your connection and try again, or download the video and upload it below.",
    ),
  };

  return (
    <div className="flex flex-col gap-2" dir={isArabic ? "rtl" : "ltr"}>
      <div className="flex w-full items-center gap-3 rounded-2xl border border-border bg-background py-2 pe-2 ps-5 shadow-sm transition-all duration-300 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15 hover:border-primary/30 hover:shadow-md">
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
            "الصق رابط يوتيوب أو تيك توك أو إنستغرام...",
            "YouTube, TikTok veya Instagram bağlantısı yapıştırın...",
            "Paste a YouTube, TikTok or Instagram link...",
          )}
          className="min-w-0 flex-1 truncate bg-transparent py-1.5 text-sm font-medium outline-none placeholder:opacity-50 disabled:opacity-60"
        />
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
      {errorCode && !isFetching && (
        <p className="animate-fade-in text-xs text-accent-red">{errorMessages[errorCode] ?? errorMessages.failed}</p>
      )}
    </div>
  );
}
