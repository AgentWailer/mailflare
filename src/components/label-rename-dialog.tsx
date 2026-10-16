"use client";
import { Check } from "lucide-react";
import { FOLDER_COLOR_OPTIONS } from "@/lib/folders/colors";
import { folderColorKeys } from "@/lib/folders/color-keys";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "./language-provider";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import { notifyLabelsChanged } from "./messages/use-mailbox-folders";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import type { CustomFolder } from "./dashboard-nav-types";

export function LabelRenameDialog({ mailboxId, folder, onClose, onRenamed, colorOnly = false }: { mailboxId: string; folder: CustomFolder; onClose(): void; onRenamed(folder: CustomFolder): void; colorOnly?: boolean }) {
 const { t } = useLanguage(), inputRef = useRef<HTMLInputElement>(null), active = useRef(true);
 const viewportCleanup = useRef<(() => void) | null>(null);
 const [color, setColor] = useState(folder.color);
 const [name, setName] = useState(folder.name), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
 useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
 const positionDialog = useCallback(() => {
  viewportCleanup.current?.();
  const viewport = window.visualViewport, element = document.getElementById("rename-label-dialog");
  if (!viewport || !element) return;
  let frame = 0;
  const update = () => {
   cancelAnimationFrame(frame);
   frame = requestAnimationFrame(() => {
    element.style.top = `${viewport.offsetTop + viewport.height / 2}px`;
    element.style.maxHeight = `${Math.max(100, viewport.height - 32)}px`;
   });
  };
  update(); viewport.addEventListener("resize", update); viewport.addEventListener("scroll", update);
  viewportCleanup.current = () => { cancelAnimationFrame(frame); viewport.removeEventListener("resize", update); viewport.removeEventListener("scroll", update); };
 }, []);
 useEffect(() => { positionDialog(); return () => viewportCleanup.current?.(); }, [positionDialog]);
 async function save(event: React.FormEvent) {
  event.preventDefault(); if ((!colorOnly && !name.trim()) || saving) return;
  const session = getClientSessionToken(); setSaving(true); setError(null);
  try {
   const response = await authFetch(`/api/folders/${encodeURIComponent(folder.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId, ...(colorOnly ? { color } : { name: name.trim() }) }) });
   const body = await response.json() as { error?: string; folder?: CustomFolder };
   if (!active.current || session !== getClientSessionToken()) return;
   if (!response.ok) throw new Error(t(colorOnly ? "labels.colorFailed" : body.error === "Folder already exists" ? "labels.duplicate" : "labels.renameFailed"));
   onRenamed(body.folder ?? { ...folder, ...(colorOnly ? { color } : { name: name.trim() }) }); notifyLabelsChanged(); onClose();
  } catch (error) { if (active.current) setError(error instanceof Error ? error.message : t(colorOnly ? "labels.colorFailed" : "labels.renameFailed")); }
  finally { if (active.current) setSaving(false); }
 }
 return <Dialog open onOpenChange={open => { if (!open && !saving) { active.current = false; onClose(); } }}>
  <DialogContent id="rename-label-dialog" onOpenAutoFocus={event => { event.preventDefault(); positionDialog(); if (colorOnly) (document.querySelector<HTMLInputElement>('#rename-label-dialog input[type="radio"]:checked') ?? document.querySelector<HTMLInputElement>('#rename-label-dialog input[type="radio"]'))?.focus(); else { inputRef.current?.focus(); inputRef.current?.select(); } }}>
   <DialogHeader><DialogTitle>{t(colorOnly ? "labels.colorTitle" : "labels.renameTitle")}</DialogTitle><DialogDescription>{colorOnly ? folder.name : t("labels.renameDescription")}</DialogDescription></DialogHeader>
   <form onSubmit={save} className="space-y-4">
    {!colorOnly && <div className="space-y-2"><Label htmlFor="rename-label-name">{t("navigation.folderName")}</Label><Input ref={inputRef} id="rename-label-name" className="h-11 text-base md:text-sm" maxLength={80} value={name} disabled={saving} onChange={event => setName(event.target.value)} /></div>}
    {colorOnly && <fieldset disabled={saving}><legend className="mb-3 text-sm font-medium">{t("navigation.folderColor")}</legend><div className="grid grid-cols-4 gap-3">{FOLDER_COLOR_OPTIONS.map(option => <label key={option.value} className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg hover:bg-neutral-100"><input type="radio" name="label-color" value={option.value} checked={color === option.value} onChange={() => setColor(option.value)} aria-label={t(folderColorKeys[option.value])} className="peer sr-only"/><span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full border border-black/10 text-white peer-checked:ring-2 peer-checked:ring-neutral-600 peer-checked:ring-offset-2 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-600 peer-focus-visible:ring-offset-2" style={{backgroundColor:option.value}}>{color === option.value && <Check className="h-5 w-5"/>}</span></label>)}</div></fieldset>}
    {error && <p role="alert" className="break-words text-sm text-red-600">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={() => { active.current = false; onClose(); }}>{t("common.cancel")}</Button><Button type="submit" className="min-h-11" disabled={saving || (colorOnly ? color === folder.color : !name.trim())}>{t(saving ? "common.saving" : "labels.renameSave")}</Button></div>
   </form>
  </DialogContent>
 </Dialog>;
}
