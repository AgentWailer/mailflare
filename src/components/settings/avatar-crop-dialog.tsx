"use client";
/* eslint-disable @next/next/no-img-element -- The crop preview displays a temporary local blob. */

import { useEffect, useRef, useState } from "react";
import { getAvatarCrop, type AvatarCrop } from "@/lib/avatar-upload-client";
import { useLanguage } from "@/components/language-provider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function AvatarCropDialog({ file, busy, error, onClose, onSave }: { file: File; busy: boolean; error: string | null; onClose(): void; onSave(crop: AvatarCrop): void }) {
 const { t } = useLanguage();
 const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null);
 const [failed, setFailed] = useState(false), [zoom, setZoom] = useState(1), [center, setCenter] = useState({ x: 0.5, y: 0.5 });
 const preview = useRef<HTMLDivElement>(null), drag = useRef<{ id: number; x: number; y: number } | null>(null);
 useEffect(() => {
  const url = URL.createObjectURL(file), loader = new Image();let active = true;
  loader.onload = () => { if (active) setImage({ url, width: loader.naturalWidth, height: loader.naturalHeight }); };
  loader.onerror = () => { if (active) setFailed(true); };loader.src = url;
  return () => { active = false; URL.revokeObjectURL(url); };
 }, [file]);
 const crop = image ? getAvatarCrop(image.width, image.height, zoom, center.x, center.y) : null;
 const edge = 240, scale = crop ? edge / crop.size : 1;
 function move(dx: number, dy: number, previewEdge: number) {
  if (!image || !crop || busy) return;
  const ratio = previewEdge / crop.size;
  setCenter({ x: Math.max(crop.size / 2 / image.width, Math.min(1 - crop.size / 2 / image.width, (crop.x + crop.size / 2 - dx / ratio) / image.width)), y: Math.max(crop.size / 2 / image.height, Math.min(1 - crop.size / 2 / image.height, (crop.y + crop.size / 2 - dy / ratio) / image.height)) });
 }
 return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="w-[min(400px,calc(100vw-32px))]">
  <DialogHeader><DialogTitle>{t("avatar.adjustTitle")}</DialogTitle><DialogDescription>{t("avatar.adjustHint")}</DialogDescription></DialogHeader>
  <div ref={preview} data-avatar-crop tabIndex={0} role="group" aria-label={t("avatar.adjustTitle")}
   className="relative mx-auto h-60 w-60 max-w-full touch-none overflow-hidden rounded-full bg-neutral-100 outline-none focus-visible:ring-2 focus-visible:ring-blue-500" style={{ cursor: busy ? "wait" : "grab" }}
   onPointerDown={event => { if (busy || !event.isPrimary || event.button !== 0) return;event.currentTarget.setPointerCapture(event.pointerId);drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; }}
   onPointerMove={event => { const held = drag.current;if (!held || held.id !== event.pointerId) return;move(event.clientX - held.x, event.clientY - held.y, event.currentTarget.clientWidth);drag.current = { id: held.id, x: event.clientX, y: event.clientY }; }}
   onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
   onKeyDown={event => { const directions: Record<string, [number, number]> = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] };if (directions[event.key]) { event.preventDefault();move(...directions[event.key], preview.current?.clientWidth ?? edge); } }}>
   {image && crop && <img src={image.url} alt="" draggable={false} className="pointer-events-none absolute left-0 top-0 max-w-none select-none" style={{ width: image.width * scale, height: image.height * scale, transform: `translate(${-crop.x * scale}px, ${-crop.y * scale}px)` }} />}
  </div>
  <label className="mt-4 flex items-center gap-3 text-sm"><span>{t("avatar.zoom")}</span><input aria-label={t("avatar.zoom")} className="h-11 min-w-0 flex-1 accent-blue-600" type="range" min="1" max="3" step="0.05" value={zoom} disabled={busy || !image} onChange={event => setZoom(Number(event.target.value))} /></label>
  {(error || failed) && <p role="alert" className="text-sm text-red-600">{error ?? t("avatar.uploadFailed")}</p>}
  <div className="mt-4 flex justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button type="button" className="min-h-11" disabled={busy || !crop} onClick={() => { if (crop) onSave(crop); }}>{t(busy ? "common.saving" : "avatar.saveCrop")}</Button></div>
 </DialogContent></Dialog>;
}
