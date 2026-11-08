"use client";

import { Command } from "cmdk";
import type { CommandItem } from "./types";

interface CommandPaletteItemProps {
  item: CommandItem;
  onSelect: () => void;
}

// cmdk marks the pointer- or keyboard-active option with data-selected and aria-selected;
// the selected colours are in globals.css ([cmdk-item][data-selected=true]).
export function CommandPaletteItem({ item, onSelect }: CommandPaletteItemProps) {
  const Icon = item.icon;

  return (
    <Command.Item
      value={item.id}
      onSelect={onSelect}
      className="flex w-full cursor-pointer items-center justify-between rounded-xl px-3 py-2.5 text-left text-neutral-800 transition-colors"
    >
      <div className="flex min-w-0 items-center gap-3">
        {Icon && <Icon className="h-4 w-4 shrink-0 text-neutral-500" />}
        <div className="truncate">
          <span className="text-sm font-medium">{item.title}</span>
          {item.subtitle && <span className="ml-2 truncate text-xs text-neutral-500">{item.subtitle}</span>}
        </div>
      </div>
      {item.shortcut && (
        <kbd className="shrink-0 rounded-md border border-neutral-200 bg-neutral-100 px-2 py-0.5 font-mono text-xs font-medium text-neutral-500">
          {item.shortcut}
        </kbd>
      )}
    </Command.Item>
  );
}
