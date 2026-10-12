"use client";

import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "./language-provider";
import { getLayoutSnapshot, moveItem, parseLayoutSnapshot, resolveLayout, subscribeLayoutChanges, writeStorage } from "./reorderable-list-utils";
import type { ReorderableDrag, ReorderableDropTarget, ReorderableLayout, ReorderableListProps } from "./reorderable-list-types";

const HOLD_MS = 350;
const CANCEL_DISTANCE = 6;

// A touch-safe grip supports holding on phones and immediate mouse dragging.
// Labels move only on release, and retain their existing sibling group.
export function ReorderableList({ lists, storageKey, storedLayout, onLayoutChange, fallbackStorageKey, enabled = true, dragHandles = false, itemLabel, initialItemAfter, renderItem, renderAfterItem }: ReorderableListProps) {
 const { t } = useLanguage();
 const snapshot = useSyncExternalStore(subscribeLayoutChanges, () => getLayoutSnapshot(storageKey, fallbackStorageKey), () => "{}");
 const stored = storedLayout ?? parseLayoutSnapshot(snapshot);
 const [drag, setDrag] = useState<ReorderableDrag | null>(null);
 const [target, setTarget] = useState<ReorderableDropTarget | null>(null);
 const [announcement, setAnnouncement] = useState("");
 const containerRef = useRef<HTMLDivElement | null>(null);
 const ghostRef = useRef<HTMLDivElement | null>(null), indicatorRef = useRef<HTMLDivElement | null>(null);
 const initialPointerY = useRef(0);
 const hold = useRef<{ timer: number; x: number; y: number; pointerId: number; mouseGrip: boolean; activate: () => void } | null>(null);
 const suppressClick = useRef<{ id: string; until: number } | null>(null);
 const latest = useRef({ layout: {} as ReorderableLayout, target: null as ReorderableDropTarget | null, onLayoutChange });

 const layout = resolveLayout(Object.fromEntries(lists.map(list => [list.id, list.items.map(item => item.id)])), stored, initialItemAfter);
 const nodes = new Map(lists.flatMap(list => list.items.map(item => {
  const ids = layout[list.id] ?? [], index = ids.indexOf(item.id), name = itemLabel?.(item) ?? item.id;
  function move(direction: -1 | 1) {
   if (index + direction < 0 || index + direction >= ids.length) return;
   const next = moveItem(layout, item.id, list.id, direction === -1 ? ids[index - 1] : ids[index + 2] ?? null);
   writeStorage(storageKey, next); onLayoutChange?.(next); setAnnouncement(t("labels.reordered", { name }));
  }
  const dragHandle = dragHandles && enabled ? <button type="button" data-reorder-handle data-label-name={name}
   className="reorder-handle flex h-9 w-6 shrink-0 cursor-grab items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-200/60 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 active:cursor-grabbing max-md:h-11 max-md:w-9"
   aria-label={t("labels.drag", { name })} title={t("labels.dragHint")}
   onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); move(event.key === "ArrowUp" ? -1 : 1); } }}><GripVertical className="h-4 w-4" /></button> : undefined;
  return [item.id, renderItem ? renderItem(item, { dragHandle, canMoveUp: index > 0, canMoveDown: index < ids.length - 1, moveUp: () => move(-1), moveDown: () => move(1) }) : item.node] as const;
 })));
 useEffect(() => { latest.current.layout = layout; latest.current.target = target; latest.current.onLayoutChange = onLayoutChange; });

 const dragId = drag?.id ?? null, pointerId = drag?.pointerId;
 useEffect(() => {
  if (!dragId || pointerId === undefined) return;
  const container = containerRef.current;
  if (!container) return;
  let active = true, frame = 0, pointerY = initialPointerY.current, lastY = Number.NaN, lastScroll = -1;
  let scroller: HTMLElement | null = container.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;

  function locate(y: number): ReorderableDropTarget | null {
   const rows = Array.from(container!.querySelectorAll<HTMLElement>("[data-reorder-id], [data-reorder-boundary]")).filter(row => row.dataset.reorderScope === storageKey);
   if (!rows.length) return null;
   const current = latest.current.layout;
   const index = Math.max(0, rows.findIndex((row, i) => y < (rows[i + 1]?.getBoundingClientRect().top ?? Infinity)));
   const hit = rows[index], rect = hit.getBoundingClientRect();
   // A parent's section includes its visible descendants, so drops never split a subtree.
   const bottom = rows[index + 1]?.getBoundingClientRect().top ?? Math.max(rect.bottom, container!.getBoundingClientRect().bottom);
   const upper = y < rect.top + (bottom - rect.top) / 2;
   const boundaryList = hit.dataset.reorderBoundary;
   if (boundaryList !== undefined) {
    const listIds = Object.keys(current), index = listIds.indexOf(boundaryList);
    return upper ? { listId: listIds[Math.max(0, index - 1)], beforeId: null, lineY: rect.top }
     : { listId: boundaryList, beforeId: current[boundaryList]?.[0] ?? null, lineY: rect.bottom };
   }
   const id = hit.dataset.reorderId!, listId = hit.dataset.reorderList!, ids = current[listId];
   return upper ? { listId, beforeId: id, lineY: rect.top }
    : { listId, beforeId: ids[ids.indexOf(id) + 1] ?? null, lineY: bottom };
  }
  function updateTarget(y: number) {
   const next = locate(y); latest.current.target = next;
   if (next && indicatorRef.current) indicatorRef.current.style.top = `${next.lineY - 1}px`;
   setTarget(current => current && next && current.listId === next.listId && current.beforeId === next.beforeId ? current : next);
  }
  function tick() {
   if (!active) return;
   if (scroller) {
    const rect = scroller.getBoundingClientRect(), top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
    const speed = pointerY < top + 40 ? -Math.min(12, (top + 40 - pointerY) / 4) : pointerY > bottom - 40 ? Math.min(12, (pointerY - bottom + 40) / 4) : 0;
    if (speed) scroller.scrollTop += speed;
   }
   if (ghostRef.current) ghostRef.current.style.transform = `translate3d(0, ${pointerY - initialPointerY.current}px, 0)`;
   const scroll = scroller?.scrollTop ?? 0;
   if (pointerY !== lastY || scroll !== lastScroll) { updateTarget(pointerY); lastY = pointerY; lastScroll = scroll; }
   frame = requestAnimationFrame(tick);
  }
  updateTarget(pointerY); frame = requestAnimationFrame(tick);
  const onMove = (event: PointerEvent) => { if (event.pointerId === pointerId) pointerY = event.clientY; };
  const end = (commit: boolean, event?: PointerEvent) => {
   if (!active || event && event.pointerId !== pointerId) return;
   active = false; cancelAnimationFrame(frame);
   suppressClick.current = { id: dragId, until: Date.now() + 700 };
   const rect = container.getBoundingClientRect();
   const inside = !event || event.clientX >= rect.left - 24 && event.clientX <= rect.right + 24;
   const drop = event ? locate(event.clientY) : latest.current.target;
   if (commit && inside && drop) {
    const next = moveItem(latest.current.layout, dragId, drop.listId, drop.beforeId);
    writeStorage(storageKey, next);
    latest.current.onLayoutChange?.(next);
    setAnnouncement(t("labels.reordered", { name: container.querySelector(`[data-reorder-id="${CSS.escape(dragId)}"]`)?.getAttribute("data-reorder-label") ?? "" }));
   }
   if (!commit || !inside) setAnnouncement(t("labels.dragCancelled"));
   setDrag(null); setTarget(null);
  };
  const onUp = (event: PointerEvent) => end(true, event);
  const onCancel = (event: PointerEvent) => end(false, event);
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); end(false); } };
  const onBlur = () => end(false);
  const blockScroll = (event: TouchEvent) => { if (event.cancelable) event.preventDefault(); };
  window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp); window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey); window.addEventListener("blur", onBlur);
  document.addEventListener("touchmove", blockScroll, { passive: false });
  return () => {
   active = false; cancelAnimationFrame(frame);
   window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); window.removeEventListener("pointercancel", onCancel);
   window.removeEventListener("keydown", onKey); window.removeEventListener("blur", onBlur);
   document.removeEventListener("touchmove", blockScroll);
  };
 }, [dragId, pointerId, storageKey, t]);

 useEffect(() => {
  const cancel = () => { if (hold.current) window.clearTimeout(hold.current.timer); hold.current = null; };
  window.addEventListener("pointerup", cancel); window.addEventListener("pointercancel", cancel); window.addEventListener("blur", cancel);
  return () => { cancel(); window.removeEventListener("pointerup", cancel); window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel); };
 }, [storageKey]);
 function cancelHold() { if (hold.current) window.clearTimeout(hold.current.timer); hold.current = null; }
 function startHold(event: ReactPointerEvent<HTMLDivElement>, id: string) {
  // Suppress only the click produced by the drag itself, never a fresh press
  // on the actions button or a portaled menu item.
  if (event.isPrimary && event.button === 0) suppressClick.current = null;
  const grip = !!(event.target as Element).closest("[data-reorder-handle]");
  if (!enabled || !event.isPrimary || event.button !== 0 || !grip && (event.target as Element).closest("button, [role=menuitem], input")) return;
  cancelHold(); suppressClick.current = null;
  const element = event.currentTarget, { clientX, clientY, pointerId, pointerType } = event;
  initialPointerY.current = clientY;
  if (grip) element.setPointerCapture(pointerId);
  const activate = () => {
   cancelHold();
   const rect = element.getBoundingClientRect(), listRect = containerRef.current?.getBoundingClientRect();
   if (!element.isConnected) return;
   element.setPointerCapture(pointerId);
   setDrag({ id, pointerId, left: rect.left, width: rect.width, height: rect.height, offsetY: clientY - rect.top, pointerY: clientY, listLeft: listRect?.left ?? rect.left, listWidth: listRect?.width ?? rect.width });
   setAnnouncement(t("labels.dragging"));
  };
  const timer = window.setTimeout(activate, HOLD_MS);
  hold.current = { timer, x: clientX, y: clientY, pointerId, mouseGrip: grip && pointerType === "mouse", activate };
 }
 function moveHold(event: ReactPointerEvent) {
  const current = hold.current;
  if (current && current.pointerId === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > CANCEL_DISTANCE) {
   if (current.mouseGrip) current.activate(); else cancelHold();
  }
 }
 return <div ref={containerRef} className={cn("flex shrink-0 flex-col gap-px", drag && "select-none")} data-reorder-container={storageKey}>
  {lists.map(list => {
   const ordered = layout[list.id] ?? [], shown = list.hidden ? [] : list.visibleIds ? list.visibleIds(ordered) : ordered;
   return <div key={list.id} className="contents">
    {list.before && <div data-reorder-scope={storageKey} data-reorder-boundary={list.id}>{list.before}</div>}
    {shown.map(id => <Fragment key={id}><div data-reorder-scope={storageKey} data-reorder-id={id} data-reorder-label={itemLabel?.(list.items.find(item => item.id === id)!) ?? id} data-reorder-list={list.id}
     onPointerDown={event => startHold(event, id)} onPointerMove={moveHold} onPointerUp={cancelHold} onPointerCancel={cancelHold}
     onDragStart={event => event.preventDefault()} onContextMenu={event => { if (hold.current || drag) event.preventDefault(); }}
     onClickCapture={event => { if (suppressClick.current?.id === id && Date.now() < suppressClick.current.until) { event.preventDefault(); event.stopPropagation(); } }}
     className={cn("shrink-0", (dragHandles || itemLabel) && "reorder-label-row", dragId === id && "opacity-40")}>{nodes.get(id)}</div>{renderAfterItem?.(list.items.find(item => item.id === id)!)}</Fragment>)}
   </div>;
  })}
  {(dragHandles || itemLabel) && <span role="status" aria-live="polite" className="sr-only">{announcement}</span>}
  {drag && target && createPortal(<div ref={indicatorRef} aria-hidden="true" data-reorder-indicator className="pointer-events-none fixed z-[300] h-0.5 rounded-full bg-blue-600" style={{ left: drag.listLeft, width: drag.listWidth, top: target.lineY - 1 }} />, document.body)}
  {drag && createPortal(<div ref={ghostRef} aria-hidden="true" data-reorder-ghost className="pointer-events-none fixed z-[301] cursor-grabbing overflow-hidden rounded-r-full bg-white opacity-90 shadow-lg ring-1 ring-neutral-200 will-change-transform" style={{ left: drag.left, width: drag.width, top: drag.pointerY - drag.offsetY }}>{nodes.get(drag.id)}</div>, document.body)}
 </div>;
}
