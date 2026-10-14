"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth/client";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { MAIL_CATEGORIES, type MailCategory } from "@/lib/mail-sorting/categories";
import { cleanSnippetText } from "@/lib/email/snippet";
import { notifyLabelsChanged } from "@/components/messages/use-mailbox-folders";

type Job = { id: string; status: string; phase: string; total: number; processed: number; aiProcessed: number; changed: number; reviewCount: number; error: string | null };
type Issue = { id: string; messageId: string; category: MailCategory; suggestedCategory: MailCategory | null; subject: string; sender: string; snippet: string; reason: string };
type State = { job: Job | null; issues: Issue[]; next: number | null };
export function MailContentAudit({ mailboxId }: { mailboxId: string }) {
 const { t } = useLanguage();
 const [data, setData] = useState<State | null>(null), [pending, setPending] = useState(false), [notice, setNotice] = useState("");
 const [cursor, setCursor] = useState(0), [revision, setRevision] = useState(0);
 useEffect(() => {
  let active = true;
  const load = async () => {
   if (document.hidden) return;
   try {
    const response = await authFetch(`/api/settings/mail-sorting/audit?${new URLSearchParams({ mailboxId, after: String(cursor) })}`);
    if (!response.ok) throw new Error();
    const value = await response.json() as State;
    if (active) setData(value);
   } catch { if (active) setNotice(t("smart.failed")); }
  };
  void load(); const timer = window.setInterval(() => void load(), 5000);
  const focus = () => void load(); window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
  return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
 }, [mailboxId, cursor, revision, t]);
 async function action(kind: "start" | "pause" | "resume" | "structure" | "review", extra = {}) {
  setPending(true); setNotice("");
  try {
   const response = await authFetch("/api/settings/mail-sorting/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId, action: kind, ...extra }) });
   if (!response.ok) throw new Error();
   if (kind === "structure") { notifyLabelsChanged(); setNotice(t("audit.structureSaved")); }
   if (kind === "review") window.dispatchEvent(new Event("mailflare:messages-changed"));
   setCursor(0); setRevision(value => value + 1);
  } catch { setNotice(t("smart.failed")); }
  finally { setPending(false); }
 }
 const job = data?.job;
 const active = job && ["pending", "running", "waiting"].includes(job.status);
 const percentage = job?.total ? Math.min(100, Math.round(job.processed / job.total * 100)) : 0;
 return <section className="space-y-3 border-t border-neutral-200 pt-4" aria-label={t("audit.title")}>
  <h4 className="font-semibold">{t("audit.title")}</h4>
  <p className="text-sm text-neutral-500">{t("audit.description")}</p>
  <div className="flex flex-wrap gap-2">
   {active ? <Button variant="outline" disabled={pending} onClick={() => void action("pause")}>{t("audit.pause")}</Button>
    : job && ["paused", "failed"].includes(job.status) && job.error !== "restore_requires_restart"
     ? <Button variant="outline" disabled={pending} onClick={() => void action("resume")}>{t("audit.resume")}</Button>
     : <Button variant="outline" disabled={pending} onClick={() => void action("start")}>{t("audit.start")}</Button>}
   <Button variant="outline" disabled={pending} onClick={() => void action("structure")}>{t("audit.structure")}</Button>
  </div>
  {job && <div role="status" className="space-y-2 rounded-xl bg-neutral-50 p-3 text-sm">
   <p>{t(job.status === "completed" ? "audit.completed" : job.status === "paused" ? "audit.paused" : job.status === "failed" ? "audit.failed" : job.phase === "rules" ? "audit.rules" : "audit.ai")}</p>
   <p>{t("audit.progress", { processed: job.processed.toLocaleString(), total: job.total.toLocaleString(), changed: job.changed.toLocaleString(), ai: job.aiProcessed.toLocaleString() })}</p>
   <div role="progressbar" aria-label={t("audit.rules")} aria-valuenow={percentage} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded bg-neutral-200"><div className="h-full bg-blue-600" style={{ width: `${percentage}%` }} /></div>
   {job.error === "daily_limit" && <p>{t("audit.quota")}</p>}
   {!!job.reviewCount && <p>{t("audit.reviewCount", { count: job.reviewCount })}</p>}
  </div>}
  {!!data?.issues.length && <div className="space-y-3">
   <h4 className="text-sm font-semibold">{t("audit.reviewTitle")}</h4>
   <p className="text-sm text-neutral-500">{t("audit.learning")}</p>
   {data.issues.map(issue => <ReviewCard key={issue.id} issue={issue} mailboxId={mailboxId} disabled={pending} review={(category) => action("review", { issueId: issue.id, category })} />)}
   {!!data.next && <Button variant="outline" onClick={() => setCursor(data.next!)}>{t("audit.next")}</Button>}
   {!!cursor && <Button variant="ghost" onClick={() => setCursor(0)}>{t("audit.first")}</Button>}
  </div>}
  {notice && <p role="status" className="text-sm">{notice}</p>}
 </section>;
}
function ReviewCard({ issue, mailboxId, disabled, review }: { issue: Issue; mailboxId: string; disabled: boolean; review: (category: MailCategory | null) => Promise<void> }) {
 const { t } = useLanguage(); const [category, setCategory] = useState<MailCategory>(issue.suggestedCategory ?? issue.category);
 return <div className="space-y-2 rounded-xl border border-neutral-200 p-3 text-sm">
  <Link href={`/inbox/${encodeURIComponent(issue.messageId)}?mailboxId=${encodeURIComponent(mailboxId)}`} className="block break-words font-medium text-blue-600">{issue.subject || t("list.noSubject")}</Link>
  <p className="break-words text-xs text-neutral-500">{issue.sender}</p>
  <p className="line-clamp-2 break-words text-neutral-600">{cleanSnippetText(issue.snippet ?? "")}</p>
  <p>{t("audit.current", { category: t(`smart.${issue.category}`) })} · {t(issue.reason === "explicit_conflict" ? "audit.conflict" : issue.reason === "evaluation_unavailable" ? "audit.unavailable" : issue.reason === "direct_message_review" ? "audit.directMessage" : "audit.uncertain")}</p>
  <div className="flex flex-wrap items-center gap-2">
   <select aria-label={t("audit.chooseCategory")} disabled={disabled} value={category} onChange={event => setCategory(event.target.value as MailCategory)} className="min-h-11 rounded-lg border border-neutral-200 bg-white px-2 text-base">{MAIL_CATEGORIES.map(value => <option key={value} value={value}>{t(`smart.${value}`)}</option>)}</select>
   <Button disabled={disabled} onClick={() => void review(category)}>{t("audit.confirm")}</Button>
   <Button variant="ghost" disabled={disabled} onClick={() => void review(null)}>{t("audit.keep")}</Button>
  </div>
 </div>;
}
