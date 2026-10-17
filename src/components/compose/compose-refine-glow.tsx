"use client";

import { useEffect, useState } from "react";
import type { RefObject } from "react";
import type { RefineTarget } from "./refine-utils";

type GlowRect = { left: number; top: number; width: number; height: number };
const highlightName = "mailflare-refining";

/** Highlight and paint ranges without inserting anything into the editable HTML. */
export function ComposeRefineGlow({ target, editorRef, scrollRef }: {
 target: RefineTarget;
 editorRef: RefObject<HTMLDivElement | null>;
 scrollRef: RefObject<HTMLDivElement | null>;
}) {
 const [rectangles, setRectangles] = useState<GlowRect[]>([]);
 useEffect(() => {
  const editor = editorRef.current, scroller = scrollRef.current;
  if (!editor || !scroller) return;
  const registry = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
  const highlight = registry && typeof Highlight === "function" ? registry.get(highlightName) ?? new Highlight() : null;
  if (highlight && registry) { highlight.add(target.range); registry.set(highlightName, highlight); }
  let frame = 0;
  const measure = () => {
   if (!editor.contains(target.range.startContainer) || !editor.contains(target.range.endContainer) || typeof target.range.getClientRects !== "function") { setRectangles([]); return; }
   const parent = scroller.getBoundingClientRect();
   const boxes = Array.from(target.range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
   // Range rects include enclosing block boxes as well as text lines. Keep the lines.
   const lines = boxes.filter(rect => !boxes.some(other => other !== rect &&
    (rect.width > other.width + 1 || rect.height > other.height + 1) &&
    rect.left <= other.left + 1 && rect.right >= other.right - 1 &&
    rect.top <= other.top + 1 && rect.bottom >= other.bottom - 1));
   setRectangles(lines.map(rect => ({
    left: rect.left - parent.left + scroller.scrollLeft,
    top: rect.top - parent.top + scroller.scrollTop,
    width: rect.width, height: rect.height,
   })));
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
  observer?.observe(editor); observer?.observe(scroller);
  scroller.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  schedule();
  return () => {
   cancelAnimationFrame(frame); observer?.disconnect();
   scroller.removeEventListener("scroll", schedule);
   window.removeEventListener("resize", schedule);
   window.visualViewport?.removeEventListener("resize", schedule);
   if (highlight && registry) { highlight.delete(target.range); if (highlight.size === 0) registry.delete(highlightName); }
  };
 }, [target, editorRef, scrollRef]);
 return <div data-compose-refine-glow data-scope={target.scope} aria-hidden="true" className="pointer-events-none absolute inset-0">
  {rectangles.map((rectangle, index) => <span key={index} className="compose-refine-glow absolute rounded" style={rectangle}/>)}
 </div>;
}
