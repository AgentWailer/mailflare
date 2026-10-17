"use client";

import { useState } from "react";
import type { RefObject } from "react";
import { ArrowUp, SlidersHorizontal, Sparkles } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import type { TranslationKey } from "@/lib/i18n/types";
import type { RefinePreferences } from "./refine-preferences";

const MODES: Array<{ value: RefinePreferences["mode"]; label: TranslationKey }> = [
 { value: "polish", label: "refine.polish" },
 { value: "professional", label: "refine.professional" },
 { value: "friendly", label: "refine.friendly" },
 { value: "shorter", label: "refine.shorter" },
 { value: "longer", label: "refine.longer" },
];

export function ComposeAiBar({ inputRef, instruction, onInstructionChange, preferences, onPreferencesChange, onSubmit, onCaptureSelection, disabled }: {
 inputRef: RefObject<HTMLInputElement | null>;
 instruction: string;
 onInstructionChange(value: string): void;
 preferences: RefinePreferences;
 onPreferencesChange(value: RefinePreferences): void;
 onSubmit(): void;
 onCaptureSelection(): void;
 disabled?: boolean;
}) {
 const { t } = useLanguage();
 const [optionsOpen, setOptionsOpen] = useState(false);
 return <div className="relative mx-4 mb-2 shrink-0" data-compose-ai-bar>
  {optionsOpen && <div className="absolute inset-x-0 bottom-full z-20 mb-2 grid grid-cols-2 gap-2 rounded-xl border border-neutral-200 bg-white p-3 shadow-lg">
   <label className="min-w-0 space-y-1 text-xs text-neutral-600">
    {t("refine.style")}
    <select aria-label={t("refine.style")} value={preferences.mode} disabled={disabled}
     onChange={event => onPreferencesChange({ ...preferences, mode: event.target.value as RefinePreferences["mode"] })}
     className="h-11 w-full rounded-lg border border-neutral-200 bg-white px-2 text-base md:h-9 md:text-sm">
     {MODES.map(mode => <option key={mode.value} value={mode.value}>{t(mode.label)}</option>)}
    </select>
   </label>
   <label className="min-w-0 space-y-1 text-xs text-neutral-600">
    {t("refine.language")}
    <select aria-label={t("refine.language")} value={preferences.language} disabled={disabled}
     onChange={event => onPreferencesChange({ ...preferences, language: event.target.value as RefinePreferences["language"] })}
     className="h-11 w-full rounded-lg border border-neutral-200 bg-white px-2 text-base md:h-9 md:text-sm">
     <option value="keep">{t("refine.keepLanguage")}</option><option value="de">Deutsch</option><option value="en">English</option>
    </select>
   </label>
  </div>}
  <div className="flex min-h-11 items-center gap-1 rounded-full bg-[#f0f4f9] px-2 focus-within:ring-2 focus-within:ring-blue-300">
   <Sparkles aria-hidden="true" className="ml-1 mr-1 h-4 w-4 shrink-0 text-neutral-600" />
   <input ref={inputRef} type="text" aria-label={t("refine.instruction")} placeholder={t("refine.instructionPlaceholder")}
    maxLength={2000} value={instruction} disabled={disabled} onChange={event => onInstructionChange(event.target.value)}
    onPointerDown={onCaptureSelection} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (instruction.trim()) onSubmit(); } }}
    className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-neutral-600 md:text-sm" />
   <button type="button" aria-label={t("refine.settings")} aria-expanded={optionsOpen} disabled={disabled}
    onClick={() => setOptionsOpen(open => !open)} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-200/60">
    <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
   </button>
   {!!instruction.trim() && <button type="button" aria-label={t("refine.generate")} disabled={disabled} onClick={onSubmit}
    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-blue-700 hover:bg-blue-100">
    <ArrowUp aria-hidden="true" className="h-5 w-5" />
   </button>}
  </div>
 </div>;
}
