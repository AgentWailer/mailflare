"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import type { CustomFolder } from "@/components/dashboard-nav-types";
import { notifyLabelsChanged } from "@/components/messages/use-mailbox-folders";
import { canNestLabel, getLabelPath } from "@/lib/folders/hierarchy";
import { authFetch } from "@/lib/auth/client";

export function LabelParentSelect({ mailboxId, folder, folders }: { mailboxId: string; folder: CustomFolder; folders: CustomFolder[] }) {
 const { t } = useLanguage();
 const [saving, setSaving] = useState(false), [failed, setFailed] = useState(false);
 async function move(parentId: string) {
  setSaving(true); setFailed(false);
  try {
   const response = await authFetch(`/api/folders/${encodeURIComponent(folder.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId, parentId: parentId || null }) });
   if (!response.ok) throw new Error("Unable to move label");
   notifyLabelsChanged();
  } catch { setFailed(true); }
  finally { setSaving(false); }
 }
 return <div className="space-y-1">
  <label className="block text-xs text-neutral-500" htmlFor={`label-parent-${folder.id}`}>{t("labels.parent")}</label>
  <select id={`label-parent-${folder.id}`} aria-label={`${t("labels.parent")}: ${getLabelPath(folder, folders)}`} className="h-11 w-full min-w-0 rounded-lg border border-neutral-300 bg-white px-2 text-base text-neutral-900" value={folder.parentId ?? ""} disabled={saving} onChange={event => void move(event.target.value)}>
   <option value="">{t("labels.topLevel")}</option>
   {folders.filter(parent => canNestLabel(folder.id, parent.id, folders)).map(parent => <option key={parent.id} value={parent.id}>{getLabelPath(parent, folders)}</option>)}
  </select>
  {failed && <p role="alert" className="text-xs text-red-700">{t("labels.parentFailed")}</p>}
 </div>;
}
