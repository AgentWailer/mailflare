"use client";
import { useEffect,useState } from "react";
import Link from "next/link";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notifyLabelsChanged } from "@/components/messages/use-mailbox-folders";
type Label={id:string;name:string;parentId:string|null};
type Job={id:string;baseUrl:string;messageId:string;status:string;error:string|null;filename:string;subject:string;taskId:string|null;documentId:number|null};
type State={available:boolean;connection:{baseUrl:string;enabled:boolean;labelId:string|null;processedLabelId:string|null;hasToken:boolean;hasAccessCredentials?:boolean}|null;labels:Label[];jobs:Job[];counts:{status:string;count:number}[]};
export function PaperlessSettings() {
 const {selectedMailbox}=useSelectedMailbox();
 return <PaperlessForm key={selectedMailbox?.id??"none"} mailboxId={selectedMailbox?.id}/>;
}
function PaperlessForm({mailboxId}:{mailboxId?:string}) {
 const {t,locale}=useLanguage();
 const [data,setData]=useState<State|null>(null),[notice,setNotice]=useState(""),[pending,setPending]=useState(false),[revision,setRevision]=useState(0);
 const [url,setUrl]=useState(""),[token,setToken]=useState(""),[accessId,setAccessId]=useState(""),[accessSecret,setAccessSecret]=useState("");
 const [enabled,setEnabled]=useState(false),[labelId,setLabelId]=useState(""),[processedId,setProcessedId]=useState(""),[confirmJob,setConfirmJob]=useState<string|null>(null);
 useEffect(()=>{
  let active=true,initialized=false,needsPoll=false;
  const load=async()=>{
   if(!mailboxId||document.hidden)return;
   try{
    const response=await authFetch(`/api/settings/paperless?${new URLSearchParams({mailboxId})}`);if(!response.ok)throw new Error();
    const value=await response.json() as State;if(!active)return;
    setData(value);needsPoll=value.counts.some(c=>["pending","uploading","waiting"].includes(c.status));
    if(!initialized){setUrl(value.connection?.baseUrl??"");setEnabled(value.connection?.enabled??false);setLabelId(value.connection?.labelId??value.labels.find(l=>l.name==="Paperless")?.id??"");setProcessedId(value.connection?.processedLabelId??value.labels.find(l=>l.name==="Verarbeitet"&&l.parentId===value.labels.find(x=>x.name==="Paperless")?.id)?.id??"");initialized=true;}
   }catch{if(active)setNotice(t("paperless.error.settings_failed"));}
  };
  void load();const timer=setInterval(()=>{if(needsPoll)void load();},10_000);
  const visible=()=>{if(!document.hidden)void load();};document.addEventListener("visibilitychange",visible);
  return()=>{active=false;clearInterval(timer);document.removeEventListener("visibilitychange",visible);};
 },[mailboxId,revision,t]);
 async function action(body:Record<string,unknown>){
  if(!mailboxId)return;setPending(true);setNotice("");
  try{
   const response=await authFetch("/api/settings/paperless",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,mailboxId})});
   const result=await response.json() as {error?:string};if(!response.ok){const key=`paperless.error.${result.error}` as Parameters<typeof t>[0];setNotice(t(key)===key?t("paperless.error.settings_failed"):t(key));return;}
   if(body.action==="save"){
    setData(previous=>previous?{...previous,connection:{baseUrl:url,enabled,labelId:labelId||previous.connection?.labelId||null,processedLabelId:processedId||previous.connection?.processedLabelId||null,hasToken:true,hasAccessCredentials:!!(accessId&&accessSecret)||!!previous.connection?.hasAccessCredentials}}:previous);
    setToken("");setAccessId("");setAccessSecret("");notifyLabelsChanged();
   }
   setConfirmJob(null);setRevision(n=>n+1);setNotice(t("paperless.saved"));
  }catch{setNotice(t("paperless.error.settings_failed"));}finally{setPending(false);}
 }
 const labelName=(label:Label)=>{const parent=data?.labels.find(l=>l.id===label.parentId);return parent?`${parent.name} / ${label.name}`:label.name;};
 return <section aria-label={t("paperless.title")} className="space-y-4">
  <h3 className="font-semibold">{t("paperless.title")}</h3>
  <p className="text-sm text-neutral-500">{t("paperless.description")}</p>
  {!data?<p className="text-sm text-neutral-500">{t("paperless.loading")}</p>:<>
   {data.connection?.enabled&&(!data.connection.labelId||!data.connection.processedLabelId)&&<p role="status" className="text-sm">{t("paperless.error.invalid_label")}</p>}
   {!data.available&&<p role="status" className="text-sm">{t("paperless.unavailable")}</p>}
   <form className="space-y-3" onSubmit={event=>{event.preventDefault();void action({action:"save",baseUrl:url,enabled,labelId:labelId||null,processedLabelId:processedId||null,...(token?{token}:{}),...(accessId?{accessId}:{}),...(accessSecret?{accessSecret}:{})});}}>
    <label className="block space-y-1 text-sm"><span>{t("paperless.url")}</span><Input type="url" required value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://dms.example.com" autoComplete="off"/></label>
    <label className="block space-y-1 text-sm"><span className="flex flex-wrap items-center justify-between gap-2"><span>{t("paperless.token")}</span>{data.connection?.hasToken&&!token&&<span aria-hidden="true" className="text-xs font-medium text-green-700">{t("paperless.saved")}</span>}</span><Input aria-label={t("paperless.token")} type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder={data.connection?.hasToken?"••••••••••••":""} autoComplete="new-password" required={!data.connection?.hasToken}/></label>
    <p className="text-xs text-neutral-500">{t("paperless.tokenHint")}</p>
    {data.connection?.hasToken&&<p className="text-xs text-neutral-500">{t("paperless.tokenSaved")}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
     <label className="block space-y-1 text-sm"><span>{t("paperless.trigger")}</span><select className="min-h-11 w-full rounded-lg border border-neutral-200 bg-white px-2" value={labelId} onChange={e=>setLabelId(e.target.value)}><option value="">{t("paperless.createTrigger")}</option>{data.labels.map(label=><option key={label.id} value={label.id}>{labelName(label)}</option>)}</select></label>
     <label className="block space-y-1 text-sm"><span>{t("paperless.processed")}</span><select className="min-h-11 w-full rounded-lg border border-neutral-200 bg-white px-2" value={processedId} onChange={e=>setProcessedId(e.target.value)}><option value="">{t("paperless.createProcessed")}</option>{data.labels.filter(l=>l.id!==labelId).map(label=><option key={label.id} value={label.id}>{labelName(label)}</option>)}</select></label>
    </div>
    <details className="rounded-lg border border-neutral-200 p-3 text-sm"><summary className="cursor-pointer">{t("paperless.access")}</summary><div className="mt-3 space-y-3"><p className="text-xs text-neutral-500">{t("paperless.accessHint")}</p><label className="block space-y-1"><span className="flex flex-wrap items-center justify-between gap-2"><span>{t("paperless.accessId")}</span>{data.connection?.hasAccessCredentials&&!accessId&&<span aria-hidden="true" className="text-xs font-medium text-green-700">{t("paperless.saved")}</span>}</span><Input aria-label={t("paperless.accessId")} placeholder={data.connection?.hasAccessCredentials?"••••••••••••":""} value={accessId} onChange={e=>setAccessId(e.target.value)} autoComplete="off"/></label><label className="block space-y-1"><span className="flex flex-wrap items-center justify-between gap-2"><span>{t("paperless.accessSecret")}</span>{data.connection?.hasAccessCredentials&&!accessSecret&&<span aria-hidden="true" className="text-xs font-medium text-green-700">{t("paperless.saved")}</span>}</span><Input aria-label={t("paperless.accessSecret")} placeholder={data.connection?.hasAccessCredentials?"••••••••••••":""} type="password" value={accessSecret} onChange={e=>setAccessSecret(e.target.value)} autoComplete="new-password"/></label></div></details>
    <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>{t("paperless.enable")}</label>
    <p className="text-xs text-neutral-500">{t("paperless.history")}</p>
    <Button type="submit" disabled={pending||!data.available}>{t("paperless.save")}</Button>
   </form>
   {!!data.counts.length&&<p className="text-sm text-neutral-500">{data.counts.map(c=>`${t(`paperless.status.${c.status}` as Parameters<typeof t>[0])}: ${c.count.toLocaleString(locale)}`).join(" · ")}</p>}
   {!!data.jobs.length&&<div className="space-y-2"><h4 className="text-sm font-semibold">{t("paperless.recent")}</h4>{data.jobs.map(job=><div key={job.id} className="space-y-2 rounded-lg border border-neutral-200 p-3 text-sm">
    <Link className="block break-words font-medium text-blue-600" href={`/inbox/${encodeURIComponent(job.messageId)}?mailboxId=${encodeURIComponent(mailboxId??"")}`}>{job.subject||t("list.noSubject")}</Link><p className="break-words">{job.filename}</p><p>{t(`paperless.status.${job.status}` as Parameters<typeof t>[0])}</p>
    {job.error&&<p className="text-xs text-neutral-500">{t(`paperless.error.${job.error}` as Parameters<typeof t>[0])}</p>}
    {job.documentId&&data.connection&&<a href={`${job.baseUrl}/documents/${job.documentId}/details`} target="_blank" rel="noopener noreferrer" className="text-blue-600">{t("paperless.openDocument")}</a>}
    {["pending","waiting","failed","paused","uncertain"].includes(job.status)&&<div className="flex flex-wrap gap-2">
     {["failed","paused","uncertain"].includes(job.status)&&<Button variant="outline" disabled={pending||!data.connection?.enabled} onClick={()=>(job.status==="uncertain"||job.error==="restore_requires_review")&&!job.taskId?setConfirmJob(job.id):void action({action:"retry",jobId:job.id})}>{t("paperless.retry")}</Button>}
     <Button variant="ghost" disabled={pending} onClick={()=>void action({action:"cancel",jobId:job.id})}>{t("paperless.cancel")}</Button>
    </div>}
    {confirmJob===job.id&&<div role="alert" className="space-y-2"><p>{t("paperless.duplicateWarning")}</p><div className="flex flex-wrap gap-2"><Button disabled={pending} onClick={()=>void action({action:"retry",jobId:job.id,confirmUncertain:true})}>{t("paperless.confirmRetry")}</Button><Button variant="ghost" onClick={()=>setConfirmJob(null)}>{t("paperless.back")}</Button></div></div>}
   </div>)}</div>}
  </>}
  {notice&&<p role="status" className="text-sm">{notice}</p>}
 </section>;
}
