"use client";

import { useEffect } from "react";
import { useLanguage, useT } from "@/lib/LanguageContext";

type Props = {
  onNewProject: () => void;
  onChangeHere: () => void;
  onCancel: () => void;
};

// Asked before another audio replaces the one a project's parts and trim
// were timed to (VideoCreatorForm's guardAudioChange): the change resets
// them. On 2026-11-08 a switch to a built-in reciter right after an export
// silently wiped a 7-part split; the user only found out on reopening.
export default function AudioChangeDialog({ onNewProject, onChangeHere, onCancel }: Props) {
  const { language } = useLanguage();
  const tx = useT();
  const isArabic = language === "ar";

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="audio-change-title"
        aria-describedby="audio-change-text"
        dir={isArabic ? "rtl" : "ltr"}
        className="w-full max-w-md animate-fade-in space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-lg"
      >
        <h2 id="audio-change-title" className="text-lg font-bold text-foreground">
          {tx("تغيير الصوت", "Sesi değiştir", "Change the audio")}
        </h2>
        <p id="audio-change-text" className="text-sm leading-relaxed text-muted-foreground">
          {tx(
            "أجزاء هذا المشروع وقصّ الصوت مضبوطة على الصوت الحالي، وتغيير الصوت يمسحها. يمكنك تغييره في مشروع جديد (بنفس الآيات والمظهر)، ويبقى هذا المشروع كما هو في «مشاريعي».",
            "Bu projenin bölümleri ve ses kesimi mevcut sese göre ayarlı; sesi değiştirmek bunları siler. Sesi yeni bir projede (aynı ayetler ve görünümle) değiştirebilirsiniz, bu proje «Projelerim»de olduğu gibi kalır.",
            "This project's parts and audio trim are timed to the current audio, and changing the audio clears them. You can change it in a new project (same ayahs and look) and keep this one as it is in My Projects."
          )}
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            autoFocus
            onClick={onNewProject}
            className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
          >
            {tx("غيّره في مشروع جديد", "Yeni bir projede değiştir", "Change it in a new project")}
          </button>
          <button
            type="button"
            onClick={onChangeHere}
            className="rounded-lg border border-accent-red/50 px-4 py-2.5 text-sm font-medium text-accent-red transition-colors hover:bg-accent-red/10"
          >
            {tx("غيّره في هذا المشروع (تُمسح الأجزاء والقصّ)", "Bu projede değiştir (bölümler ve kesim silinir)", "Change it in this project (clears the parts and trim)")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          >
            {tx("إلغاء", "İptal", "Cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
