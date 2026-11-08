"use client";

import React from "react";
import { X, Keyboard } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { isApplePlatform } from "./platform-utils";
import type { TranslationKey } from "@/lib/i18n/types";
import type { ShortcutDefinition } from "./types";

interface ShortcutsHelpDialogProps {
  isOpen: boolean;
  onClose: () => void;
  shortcuts: ShortcutDefinition[];
}

// Puts a styled key badge where the translation has its {key} placeholder.
function withKey(text: string, key: string) {
  const [before, after = ""] = text.split("{key}");
  return (
    <>
      {before}
      <kbd className="px-1.5 py-0.5 bg-neutral-200 text-neutral-700 rounded font-mono">{key}</kbd>
      {after}
    </>
  );
}

export function ShortcutsHelpDialog({
  isOpen,
  onClose,
  shortcuts,
}: ShortcutsHelpDialogProps) {
  const { t } = useLanguage();
  if (!isOpen) return null;

  const grouped = shortcuts.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, ShortcutDefinition[]>);

  const apple = isApplePlatform();
  const formatKey = (shortcut: ShortcutDefinition) => {
    const parts: string[] = [];
    if (shortcut.modifiers) {
      // "meta" and "ctrl" together mean either key works: show the one this platform uses.
      const either = shortcut.modifiers.includes("meta") && shortcut.modifiers.includes("ctrl");
      shortcut.modifiers.forEach((m) => {
        if (m === "ctrl" && !(either && apple)) parts.push(t("shortcutsHelp.ctrl"));
        if (m === "meta" && !(either && !apple)) parts.push("⌘");
        if (m === "alt") parts.push("Alt");
        if (m === "shift") parts.push("Shift");
      });
    }
    parts.push(shortcut.key.toUpperCase());
    return parts.join(" + ");
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} overlayClassName="bg-neutral-900/40" className="flex w-[min(672px,calc(100vw-32px))] max-h-[85vh] flex-col overflow-hidden border border-neutral-200 p-0 md:p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-blue-50 text-blue-600 rounded-lg">
              <Keyboard className="w-5 h-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold text-neutral-900">
                {t("shortcutsHelp.title")}
              </DialogTitle>
              <DialogDescription className="text-xs text-neutral-500">
                {t("shortcutsHelp.subtitle")}
              </DialogDescription>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("shortcutsHelp.close")}
            className="text-neutral-500 hover:text-neutral-700 p-1.5 rounded-lg hover:bg-neutral-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Categories */}
        <div className="overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category} className="space-y-3">
              <h3 className="text-xs font-semibold text-neutral-500 border-b border-neutral-100 pb-1.5">
                {t(`shortcut.category.${category}` as TranslationKey)}
              </h3>
              <div className="space-y-2">
                {items.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-neutral-700">
                      {item.label}
                    </span>
                    <kbd className="px-2 py-0.5 text-xs font-mono font-medium text-neutral-600 bg-neutral-100 border border-neutral-200 rounded-md shadow-2xs">
                      {formatKey(item)}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-neutral-50 border-t border-neutral-100 flex items-center justify-between text-xs text-neutral-500">
          <span>{withKey(t("shortcutsHelp.pressToToggle", { key: "{key}" }), "?")}</span>
          <span>{withKey(t("shortcutsHelp.pressToClose", { key: "{key}" }), "Esc")}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
