"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { Sparkles } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { captureRefineTarget } from "./refine-utils";
import type { RefineTarget } from "./refine-utils";

type SelectionAction = { target: RefineTarget; left: number; top: number };

/** A nonmodal selection action; pointer activation must keep the original range. */
export function ComposeSelectionAction({ editorRef, scrollRef, enabled, onCapture, onPolish }: {
 editorRef: RefObject<HTMLDivElement | null>;
 scrollRef: RefObject<HTMLDivElement | null>;
 enabled: boolean;
 onCapture(target: RefineTarget | null): void;
 onPolish(target: RefineTarget): void;
}) {
 const { t } = useLanguage();
 const [action, setAction] = useState<SelectionAction | null>(null);
 const callbacks = useRef({ onCapture, onPolish });
 const buttonRef = useRef<HTMLButtonElement | null>(null);
 useEffect(() => { callbacks.current = { onCapture, onPolish }; });
 useEffect(() => {
  if (!enabled) return;
  const editor = editorRef.current, scroller = scrollRef.current;
  if (!editor || !scroller) return;
  let frame = 0, dismissed = false;
  const capture = () => {
   const target = captureRefineTarget(editor, "selection", window.getSelection());
   const active = document.activeElement;
   const focusedAiControl = active instanceof window.Element && (buttonRef.current?.contains(active) || scroller.parentElement?.contains(active) && active.closest("[data-compose-ai-bar], .compose-toolbar"));
   // Keep a selection while typing an instruction, but never after deselecting
   // in the message or moving to recipients/subject/another application.
   if (target || !focusedAiControl) callbacks.current.onCapture(target);
   return target;
  };
  const measure = () => {
   const nativeSelection = window.getSelection();
   const target = capture();
   if (!target) { setAction(null); return; }
   if (dismissed || typeof target.range.getClientRects !== "function") { setAction(null); return; }
   const clip = scroller.getBoundingClientRect(), viewport = window.visualViewport;
   const topEdge = Math.max(clip.top + 4, (viewport?.offsetTop ?? 0) + 8);
   const bottomEdge = Math.min(clip.bottom - 4, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - 8);
   const rectangles = Array.from(target.range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > topEdge && rect.top < bottomEdge);
   const backwards = nativeSelection?.focusNode === target.range.startContainer && nativeSelection.focusOffset === target.range.startOffset;
   const anchor = backwards ? rectangles[0] : rectangles.at(-1);
   const form = editor.closest("form")?.getBoundingClientRect() ?? clip;
   const leftEdge = Math.max(form.left + 8, (viewport?.offsetLeft ?? 0) + 8);
   const rightEdge = Math.min(form.right - 8, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth) - 8);
   if (!anchor || bottomEdge - topEdge < 44 || rightEdge - leftEdge < 96) { setAction(null); return; }
   const left = Math.max(leftEdge, Math.min(rightEdge - 96, anchor.left + anchor.width / 2 - 48));
   const below = anchor.bottom + 8;
   const top = Math.max(topEdge, Math.min(bottomEdge - 44, below + 44 <= bottomEdge ? below : anchor.top - 52));
   setAction({ target, left, top });
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
  const changed = () => { dismissed = false; capture(); schedule(); };
  const outside = (event: PointerEvent) => {
   if (!(event.target instanceof window.Element) || buttonRef.current?.contains(event.target)) return;
   if (editor.contains(event.target)) { callbacks.current.onCapture(null); dismissed = false; return; }
   setAction(null);
   if (!scroller.parentElement?.contains(event.target) || !event.target.closest("[data-compose-ai-bar], .compose-toolbar")) callbacks.current.onCapture(null);
  };
  const escape = (event: KeyboardEvent) => {
   if (event.key === "Escape") { dismissed = true; setAction(null); }
  };
  const blur = () => { setAction(null); callbacks.current.onCapture(null); };
  document.addEventListener("selectionchange", changed);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", escape);
  scroller.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  window.addEventListener("blur", blur);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  observer?.observe(editor); observer?.observe(scroller);
  schedule();
  return () => {
   cancelAnimationFrame(frame); observer?.disconnect();
   document.removeEventListener("selectionchange", changed);
   document.removeEventListener("pointerdown", outside, true);
   document.removeEventListener("keydown", escape);
   scroller.removeEventListener("scroll", schedule);
   window.removeEventListener("resize", schedule);
   window.removeEventListener("blur", blur);
   window.visualViewport?.removeEventListener("resize", schedule);
   window.visualViewport?.removeEventListener("scroll", schedule);
  };
 }, [enabled, editorRef, scrollRef]);
 if (!enabled || !action) return null;
 return createPortal(<button ref={buttonRef} type="button" data-compose-layer data-compose-selection-action
  aria-label={t("refine.polishSelection")} title={t("refine.polishSelection")}
  style={{ left: action.left, top: action.top }}
  onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()}
  onClick={() => { callbacks.current.onPolish(action.target); setAction(null); }}
  className="fixed z-[170] flex h-11 w-24 select-none items-center justify-center gap-1.5 rounded-full border border-blue-200 bg-white dark:bg-neutral-800 dark:border-blue-700 dark:text-blue-200 text-sm font-medium text-blue-700 shadow-lg hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
  <Sparkles aria-hidden="true" className="h-4 w-4"/>{t("refine.quickPolish")}
 </button>, document.body);
}
