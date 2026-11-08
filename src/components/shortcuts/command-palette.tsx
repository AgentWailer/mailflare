"use client";

import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { Search, CornerDownLeft } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { CommandItem } from "./types";
import type { TranslationKey } from "@/lib/i18n/types";
import { filterCommands, groupCommandsByCategory } from "./command-palette-utils";
import { CommandPaletteItem } from "./command-palette-item";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: CommandItem[];
}

// cmdk supplies the combobox/listbox semantics and the announced active option; the Radix dialog
// keeps focus inside the palette, closes on Escape and returns focus to where it was opened.
function CommandPaletteDialog({ onClose, commands }: { onClose: () => void; commands: CommandItem[] }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  // The palette unmounts when it closes, so return focus to where it was opened (or to its button).
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement as HTMLElement | null));
  useEffect(() => () => {
    requestAnimationFrame(() => {
      // A command that moved focus itself (the composer, a dialog) keeps it.
      if (document.activeElement && document.activeElement !== document.body) return;
      const target = opener?.isConnected && opener !== document.body ? opener : document.querySelector<HTMLElement>("[data-command-palette-trigger]");
      target?.focus({ preventScroll: true });
    });
  }, [opener]);
  const filteredCommands = useMemo(() => filterCommands(commands, query), [commands, query]);
  const grouped = useMemo(() => groupCommandsByCategory(filteredCommands), [filteredCommands]);
  const run = (item: CommandItem) => {
    item.perform();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        overlayClassName="bg-neutral-900/40"
        className="top-24 w-[min(576px,calc(100vw-32px))] translate-y-0 overflow-hidden p-0 md:p-0"
      >
        <DialogTitle className="sr-only">{t("search.openPalette")}</DialogTitle>
        <Command label={t("search.openPalette")} shouldFilter={false} loop className="flex flex-col">
          <div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-3.5">
            <Search aria-hidden="true" className="h-5 w-5 shrink-0 text-neutral-500" />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder={t("palette.placeholder")}
              className="w-full bg-transparent text-[15px] text-neutral-900 placeholder:text-neutral-500 focus:outline-none"
            />
            <kbd className="shrink-0 rounded-md border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-500">Esc</kbd>
          </div>
          <Command.List className="max-h-80 overflow-y-auto overscroll-contain p-2">
            <Command.Empty className="p-8 text-center text-sm text-neutral-500">{t("palette.noMatch", { query })}</Command.Empty>
            {Object.entries(grouped).map(([category, items]) => (
              <Command.Group
                key={category}
                heading={t(`shortcut.category.${category}` as TranslationKey)}
                className="mb-2 last:mb-0"
              >
                {items.map((item) => <CommandPaletteItem key={item.id} item={item} onSelect={() => run(item)} />)}
              </Command.Group>
            ))}
          </Command.List>
          <div className="flex items-center justify-between border-t border-neutral-100 bg-neutral-50 px-4 py-2.5 text-xs text-neutral-500">
            <div className="flex items-center gap-3">
              <span><kbd className="mr-1 rounded bg-neutral-200 px-1.5 py-0.5 text-[10px]">↑↓</kbd>{t("palette.navigate")}</span>
              <span className="flex items-center"><CornerDownLeft aria-hidden="true" className="mr-1 inline h-3 w-3" />{t("palette.select")}</span>
            </div>
            <span>{t("palette.actions")}</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export function CommandPalette({ isOpen, onClose, commands }: CommandPaletteProps) {
  if (!isOpen) return null;
  return <CommandPaletteDialog onClose={onClose} commands={commands} />;
}
