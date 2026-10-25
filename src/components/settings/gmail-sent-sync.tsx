"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";

export type SentSyncStatus = {connectionId:string;mailboxId:string;enabled:boolean;backfilling:boolean;imported:number;lastSyncedAt:number|null;error:string|null;retryAt:number;issueCount:number;issues:{sourceId:string;error:string}[]};
export function GmailSentSync({connectionId,mailboxId,sync,disabled,onChanged}:{connectionId:string;mailboxId:string;sync?:SentSyncStatus;disabled:boolean;onChanged:()=>Promise<unknown>}) {
 const {t}=useLanguage(),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const wrongMailbox=!!sync && sync.mailboxId!==mailboxId;
 async function control(action:"enable"|"pause"|"retry",sourceId?:string) {
  setBusy(true);setError(false);const session=getClientSessionToken();
  try {
   const response=await authFetch("/api/import/gmail/sent-sync",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({connectionId,mailboxId,action,...(sourceId?{sourceId}:{})})});
   if (!response.ok || session!==getClientSessionToken()) throw new Error();
   await onChanged();
  } catch {setError(true);} finally {setBusy(false);}
 }
 return <div className="space-y-3 rounded-xl border border-neutral-200 p-4">
  <div><h3 className="font-medium text-neutral-900">{t("gmail.sent.title")}</h3><p className="mt-1 text-sm text-neutral-600">{t("gmail.sent.description")}</p></div>
  {wrongMailbox ? <p className="text-sm text-neutral-600">{t("gmail.sent.otherMailbox")}</p> : <>
   {sync && <p role="status" className="text-sm text-neutral-700">{sync.enabled ? t(sync.backfilling?"gmail.sent.backfill":"gmail.sent.active") : t("gmail.sent.paused")} · {t("gmail.sent.count",{count:sync.imported})}</p>}
   <Button variant="outline" disabled={disabled||busy} onClick={()=>void control(sync?.enabled?"pause":"enable")}>{t(sync?.enabled?"gmail.sent.pause":"gmail.sent.enable")}</Button>
   {sync?.lastSyncedAt && <p className="text-xs text-neutral-500">{t("gmail.sent.lastCheck",{date:new Date(sync.lastSyncedAt).toLocaleString()})}</p>}
   {sync?.error && <p role="alert" className="text-sm text-red-600">{t(sync.error==="google_authorization"?"gmail.sent.reconnect":sync.error==="permission_changed"?"gmail.sent.permission":sync.error==="restore_requires_review"?"gmail.sent.restored":"gmail.sent.temporary")}</p>}
   {!!sync?.issueCount && <details className="text-sm text-neutral-700"><summary className="cursor-pointer py-2">{t("gmail.sent.issues",{count:sync.issueCount})}</summary><p className="my-2 text-neutral-600">{t("gmail.sent.issueHelp")}</p><ul className="space-y-2">{sync.issues.map(issue=><li key={issue.sourceId} className="flex min-w-0 flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-all">{issue.sourceId} · {t(issue.error==="message_too_large"?"gmail.sent.tooLarge":"gmail.sent.invalid")}</span><Button variant="outline" disabled={disabled||busy} onClick={()=>void control("retry",issue.sourceId)}>{t("gmail.sent.retry")}</Button></li>)}</ul></details>}
  </>}
  {error && <p role="alert" className="text-sm text-red-600">{t("gmail.sent.failed")}</p>}
 </div>;
}
