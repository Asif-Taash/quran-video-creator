"use client";

import DropdownSelect from "@/components/ui/DropdownSelect";
import Spinner from "@/components/ui/Spinner";
import { MusicalNoteIcon, VideoCameraIcon, XMarkIcon } from "@heroicons/react/24/outline";

import { useT } from "@/lib/LanguageContext";
import { RECITERS } from "@/lib/reciterNames";
interface Step3Props {
  isArabic: boolean;
  audioSourceMode: "reciter" | "custom";
  setAudioSourceMode: (m: "reciter" | "custom") => void;
  selectedReciter: string;
  onReciterChange: (val: string) => void;
  // The reciter's name under the surah name -- an Arabic video only (see
  // QuranVideoProps.reciterName), so the option shows only then.
  showReciterNameOption: boolean;
  showReciterName: boolean;
  onShowReciterNameChange: (show: boolean) => void;
  reciterNameText: string;
  onReciterNameTextChange: (text: string) => void;
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
  showReciterNameOption,
  showReciterName,
  onShowReciterNameChange,
  reciterNameText,
  onReciterNameTextChange,
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
  const tx = useT();
  const isReady =
    Boolean(selectedSurah) &&
    startVerse !== null &&
    endVerse !== null &&
    (audioSourceMode === "custom" ? Boolean(customAudio) : Boolean(selectedReciter));
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
            {tx("اختر قارئ", "Kari Seç", "Choose Reciter")}
          </button>
          <button
            type="button"
            onClick={() => setAudioSourceMode("custom")}
            className={`flex-1 flex items-center justify-center py-2.5 px-4 text-sm font-medium rounded-lg transition-all duration-300 relative z-10 ${audioSourceMode === "custom"
                ? "bg-background text-primary shadow-sm border border-primary/20"
                : "text-muted-foreground hover:text-foreground"
              }`}
          >
            {tx("رفع ملف صوتي", "Kendi Sesini Yükle", "Upload Your Own Audio")}
          </button>
        </div>

        {audioSourceMode === "reciter" ? (
          <DropdownSelect
            placeholder={tx("اختر القارئ", "Kari seçin", "Choose a reciter")}
            options={RECITERS.map((r) => ({
              value: r.id,
              label: isArabic ? r.nameAr : r.labelLatin ?? r.nameLatin,
            }))}
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
                    title={tx("حذف", "Sil", "Delete")}
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
                    {tx("تصفح لاختيار ملف صوتي مخصص...", "Özel bir ses dosyası seçin...", "Choose a custom audio file...")}
                  </span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <MusicalNoteIcon className="w-5 h-5 text-foreground/40" />
                  </div>
                  <input type="file" accept="audio/*" className="hidden" onChange={handleCustomAudioUpload} />
                </label>

                <label className={`w-full flex items-center justify-between gap-3 rounded-2xl border border-border bg-background px-5 py-3.5 shadow-sm hover:border-primary/30 hover:shadow-md text-sm font-medium transition-all duration-300 cursor-pointer ${isArabic ? 'text-right' : 'text-left'}`} dir={isArabic ? 'rtl' : 'ltr'}>
                  <span className="opacity-70 truncate">
                    {tx("أو استخرج الصوت من ملف فيديو...", "Veya videodan sesi çıkarın...", "Or extract the audio from a video...")}
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

        {showReciterNameOption && (
          <div
            className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-3"
            dir={isArabic ? "rtl" : "ltr"}
          >
            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={showReciterName}
                onChange={(e) => onShowReciterNameChange(e.target.checked)}
                className="peer sr-only"
              />
              <span
                aria-hidden
                className="relative h-5 w-9 flex-shrink-0 rounded-full bg-border transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:left-[18px] peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40"
              />
              <span className="text-xs font-medium text-muted-foreground">
                {tx("إظهار اسم القارئ تحت اسم السورة", "Kâri adını sure adının altında göster", "Show the reciter's name under the surah name")}
              </span>
            </label>
            {showReciterName && (
              <input
                type="text"
                dir="rtl"
                value={reciterNameText}
                onChange={(e) => onReciterNameTextChange(e.target.value)}
                maxLength={80}
                placeholder={tx("اكتب اسم القارئ (اختياري)", "Kâri adını yazın (isteğe bağlı)", "Type the reciter's name (optional)")}
                className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-right text-sm shadow-sm outline-none transition-colors focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
              />
            )}
          </div>
        )}
      </div>

      {/* The video is created automatically once the reciter (or an
          uploaded file) is chosen -- see VideoCreatorForm's auto-prepare
          effect. This row only reports that, and keeps a manual button for
          retrying a failed attempt or opening the audio/timing editor. */}
      <div className="pt-4 border-t border-border/50">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1 text-xs">
            {isPreparingAudio ? (
              <p className="flex items-center gap-2 font-medium text-foreground">
                <Spinner size="sm" />
                {audioProgressStage ?? tx("جاري إنشاء الفيديو...", "Video oluşturuluyor...", "Creating the video...")}
              </p>
            ) : preparedAudioUrl ? (
              <p className="animate-fade-in font-medium text-accent-green">
                {tx("✅ الفيديو جاهز بالأسفل", "✅ Video aşağıda hazır", "✅ The video is ready below")}
              </p>
            ) : (
              <p className="text-muted-foreground">
                {tx("سيُنشأ الفيديو تلقائياً بعد اختيار القارئ.", "Kari seçildikten sonra video otomatik oluşturulur.", "The video is created automatically once a reciter is chosen.")}
              </p>
            )}
          </div>
          {(preparedAudioUrl || (!isPreparingAudio && isReady)) && (
            <button
              type="button"
              onClick={handlePrepareAudio}
              disabled={isPreparingAudio}
              className="w-full sm:w-auto px-4 py-2.5 sm:py-2 text-sm rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 flex-shrink-0"
            >
              {preparedAudioUrl
                ? tx("تعديل الصوت والتوقيت", "Ses ve Zamanlamayı Düzenle", "Edit Audio and Timing")
                : tx("إنشاء الفيديو", "Videoyu Oluştur", "Create the Video")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
