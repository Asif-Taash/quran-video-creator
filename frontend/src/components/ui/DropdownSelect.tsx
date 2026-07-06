"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { AnimatePresence, motion } from "framer-motion";

export interface SelectOption {
  value: number | string;
  label: string;
  subtitle?: string;
  arabic?: string;
}

interface DropdownSelectProps {
  options: SelectOption[];
  value: number | string | null;
  onChange: (value: number | string) => void;
  placeholder: string;
  label?: string;
  disabled?: boolean;
  isRtl?: boolean;
  showArabic?: boolean;
  showNumberBadge?: boolean;
  numberBadgeLabel?: (val: number | string) => string;
  buttonClassName?: string;
  enableSearch?: boolean; // kept for compatibility but not strictly needed anymore
  searchPlaceholder?: string; // kept for compatibility
}

export default function DropdownSelect({
  options,
  value,
  onChange,
  placeholder,
  label,
  disabled = false,
  isRtl = false,
  showArabic = false,
  showNumberBadge = false,
  numberBadgeLabel,
  buttonClassName,
}: DropdownSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);
  const displayValue = isOpen ? query : (selectedOption?.label || "");

  const filteredOptions = query === "" 
    ? options 
    : options.filter(opt => 
        opt.label.toLowerCase().includes(query.toLowerCase()) || 
        (opt.subtitle && opt.subtitle.toLowerCase().includes(query.toLowerCase())) ||
        (opt.arabic && opt.arabic.toLowerCase().includes(query.toLowerCase()))
      );

  const handleSelect = useCallback(
    (optionValue: number | string) => {
      onChange(optionValue);
      setIsOpen(false);
      setQuery("");
    },
    [onChange]
  );

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setQuery("");
      }
    };
    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
      return () => document.removeEventListener("keydown", handleEscape);
    }
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative space-y-2">
      {label && <label className="text-sm font-medium">{label}</label>}

      <div className="relative">
        <input
          type="text"
          disabled={disabled}
          className={[
            "w-full h-[50px] outline-none transition-all duration-300",
            buttonClassName || "rounded-xl border border-border bg-background shadow-sm hover:border-primary/30 hover:shadow-md",
            "text-sm font-medium",
            "focus:border-primary focus:ring-1 focus:ring-primary",
            disabled ? "opacity-50 cursor-not-allowed" : "cursor-text",
            isRtl ? "text-right pl-10 pr-4" : "text-left pr-10 pl-4",
          ].join(" ")}
          dir={isRtl ? "rtl" : "ltr"}
          placeholder={placeholder}
          value={displayValue}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => {
            setIsOpen(true);
            setQuery("");
          }}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (!disabled) {
              setIsOpen(!isOpen);
              if (!isOpen) setQuery("");
            }
          }}
          className={`absolute inset-y-0 flex items-center justify-center px-3 disabled:opacity-50 ${isRtl ? 'left-0' : 'right-0'}`}
        >
          <ChevronDownIcon
            className={[
              "w-4 h-4 text-foreground/40 transition-transform duration-200 pointer-events-none",
              isOpen ? "rotate-180" : "",
            ].join(" ")}
          />
        </button>
      </div>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, scaleY: 0.95 }}
            animate={{ opacity: 1, y: 0, scaleY: 1 }}
            exit={{ opacity: 0, y: -8, scaleY: 0.95 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className={[
              "absolute z-50 mt-1 w-full min-w-[240px]",
              "rounded-xl border border-border bg-surface shadow-lg overflow-hidden",
              "origin-top flex flex-col p-1.5",
            ].join(" ")}
            role="listbox"
          >
            <div className="max-h-60 overflow-y-auto flex flex-col custom-scrollbar pl-1 pr-0.5">
              {filteredOptions.length > 0 ? (
                filteredOptions.map((option) => {
                  const isSelected = option.value === value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => handleSelect(option.value)}
                      className={[
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg",
                        "text-sm transition-colors duration-150",
                        "focus:outline-none focus:bg-primary/10",
                        isSelected
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-foreground hover:bg-primary/5",
                        isRtl ? "text-right flex-row-reverse" : "text-left",
                      ].join(" ")}
                      role="option"
                      aria-selected={isSelected}
                    >
                      {showNumberBadge && (
                        <span
                          className={[
                            "w-8 h-8 flex-shrink-0 rounded-full flex items-center justify-center",
                            "text-xs font-bold transition-colors",
                            isSelected
                              ? "bg-primary text-white"
                              : "bg-primary/10 text-primary",
                          ].join(" ")}
                        >
                          {numberBadgeLabel ? numberBadgeLabel(option.value) : option.value}
                        </span>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{option.label}</div>
                        {option.subtitle && (
                          <div className="text-xs text-foreground/50 truncate">
                            {option.subtitle}
                          </div>
                        )}
                      </div>
                      {showArabic && option.arabic && (
                        <span
                          className="font-uthmanic-hafs text-lg text-primary flex-shrink-0 drop-shadow-sm"
                          dir="rtl"
                        >
                          {option.arabic}
                        </span>
                      )}
                    </button>
                  );
                })
              ) : (
                <div className="text-center p-3 text-sm text-muted-foreground">
                  {isRtl ? "لا توجد نتائج" : "No results found"}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
