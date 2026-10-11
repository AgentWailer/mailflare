"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

const touchQuery = "(max-width: 1023px), (hover: none) and (pointer: coarse)";

/** iOS can scroll an underlying reader even while a fixed editor covers it. */
export function useComposeScrollLock(ref: RefObject<HTMLFormElement | null>, active: boolean, modal: boolean) {
 useEffect(() => {
  const form = ref.current;
  if (!active || !form || !window.matchMedia) return;
  const media = window.matchMedia(touchQuery);
  let release: (() => void) | undefined;
  function synchronize() {
   release?.(); release = undefined;
   if (!media.matches && !modal) return;
   const body = document.body, html = document.documentElement;
   const x = window.scrollX, y = window.scrollY;
   const properties = ["overflow", "overscroll-behavior", "position", "top", "left", "width"];
   const original = properties.map(key => [key, body.style.getPropertyValue(key), body.style.getPropertyPriority(key)]);
   const htmlOverflow = html.style.overflow, htmlOverscroll = html.style.overscrollBehavior;
   body.style.overflow = "hidden"; body.style.overscrollBehavior = "none";
   body.style.position = "fixed"; body.style.top = `${-y}px`; body.style.left = `${-x}px`; body.style.width = "100%";
   html.style.overflow = "hidden"; html.style.overscrollBehavior = "none";
   const outside: { element: HTMLElement; inert: boolean }[] = [];
   let branch: HTMLElement = form!;
   while (branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
     if (sibling === branch || !(sibling instanceof HTMLElement) || sibling.hasAttribute("data-compose-layer")) continue;
     outside.push({ element: sibling, inert: sibling.inert }); sibling.inert = true;
    }
    branch = branch.parentElement;
    if (branch === body) break;
   }
   const canScroll = (target: EventTarget | null, dx: number, dy: number) => {
    if (!(target instanceof Element)) return false;
    const boundary = form!.contains(target) ? form : target.closest("[data-compose-layer]");
    if (!boundary) return false;
    let element: Element | null = target;
    while (element) {
     const style = getComputedStyle(element), horizontal = Math.abs(dx) > Math.abs(dy);
     if (horizontal && /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth) return true;
     if (!horizontal && /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1 && (dy < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight - 1)) return true;
     if (element === boundary) break;
     element = element.parentElement;
    }
    return false;
   };
   let lastX = 0, lastY = 0;
   const start = (event: TouchEvent) => { lastX = event.touches[0]?.clientX ?? 0; lastY = event.touches[0]?.clientY ?? 0; };
   const move = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0], dx = lastX - touch.clientX, dy = lastY - touch.clientY;
    lastX = touch.clientX; lastY = touch.clientY;
    if (!canScroll(event.target, dx, dy)) event.preventDefault();
   };
   const wheel = (event: WheelEvent) => { if (!canScroll(event.target, event.deltaX, event.deltaY)) event.preventDefault(); };
   document.addEventListener("touchstart", start, { passive: true, capture: true });
   document.addEventListener("touchmove", move, { passive: false, capture: true });
   document.addEventListener("wheel", wheel, { passive: false, capture: true });
   release = () => {
    document.removeEventListener("touchstart", start, true); document.removeEventListener("touchmove", move, true); document.removeEventListener("wheel", wheel, true);
    for (const item of outside) item.element.inert = item.inert;
    for (const [key, value, priority] of original) if (value) body.style.setProperty(key, value, priority); else body.style.removeProperty(key);
    html.style.overflow = htmlOverflow; html.style.overscrollBehavior = htmlOverscroll;
    window.scrollTo(x, y);
   };
  }
  synchronize(); media.addEventListener("change", synchronize);
  return () => { media.removeEventListener("change", synchronize); release?.(); };
 }, [ref, active, modal]);
}
