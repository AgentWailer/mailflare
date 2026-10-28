"use client";

import { useSyncExternalStore } from "react";

const KEY = "mailflare-display-options";
const EVENT = "mailflare:display-options";
export const defaultMailDisplay = { categories: true, preview: true, unreadMarks: true, avatars: false, pageSize: 25 };
export type MailDisplayOptions = typeof defaultMailDisplay;
let memory: string | null = null;
function snapshot() { if (memory !== null) return memory; try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } }
function subscribe(notify: () => void) {
 const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) { memory = null; notify(); } };
 window.addEventListener(EVENT, notify); window.addEventListener("storage", storage);
 return () => { window.removeEventListener(EVENT, notify); window.removeEventListener("storage", storage); };
}
export function parseMailDisplay(raw: string): MailDisplayOptions {
 try {
  const saved = JSON.parse(raw), next = { ...defaultMailDisplay };
  if (!saved || typeof saved !== "object") return next;
  for (const key of ["categories", "preview", "unreadMarks", "avatars"] as const) if (typeof saved[key] === "boolean") next[key] = saved[key];
  if ([25, 50, 100].includes(saved.pageSize)) next.pageSize = saved.pageSize;
  return next;
 } catch { return { ...defaultMailDisplay }; }
}
export function readMailDisplayOptions() { return parseMailDisplay(snapshot()); }
export function useMailDisplayOptions(): [MailDisplayOptions, (patch: Partial<MailDisplayOptions>) => void] {
 const raw = useSyncExternalStore(subscribe, snapshot, () => "");
 return [parseMailDisplay(raw), patch => {
  memory = JSON.stringify(parseMailDisplay(JSON.stringify({ ...parseMailDisplay(snapshot()), ...patch })));
  try { localStorage.setItem(KEY, memory); } catch { /* Cosmetic settings work in memory too. */ }
  window.dispatchEvent(new Event(EVENT));
 }];
}
