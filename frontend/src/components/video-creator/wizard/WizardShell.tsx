"use client";

import { CheckIcon, ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";

export interface WizardStepMeta {
  label: string;
  optional?: boolean;
}

interface WizardShellProps {
  steps: WizardStepMeta[];
  currentStep: number; // 1-based
  onStepClick: (step: number) => void;
  onBack: () => void;
  onNext: () => void;
  onSkip?: () => void;
  canAdvance: boolean;
  isArabic: boolean;
  isLastStep: boolean;
  children: React.ReactNode;
  headerExtra?: React.ReactNode;
  hideFooterNav?: boolean;
}

export default function WizardShell({
  steps,
  currentStep,
  onStepClick,
  onBack,
  onNext,
  onSkip,
  canAdvance,
  isArabic,
  isLastStep,
  children,
  headerExtra,
  hideFooterNav,
}: WizardShellProps) {
  const currentMeta = steps[currentStep - 1];

  return (
    <div className="relative rounded-2xl p-6 md:p-8 space-y-8 shadow-lg">
      {/* Background Layer (Visuals only, keeps overflow-hidden to perfectly clip the gold bar without trapping dropdowns) */}
      <div className="absolute inset-0 bg-surface border border-primary/10 rounded-2xl overflow-hidden -z-10">
        {/* Decorative top accent */}
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary-light via-primary to-primary-dark" />
      </div>

      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden py-1.5 px-1 -mx-1 sm:flex-1 sm:gap-2">
          {steps.map((step, idx) => {
            const stepNum = idx + 1;
            const isCompleted = stepNum < currentStep;
            const isActive = stepNum === currentStep;
            const isClickable = isCompleted;

            return (
              <div key={step.label} className="flex items-center flex-shrink-0">
                <button
                  type="button"
                  disabled={!isClickable}
                  onClick={() => isClickable && onStepClick(stepNum)}
                  className={`relative flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-full text-sm font-semibold transition-all duration-300 ${
                    isActive
                      ? "bg-gradient-to-br from-primary-light via-primary to-primary-dark bg-[length:200%_200%] animate-shimmer text-white shadow-glow"
                      : isCompleted
                      ? "bg-primary/20 text-primary cursor-pointer ring-1 ring-primary/30 hover:bg-primary/30"
                      : "bg-primary/5 text-muted-foreground cursor-not-allowed"
                  }`}
                  title={step.label}
                >
                  {isCompleted ? <CheckIcon className="h-4 w-4" /> : stepNum}
                </button>
                {stepNum < steps.length && (
                  <div
                    className={`h-0.5 w-4 sm:w-8 rounded-full transition-all duration-500 ${
                      isCompleted ? "bg-gradient-to-r from-primary to-primary-light" : "bg-border"
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
        {headerExtra}
      </div>

      <h2 className="text-xl font-semibold flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary-light/30 via-primary/20 to-primary-dark/20 text-sm text-primary ring-1 ring-primary/20">
          {currentStep}
        </span>
        {currentMeta?.label}
      </h2>

      <div key={currentStep} className="animate-fade-in">{children}</div>

      {!isLastStep && (
        <div
          className={`flex items-center justify-between gap-3 pt-2 border-t border-border/50 transition-opacity duration-150 ${
            hideFooterNav ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
        >
          <button
            type="button"
            onClick={onBack}
            disabled={currentStep === 1}
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-medium text-foreground/70 transition-colors hover:bg-surface disabled:opacity-0 disabled:pointer-events-none"
          >
            {isArabic ? (
              <>
                <ChevronRightIcon className="h-4 w-4" />
                {"رجوع"}
              </>
            ) : (
              <>
                <ChevronLeftIcon className="h-4 w-4" />
                {"Geri"}
              </>
            )}
          </button>

          <div className="flex items-center gap-2">
            {currentMeta?.optional && onSkip && (
              <button
                type="button"
                onClick={onSkip}
                className="rounded-lg px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface"
              >
                {isArabic ? "تخطي" : "Atla"}
              </button>
            )}
            <button
              type="button"
              onClick={onNext}
              disabled={!canAdvance}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isArabic ? (
                <>
                  {"التالي"}
                  <ChevronLeftIcon className="h-4 w-4" />
                </>
              ) : (
                <>
                  {"İleri"}
                  <ChevronRightIcon className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
