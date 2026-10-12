"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import type { MboxImportIssue } from "@/lib/import/mbox-issues";
type IssuePage = { issues: MboxImportIssue[]; next: number | null; error?: string };

export function MboxImportIssues({ jobId, pending, total, onReviewed }: { jobId: string; pending: number; total: number; onReviewed(): void }) {
 const { t } = useLanguage();
 const [expanded, setExpanded] = useState(false), [after, setAfter] = useState(-1), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
 const endpoint = `/api/import/mbox/jobs/${encodeURIComponent(jobId)}/issues`;
 const query = useQuery<IssuePage>({
  queryKey: ["mbox-import-issues", jobId, after], enabled: expanded, refetchInterval: 15000,
  queryFn: async () => { const response = await authFetch(`${endpoint}?after=${after}`); const data = await response.json() as IssuePage; if (!response.ok) throw new Error(data.error ?? t("import.failed")); return data; },
 });
 async function act(issue: MboxImportIssue, download: boolean) {
  setBusy(true); setError(null);
  try {
   const response = await authFetch(download ? `${endpoint}?download=${encodeURIComponent(issue.id)}` : endpoint, download ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ issueId: issue.id, action: "dismiss" }),
   });
   if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error ?? t("import.failed")); }
   if (download) {
    const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
    link.href = url; link.download = `message-${issue.byte_offset}.mbox`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
   } else { await query.refetch(); onReviewed(); }
  } catch (error) { setError(error instanceof Error ? error.message : t("import.failed")); }
  finally { setBusy(false); }
 }
 return <div className="space-y-2 border-t pt-3 min-w-0" data-mbox-issues>
  <Button type="button" variant="outline" className="min-h-11 h-auto max-w-full whitespace-normal text-wrap" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t("mbox.issues.title", { pending, total })}</Button>
  {expanded && <>
   <p className="text-xs text-neutral-500">{t("mbox.issues.description")}</p>
   {(error || query.error) && <p role="alert" className="break-words text-red-600">{error ?? query.error?.message}</p>}
   {query.data?.issues.map(issue => <div key={issue.id} className="rounded-lg border p-3 space-y-2 min-w-0">
    <p className="font-medium break-words">{t(`mbox.issues.reason.${issue.reason}`)} · {(issue.message_size / 1024 / 1024).toFixed(1)} MiB</p>
    <p className="break-words text-xs">{issue.error}</p>
    <p className="text-xs text-neutral-500">{t("mbox.issues.offset", { offset: issue.byte_offset })}</p>
    <div className="flex flex-wrap gap-2">
     <Button type="button" variant="outline" className="min-h-11 h-auto whitespace-normal text-wrap" disabled={busy} onClick={() => void act(issue, true)}>{t("mbox.issues.download")}</Button>
     {issue.status === "pending" ? <Button type="button" variant="outline" className="min-h-11 h-auto whitespace-normal text-wrap" disabled={busy} onClick={() => void act(issue, false)}>{t("mbox.issues.dismiss")}</Button> : <span>{t("mbox.issues.reviewed")}</span>}
    </div>
   </div>)}
   <div className="flex flex-wrap gap-2">
    {after !== -1 && <Button type="button" variant="outline" onClick={() => setAfter(-1)}>{t("mbox.issues.first")}</Button>}
    {query.data?.next != null && <Button type="button" variant="outline" onClick={() => setAfter(query.data!.next!)}>{t("mbox.issues.next")}</Button>}
   </div>
  </>}
 </div>;
}
