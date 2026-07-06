"use client";

import React, { useState, useEffect } from "react";
import { XMarkIcon, CheckIcon, ChevronRightIcon, ChevronLeftIcon } from "@heroicons/react/24/outline";

interface Mapping {
  part: number;
  translation_text: string;
  arabic_unit_count: number;
}

interface SegmentationResult {
  surah: number;
  ayah: number;
  mappings: Mapping[];
}

interface Verse {
  id: number;
  text: string;
  page?: number;
}

interface ManualSegmentationEditorProps {
  isOpen: boolean;
  onClose: () => void;
  segmentationData: SegmentationResult[];
  verses: Verse[];
  onConfirm: (adjustedData: SegmentationResult[]) => void;
  isArabic: boolean;
}

export default function ManualSegmentationEditor({
  isOpen,
  onClose,
  segmentationData,
  verses,
  onConfirm,
  isArabic,
}: ManualSegmentationEditorProps) {
  // Local state to hold the editable data
  const [editedData, setEditedData] = useState<SegmentationResult[]>([]);

  useEffect(() => {
    if (isOpen && segmentationData) {
      // Deep copy to allow editing without mutating original until confirmed
      setEditedData(JSON.parse(JSON.stringify(segmentationData)));
    }
  }, [isOpen, segmentationData]);

  if (!isOpen) return null;

  const handleAdjustCount = (verseIdx: number, mappingIdx: number, delta: number) => {
    const newData = [...editedData];
    const mappings = newData[verseIdx].mappings;
    
    // We can only shift words between adjacent mappings
    if (delta > 0) {
      // Trying to increase current mapping's count (take from next)
      if (mappingIdx < mappings.length - 1 && mappings[mappingIdx + 1].arabic_unit_count > 0) {
        mappings[mappingIdx].arabic_unit_count += 1;
        mappings[mappingIdx + 1].arabic_unit_count -= 1;
        
        // If the next mapping becomes empty, merge it into the current one
        if (mappings[mappingIdx + 1].arabic_unit_count === 0) {
          mappings[mappingIdx].translation_text += (mappings[mappingIdx].translation_text ? " " : "") + mappings[mappingIdx + 1].translation_text;
          mappings.splice(mappingIdx + 1, 1);
        }
      }
    } else {
      // Trying to decrease current mapping's count (give to next)
      if (mappings[mappingIdx].arabic_unit_count > 0 && mappingIdx < mappings.length - 1) {
        mappings[mappingIdx].arabic_unit_count -= 1;
        mappings[mappingIdx + 1].arabic_unit_count += 1;
        
        // If the current mapping becomes empty, merge it into the next one
        if (mappings[mappingIdx].arabic_unit_count === 0) {
          mappings[mappingIdx + 1].translation_text = mappings[mappingIdx].translation_text + (mappings[mappingIdx + 1].translation_text ? " " : "") + mappings[mappingIdx + 1].translation_text;
          mappings.splice(mappingIdx, 1);
        }
      }
    }
    
    setEditedData(newData);
  };

  const handleAddSection = (verseIdx: number) => {
    const newData = [...editedData];
    const mappings = newData[verseIdx].mappings;
    const lastMapping = mappings[mappings.length - 1];
    
    if (lastMapping && lastMapping.arabic_unit_count > 1) {
      lastMapping.arabic_unit_count -= 1;
      mappings.push({
        part: mappings.length + 1,
        translation_text: "",
        arabic_unit_count: 1
      });
      setEditedData(newData);
    } else {
      alert(isArabic ? "القسم الأخير يحتوي على كلمة واحدة فقط. لا يمكن إنشاء قسم جديد." : "Son bölümde sadece bir kelime var. Yeni bölüm oluşturulamaz.");
    }
  };

  const handleTranslationChange = (verseIdx: number, mappingIdx: number, newText: string) => {
    const newData = [...editedData];
    newData[verseIdx].mappings[mappingIdx].translation_text = newText;
    setEditedData(newData);
  };

  const handleConfirm = () => {
    onConfirm(editedData);
  };

  const uniquePages = Array.from(new Set(verses.map((v) => v.page).filter(Boolean)));
  const fontFaces = uniquePages
    .map(
      (page) => `
    @font-face {
      font-family: 'p${page}';
      src: url('/fonts/2013/QCF2BSMLfonts/QCF2${String(page).padStart(3, "0")}.ttf') format('truetype');
      font-weight: normal;
      font-style: normal;
      font-display: swap;
    }
  `
    )
    .join("\n");

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: fontFaces }} />
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4">
        <div className="bg-background border-0 sm:border border-border rounded-none sm:rounded-2xl shadow-2xl w-full max-w-4xl h-[100dvh] sm:h-auto sm:max-h-[90vh] flex flex-col overflow-hidden">
          
          {/* Header */}
          <div className="flex items-center justify-between p-4 sm:p-5 border-b border-border">
            <h2 className="text-lg sm:text-xl font-bold text-foreground flex items-center gap-2">
            {isArabic ? "الضبط اليدوي للتقسيم" : "Manuel Bölümleme Ayarı"}
          </h2>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <XMarkIcon className="w-6 h-6" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 sm:space-y-8">
            <div className="bg-primary/10 border border-primary/20 rounded-xl p-4 text-primary text-xs sm:text-sm mb-4">
            {isArabic 
              ? "استخدم أزرار (+ / -) لنقل الكلمات العربية بين الأقسام حتى يتطابق المعنى تماماً مع الترجمة. يمكنك أيضاً تعديل نص الترجمة مباشرة."
              : "Çeviri ile tam olarak eşleşene kadar Arapça kelimeleri bölümler arasında taşımak için (+ / -) düğmelerini kullanın. Çeviri metnini doğrudan da düzenleyebilirsiniz."}
          </div>

          {editedData.map((segResult, verseIdx) => {
            const verse = verses.find(v => v.id === segResult.ayah);
            if (!verse) return null;
            
            const allWords = verse.text.trim().split(/\s+/);
            let currentWordIndex = 0;

            return (
              <div key={`${segResult.surah}-${segResult.ayah}`} className="bg-background rounded-xl overflow-hidden border border-border">
                <div className="bg-muted/30 px-4 py-2 border-b border-border font-medium text-muted-foreground">
                  {isArabic ? `الآية ${segResult.ayah}` : `Ayet ${segResult.ayah}`}
                </div>
                
                <div className="p-4 space-y-4">
                  {segResult.mappings.map((mapping, mappingIdx) => {
                    const chunkWords = allWords.slice(currentWordIndex, currentWordIndex + mapping.arabic_unit_count);
                    currentWordIndex += mapping.arabic_unit_count;

                    return (
                      <div key={mappingIdx} className="flex flex-col gap-3 p-4 rounded-lg bg-card border border-border relative">
                        {/* Translation Part */}
                        <textarea
                          value={mapping.translation_text}
                          onChange={(e) => handleTranslationChange(verseIdx, mappingIdx, e.target.value)}
                          className="w-full bg-transparent text-primary font-medium text-sm sm:text-base border-b border-border/50 pb-2 focus:outline-none focus:border-primary resize-none"
                          rows={Math.max(2, Math.ceil(mapping.translation_text.length / 35))}
                          dir={isArabic ? "rtl" : "ltr"}
                        />
                        
                        {/* Arabic Part Preview */}
                        <div dir="rtl" className="text-right text-foreground text-xl sm:text-2xl leading-relaxed font-arabic mt-2" style={{ fontFamily: verse.page ? `'p${verse.page}'` : "inherit" }}>
                          {chunkWords.join(" ")}
                        </div>
                        
                        {/* Controls - Positioned elegantly at the bottom center of the section */}
                        {mappingIdx < segResult.mappings.length - 1 && (
                          <div className="flex justify-center mt-3 pt-3 border-t border-border/30">
                            <div className="flex items-center bg-muted/30 rounded-full border border-border px-1 py-1 gap-1">
                              <button 
                                onClick={() => handleAdjustCount(verseIdx, mappingIdx, -1)}
                                className="text-muted-foreground hover:text-foreground p-1.5 rounded-full hover:bg-background transition-colors shadow-sm"
                                title={isArabic ? "نقل كلمة للقسم التالي" : "Sonraki bölüme kelime taşı"}
                              >
                                <ChevronLeftIcon className="w-5 h-5" />
                              </button>
                              <div className="w-px h-4 bg-border mx-1"></div>
                              <button 
                                onClick={() => handleAdjustCount(verseIdx, mappingIdx, 1)}
                                className="text-muted-foreground hover:text-foreground p-1.5 rounded-full hover:bg-background transition-colors shadow-sm"
                                title={isArabic ? "أخذ كلمة من القسم التالي" : "Sonraki bölümden kelime al"}
                              >
                                <ChevronRightIcon className="w-5 h-5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  
                  <div className="flex justify-center mt-4">
                    <button
                      onClick={() => handleAddSection(verseIdx)}
                      className="px-4 py-2 bg-muted/30 hover:bg-muted text-muted-foreground hover:text-foreground text-sm font-medium rounded-lg transition-colors border border-border/50 shadow-sm"
                    >
                      {isArabic ? "+ إضافة قسم جديد" : "+ Yeni Bölüm Ekle"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          </div>

          {/* Footer */}
          <div className="p-4 sm:p-5 border-t border-border flex justify-end gap-2 sm:gap-3 bg-background mt-auto">
            <button
              onClick={onClose}
              className="px-4 sm:px-6 py-2 sm:py-2.5 rounded-xl font-medium text-muted-foreground hover:bg-muted transition-colors text-sm sm:text-base"
            >
              {isArabic ? "إلغاء" : "İptal"}
            </button>
            <button
              onClick={handleConfirm}
              className="px-4 sm:px-6 py-2 sm:py-2.5 rounded-xl font-medium text-white bg-primary hover:bg-primary/90 flex items-center gap-2 transition-colors shadow-lg shadow-primary/20 text-sm sm:text-base"
            >
              <CheckIcon className="w-5 h-5" />
              {isArabic ? "اعتماد وإكمال الفيديو" : "Onayla ve Videoyu Tamamla"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
