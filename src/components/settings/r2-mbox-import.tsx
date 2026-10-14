"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notifyLabelsChanged } from "@/components/messages/use-mailbox-folders";
import type { publicMboxJob } from "@/lib/import/mbox-jobs";
import type { publicMboxSortingJob } from "@/lib/import/mbox-sorting";
import { MboxImportIssues } from "./mbox-import-issues";

type Job = ReturnType<typeof publicMboxJob> & { issues?: { total: number; pending: number }; sorting?: ReturnType<typeof publicMboxSortingJob> | null };
type Status = { jobs: Job[]; backgroundQueueConfigured: boolean; sortingAvailable?: boolean; error?: string };
export function R2MboxImport({ embedded = false }: { embedded?: boolean } = {}) {
 const user = useCurrentUser(), { selectedMailbox } = useSelectedMailbox(), { t } = useLanguage();
 const [objectKey, setObjectKey] = useState("mbox-imports/workspace-002.mbox"), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
 const previous = useRef("");
 const canManage = !!selectedMailbox && (!selectedMailbox.permission || selectedMailbox.permission === "full_access");
 const query = useQuery<Status>({
  queryKey: ["r2-mbox-import", user?.id, selectedMailbox?.id], enabled: user?.role === "admin" && !!selectedMailbox?.id,
  queryFn: async () => { const response = await authFetch("/api/import/mbox/jobs?mailboxId=" + encodeURIComponent(selectedMailbox!.id)); const body = await response.json() as Status; if (!response.ok) throw new Error(body.error ?? t("import.failed")); return body; },
  refetchInterval: 5000,
 });
 useEffect(() => {
  const signature = (query.data?.jobs ?? []).map(job => `${job.id}:${job.processed}:${job.sorting?.processed ?? 0}`).join(",");
  if (previous.current && signature !== previous.current) notifyLabelsChanged();
  previous.current = signature;
 }, [query.data]);
 if (user?.role !== "admin") return null;
 async function act(id?: string, action?: "pause" | "resume" | "skip") {
  setBusy(true); setError(null);
  try {
   const response = await authFetch(id ? `/api/import/mbox/jobs/${encodeURIComponent(id)}` : "/api/import/mbox/jobs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(id ? { action } : { mailboxId: selectedMailbox?.id, objectKey: objectKey.trim() }),
   });
   const body = await response.json() as { error?: string }; if (!response.ok) throw new Error(body.error ?? t("import.failed"));
   await query.refetch(); notifyLabelsChanged();
  } catch (error) { setError(error instanceof Error ? error.message : t("import.failed")); }
  finally { setBusy(false); }
 }
 async function sort(id: string, action: "start" | "pause" | "resume") {
  setBusy(true); setError(null);
  try {
   const response = await authFetch(`/api/import/mbox/jobs/${encodeURIComponent(id)}/sorting`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
   });
   const result = await response.json() as { error?: string };
   if (!response.ok) throw new Error(result.error ?? t("import.failed"));
   await query.refetch(); notifyLabelsChanged();
  } catch (error) { setError(error instanceof Error ? error.message : t("import.failed")); }
  finally { setBusy(false); }
 }
 return <Card className={embedded ? "border-0" : undefined}>
  {!embedded && <CardHeader><CardTitle>{t("mbox.title")}</CardTitle><CardDescription>{t("mbox.description")}</CardDescription></CardHeader>}
  <CardContent className="space-y-4 min-w-0">
   <p className="text-sm text-neutral-500">{t("mbox.uploadHint")}</p>
   <form onSubmit={event => { event.preventDefault(); void act(); }} className="space-y-2">
    <Label htmlFor="r2-mbox-key">{t("mbox.objectKey")}</Label>
    <Input id="r2-mbox-key" value={objectKey} onChange={event => setObjectKey(event.target.value)} disabled={busy} className="min-h-11" />
    <Button type="submit" className="min-h-11" disabled={busy || !canManage || !objectKey.trim() || !query.data?.backgroundQueueConfigured}>{t("mbox.start")}</Button>
   </form>
   {query.data && !query.data.backgroundQueueConfigured && <p role="alert" className="text-sm text-red-600">{t("mbox.missingQueue")}</p>}
   {(error || query.error) && <p role="alert" className="break-words text-sm text-red-600">{error ?? query.error?.message}</p>}
   {query.data?.jobs.map(job => <div key={job.id} className="space-y-2 rounded-xl border p-3 text-sm min-w-0">
    <p className="break-all font-medium">{job.objectKey}</p>
    <p aria-live="polite">{t(`mbox.status.${job.status}`)} · {job.progress}% · {t("import.summary", { imported: job.imported, skipped: job.skipped })}</p>
    <div role="progressbar" aria-valuenow={job.progress} aria-valuemin={0} aria-valuemax={100} aria-label={t("mbox.progress")} className="h-1.5 overflow-hidden rounded-full bg-neutral-200"><div className="h-full bg-blue-600" style={{ width: `${job.progress}%` }} /></div>
    {job.error && <p role="alert" className="break-words text-red-600">{job.error}</p>}
    {!!job.retryAt && job.error && <p className="text-xs text-neutral-500">{t("mbox.autoRetry")}</p>}
    <div className="flex flex-wrap gap-2">
     {(job.status === "pending" || job.status === "running") && <Button type="button" variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal text-wrap" disabled={busy || !canManage} onClick={() => void act(job.id, "pause")}>{t("mbox.pause")}</Button>}
     {(job.status === "paused" || job.status === "failed") && <Button type="button" className="min-h-11 h-auto max-w-full whitespace-normal text-wrap" disabled={busy || !canManage} onClick={() => void act(job.id, "resume")}>{t("mbox.resume")}</Button>}
     {job.canSkip && <Button type="button" variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal text-wrap" disabled={busy || !canManage} onClick={() => { if (window.confirm(t("mbox.skipConfirm"))) void act(job.id, "skip"); }}>{t("mbox.skip")}</Button>}
    </div>
    {!!job.issues?.total && <MboxImportIssues jobId={job.id} {...job.issues} onReviewed={() => { void query.refetch(); }} />}
    <div className="space-y-2 border-t pt-3" data-mbox-sorting>
     <p className="font-medium">{t("mbox.sorting.title")}</p>
     <p className="text-xs text-neutral-500">{t("mbox.sorting.description")}</p>
     {!job.sorting && <Button type="button" variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal text-wrap" disabled={busy || !canManage || !query.data?.sortingAvailable} onClick={() => void sort(job.id, "start")}>{t("mbox.sorting.start")}</Button>}
     {job.sorting && <>
      <p aria-live="polite" className="break-words">{t(`mbox.sorting.status.${job.sorting.status}`)} · {t("mbox.sorting.summary", { processed: job.sorting.processed, promotions: job.sorting.promotions, social: job.sorting.social, invoices: job.sorting.invoices ?? 0, orders: job.sorting.orders ?? 0, primary: job.sorting.primary })}</p>
      {job.sorting.waitReason && <p className="text-xs text-neutral-500">{t(`mbox.sorting.wait.${job.sorting.waitReason}`)}</p>}
      {job.sorting.error && <p role="alert" className="break-words text-red-600">{job.sorting.error}</p>}
      <div className="flex flex-wrap gap-2">
       {["pending", "running", "waiting"].includes(job.sorting.status) && <Button type="button" variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal text-wrap" disabled={busy || !canManage} onClick={() => void sort(job.id, "pause")}>{t("mbox.sorting.pause")}</Button>}
       {["paused", "failed"].includes(job.sorting.status) && <Button type="button" className="min-h-11 h-auto max-w-full whitespace-normal text-wrap" disabled={busy || !canManage} onClick={() => void sort(job.id, "resume")}>{t("mbox.sorting.resume")}</Button>}
      </div>
     </>}
    </div>
   </div>)}
   <p className="text-xs text-neutral-500">{t("mbox.retention")}</p>
  </CardContent>
 </Card>;
}
