"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "./language-provider";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import { notifyLabelsChanged } from "./messages/use-mailbox-folders";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import type { CustomFolder } from "./dashboard-nav-types";

export function LabelRenameDialog({ mailboxId, folder, onClose, onRenamed }: { mailboxId: string; folder: CustomFolder; onClose(): void; onRenamed(folder: CustomFolder): void }) {
 const { t } = useLanguage(), inputRef = useRef<HTMLInputElement>(null), active = useRef(true);
 const viewportCleanup = useRef<(() => void) | null>(null);
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
  event.preventDefault(); if (!name.trim() || saving) return;
  const session = getClientSessionToken(); setSaving(true); setError(null);
  try {
   const response = await authFetch(`/api/folders/${encodeURIComponent(folder.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId, name: name.trim() }) });
   const body = await response.json() as { error?: string; folder?: CustomFolder };
   if (!active.current || session !== getClientSessionToken()) return;
   if (!response.ok) throw new Error(t(body.error === "Folder already exists" ? "labels.duplicate" : "labels.renameFailed"));
   onRenamed(body.folder ?? { ...folder, name: name.trim() }); notifyLabelsChanged(); onClose();
  } catch (error) { if (active.current) setError(error instanceof Error ? error.message : t("labels.renameFailed")); }
  finally { if (active.current) setSaving(false); }
 }
 return <Dialog open onOpenChange={open => { if (!open && !saving) { active.current = false; onClose(); } }}>
  <DialogContent id="rename-label-dialog" onOpenAutoFocus={event => { event.preventDefault(); positionDialog(); inputRef.current?.focus(); inputRef.current?.select(); }}>
   <DialogHeader><DialogTitle>{t("labels.renameTitle")}</DialogTitle><DialogDescription>{t("labels.renameDescription")}</DialogDescription></DialogHeader>
   <form onSubmit={save} className="space-y-4">
    <div className="space-y-2"><Label htmlFor="rename-label-name">{t("navigation.folderName")}</Label><Input ref={inputRef} id="rename-label-name" className="h-11 text-base md:text-sm" maxLength={80} value={name} disabled={saving} onChange={event => setName(event.target.value)} /></div>
    {error && <p role="alert" className="break-words text-sm text-red-600">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={() => { active.current = false; onClose(); }}>{t("common.cancel")}</Button><Button type="submit" className="min-h-11" disabled={saving || !name.trim()}>{t(saving ? "common.saving" : "labels.renameSave")}</Button></div>
   </form>
  </DialogContent>
 </Dialog>;
}
