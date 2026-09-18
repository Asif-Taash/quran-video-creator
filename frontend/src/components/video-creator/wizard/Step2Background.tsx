"use client";

import { PhotoIcon, VideoCameraIcon, XMarkIcon } from "@heroicons/react/24/outline";
import Spinner from "@/components/ui/Spinner";

interface Step2Props {
  isArabic: boolean;
  bgPreview: string | null;
  handleImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  removeImage: () => void;
  handleGenerateBg: () => void;
  isGeneratingBg: boolean;
  bgVideoPreview: string | null;
  handleVideoUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  removeVideo: () => void;
}

export default function Step2Background({
  isArabic,
  bgPreview,
  handleImageUpload,
  removeImage,
  handleGenerateBg,
  isGeneratingBg,
  bgVideoPreview,
  handleVideoUpload,
  removeVideo,
}: Step2Props) {
  return (
    <div
      className="group relative flex min-h-[220px] w-full flex-col items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed border-border/60 bg-gradient-to-b from-surface/30 to-background/50 p-6 transition-all duration-500 hover:border-primary/40 hover:bg-surface/50"
      onClick={(e) => {
        // Only open lightbox if clicking the container area (not buttons/labels)
        const target = e.target as HTMLElement;
        if (bgPreview && !target.closest('button') && !target.closest('label')) {
          window.open(bgPreview, '_blank');
        }
      }}
      style={{ cursor: bgPreview ? 'pointer' : 'default' }}
    >
      {bgVideoPreview ? (
        <>
          <video
            src={bgVideoPreview}
            autoPlay
            muted
            loop
            playsInline
            className="animate-fade-in absolute inset-0 h-full w-full object-cover opacity-60 transition-transform duration-700 group-hover:scale-105"
          />
          <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px] transition-opacity duration-500 group-hover:bg-black/40" />

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeVideo(); }}
            className="relative z-10 inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/60 px-5 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-accent-red hover:bg-accent-red hover:shadow-[0_0_20px_rgba(239,68,68,0.4)]"
          >
            <XMarkIcon className="h-4 w-4 transition-transform duration-300 group-hover:rotate-90" />
            {isArabic ? "إزالة الفيديو" : "Videoyu Kaldır"}
          </button>
        </>
      ) : bgPreview ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={bgPreview} alt="" className="animate-fade-in absolute inset-0 h-full w-full object-cover opacity-60 transition-transform duration-700 group-hover:scale-105" />
          <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px] transition-opacity duration-500 group-hover:bg-black/40" />

          {/* Hint text for clicking to preview */}
          <p className="relative z-10 text-xs text-white/70 mb-3 pointer-events-none">
            {isArabic ? "اضغط على الصورة لعرضها بالحجم الكامل" : "Tam boyut önizleme için resme tıklayın"}
          </p>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeImage(); }}
            className="relative z-10 inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/60 px-5 py-2.5 text-sm font-medium text-white shadow-xl backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:border-accent-red hover:bg-accent-red hover:shadow-[0_0_20px_rgba(239,68,68,0.4)]"
          >
            <XMarkIcon className="h-4 w-4 transition-transform duration-300 group-hover:rotate-90" />
            {isArabic ? "إزالة الصورة" : "Resmi Kaldır"}
          </button>
        </>
      ) : (
        <div className="relative z-10 flex flex-col items-center space-y-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary shadow-inner transition-transform duration-500 group-hover:scale-110">
            <PhotoIcon className="h-8 w-8" />
          </div>
          <div className="space-y-1.5">
            <p className="text-base font-semibold tracking-tight text-foreground transition-colors duration-300 group-hover:text-primary">
              {isArabic ? "ارفع صورة أو فيديو ليكون خلفية الفيديو" : "Video arka planı için resim veya video yükleyin"}
            </p>
            <p className="text-sm text-muted-foreground">
              {isArabic ? "عند عدم اختيار خلفية سيتم استخدام خلفية سوداء." : "Arka plan seçilmezse siyah arka plan kullanılır."}
            </p>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-6 py-2.5 text-sm font-medium text-primary transition-all duration-300 hover:-translate-y-0.5 hover:bg-primary hover:text-white hover:shadow-glow">
              <PhotoIcon className="h-4 w-4" />
              {isArabic ? "اختر صورة" : "Resim Seç"}
              <input type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
            </label>
            <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-6 py-2.5 text-sm font-medium text-primary transition-all duration-300 hover:-translate-y-0.5 hover:bg-primary hover:text-white hover:shadow-glow">
              <VideoCameraIcon className="h-4 w-4" />
              {isArabic ? "اختر فيديو" : "Video Seç"}
              <input type="file" accept="video/*" className="hidden" onChange={handleVideoUpload} />
            </label>
          </div>
          <button
            type="button"
            onClick={handleGenerateBg}
            disabled={isGeneratingBg}
            className="mt-2 inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-primary/20 bg-primary/10 px-6 py-2.5 text-sm font-medium text-primary transition-all duration-300 hover:-translate-y-0.5 hover:bg-primary/20 hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGeneratingBg ? (
              <>
                <Spinner size="sm" />
                {isArabic ? "جاري التوليد..." : "Oluşturuluyor..."}
              </>
            ) : (
              <>
                {isArabic ? "توليد بالذكاء الاصطناعي" : "AI ile Arka Plan Oluştur"}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
