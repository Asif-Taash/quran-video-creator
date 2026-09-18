"use client";

import DropdownSelect from "@/components/ui/DropdownSelect";
import Spinner from "@/components/ui/Spinner";
import { MusicalNoteIcon, VideoCameraIcon, XMarkIcon } from "@heroicons/react/24/outline";

interface Step3Props {
  isArabic: boolean;
  audioSourceMode: "reciter" | "custom";
  setAudioSourceMode: (m: "reciter" | "custom") => void;
  selectedReciter: string;
  onReciterChange: (val: string) => void;
  customAudio: File | null;
  handleCustomAudioUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleVideoUploadForAudio: (e: React.ChangeEvent<HTMLInputElement>) => void;
  removeCustomAudio: () => void;

  // Also expands the unified audio-trim/timing panel (below the video
  // preview) and scrolls it into view when audio is already prepared --
  // see VideoCreatorForm.tsx's handlePrepareAudio.
  handlePrepareAudio: () => void;
  isPreparingAudio: boolean;
  audioProgressStage: string | null;
  preparedAudioUrl: string | null;
  selectedSurah: unknown;
  startVerse: number | null;
  endVerse: number | null;
}

export default function Step3Audio({
  isArabic,
  audioSourceMode,
  setAudioSourceMode,
  selectedReciter,
  onReciterChange,
  customAudio,
  handleCustomAudioUpload,
  handleVideoUploadForAudio,
  removeCustomAudio,
  handlePrepareAudio,
  isPreparingAudio,
  audioProgressStage,
  preparedAudioUrl,
  selectedSurah,
  startVerse,
  endVerse,
}: Step3Props) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <div className="flex p-1 bg-primary/5 rounded-xl border border-primary/10 mb-2 relative">
          <button
            type="button"
            onClick={() => setAudioSourceMode("reciter")}
            className={`flex-1 flex items-center justify-center py-2.5 px-4 text-sm font-medium rounded-lg transition-all duration-300 relative z-10 ${audioSourceMode === "reciter"
                ? "bg-background text-primary shadow-sm border border-primary/20"
                : "text-muted-foreground hover:text-foreground"
              }`}
          >
            {isArabic ? "اختر قارئ" : "Kari Seç"}
          </button>
          <button
            type="button"
            onClick={() => setAudioSourceMode("custom")}
            className={`flex-1 flex items-center justify-center py-2.5 px-4 text-sm font-medium rounded-lg transition-all duration-300 relative z-10 ${audioSourceMode === "custom"
                ? "bg-background text-primary shadow-sm border border-primary/20"
                : "text-muted-foreground hover:text-foreground"
              }`}
          >
            {isArabic ? "رفع ملف صوتي" : "Kendi Sesini Yükle"}
          </button>
        </div>

        {audioSourceMode === "reciter" ? (
          <DropdownSelect
            placeholder={isArabic ? "مشاري راشد العفاسي" : "Mishary Rashed Alafasy"}
            options={[
              { value: "mishary_alafasy", label: isArabic ? "مشاري راشد العفاسي" : "Mishary Rashed Alafasy" },
              { value: "maher_muaiqly", label: isArabic ? "ماهر المعيقلي" : "Maher Al-Muaiqly" },
              { value: "ahmed_ajmi", label: isArabic ? "أحمد العجمي" : "Ahmed Al-Ajmi" },
              { value: "yasser_dosari", label: isArabic ? "ياسر الدوسري" : "Yasser Al-Dosari" },
              { value: "abdullah_mousa", label: isArabic ? "عبدالله الموسى" : "Abdullah Al-Mousa" },
              { value: "raad_alkurdi", label: isArabic ? "رعد محمد الكردي" : "Raad Mohammad Al Kurdi" },
            ]}
            value={selectedReciter}
            onChange={(val) => onReciterChange(val as string)}
            isRtl={isArabic}
          />
        ) : (
          <div className="w-full">
            {customAudio ? (() => {
              // Some mobile browsers leave File.type empty for a picked
              // video, so fall back to sniffing the extension -- otherwise
              // an uploaded video would render (and likely fail to play) in
              // an <audio> tag instead of <video>.
              const isVideoFile =
                customAudio.type.startsWith("video/") ||
                /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(customAudio.name);
              return (
              <>
                <div className={`w-full flex items-center justify-between gap-3 rounded-2xl border border-border bg-background px-5 py-3.5 shadow-sm text-sm font-medium transition-all duration-300 ${isArabic ? 'text-right' : 'text-left'}`} dir={isArabic ? 'rtl' : 'ltr'}>
                  <div className="flex items-center gap-3 overflow-hidden">
                    <MusicalNoteIcon className="h-5 w-5 text-primary flex-shrink-0" />
                    <span className="truncate">
                      {customAudio.name}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={removeCustomAudio}
                    className="text-foreground/40 hover:text-accent-red hover:bg-accent-red-bg/60 p-1.5 rounded-lg transition-colors flex-shrink-0"
                    title={isArabic ? "حذف" : "Sil"}
                  >
                    <XMarkIcon className="h-5 w-5" />
                  </button>
                </div>
                {isVideoFile ? (
                  <video controls src={URL.createObjectURL(customAudio)} className="w-full mt-3 rounded-lg outline-none max-h-64" />
                ) : (
                  <audio controls src={URL.createObjectURL(customAudio)} className="w-full mt-3 h-10 rounded-lg outline-none" />
                )}
              </>
              );
            })() : (
              <div className="flex flex-col gap-3">
                <label className={`w-full flex items-center justify-between gap-3 rounded-2xl border border-border bg-background px-5 py-3.5 shadow-sm hover:border-primary/30 hover:shadow-md text-sm font-medium transition-all duration-300 cursor-pointer ${isArabic ? 'text-right' : 'text-left'}`} dir={isArabic ? 'rtl' : 'ltr'}>
                  <span className="opacity-50 truncate">
                    {isArabic ? "تصفح لاختيار ملف صوتي مخصص..." : "Özel bir ses dosyası seçin..."}
                  </span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <MusicalNoteIcon className="w-5 h-5 text-foreground/40" />
                  </div>
                  <input type="file" accept="audio/*" className="hidden" onChange={handleCustomAudioUpload} />
                </label>

                <label className={`w-full flex items-center justify-between gap-3 rounded-2xl border border-border bg-background px-5 py-3.5 shadow-sm hover:border-primary/30 hover:shadow-md text-sm font-medium transition-all duration-300 cursor-pointer ${isArabic ? 'text-right' : 'text-left'}`} dir={isArabic ? 'rtl' : 'ltr'}>
                  <span className="opacity-70 truncate">
                    {isArabic ? "أو استخرج الصوت من ملف فيديو..." : "Veya videodan sesi çıkarın..."}
                  </span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <VideoCameraIcon className="w-5 h-5 text-foreground/40" />
                  </div>
                  <input type="file" accept="video/*" className="hidden" onChange={handleVideoUploadForAudio} />
                </label>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="pt-4 border-t border-border/50">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex-1">
            <h4 className="text-sm font-medium text-foreground">
              {isArabic ? "تجهيز وتعديل الصوت (إلزامي)" : "Sesi Hazırla ve Düzenle (Zorunlu)"}
            </h4>
            <p className="text-xs text-muted-foreground mt-1">
              {isArabic
                ? "استخدم هذه الميزة لسماع الصوت وقص أطرافه بدقة إذا كانت هناك كلمات مقطوعة."
                : "Kesilmiş kelimeler varsa sesin uçlarını hassas bir şekilde kesmek veya uzatmak için bu özelliği kullanın."}
            </p>
            {preparedAudioUrl && !isPreparingAudio && (
              <p className="animate-fade-in text-xs text-accent-green font-medium mt-1">
                {isArabic ? "✅ تم تجهيز الصوت بنجاح" : "✅ Ses başarıyla hazırlandı"}
              </p>
            )}
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={handlePrepareAudio}
              disabled={
                isPreparingAudio ||
                !selectedSurah ||
                startVerse === null ||
                endVerse === null ||
                (audioSourceMode === "custom" && !customAudio)
              }
              className="w-full sm:w-auto px-4 py-2.5 sm:py-2 text-sm rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 flex-shrink-0"
            >
              {isPreparingAudio ? (
                <>
                  <Spinner size="sm" />
                  <span>{isArabic ? "جاري التجهيز..." : "Hazırlanıyor..."}</span>
                </>
              ) : (
                <span>{isArabic ? (preparedAudioUrl ? "تعديل الصوت والتوقيت" : "تجهيز الصوت") : (preparedAudioUrl ? "Ses ve Zamanlamayı Düzenle" : "Sesi Hazırla")}</span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
