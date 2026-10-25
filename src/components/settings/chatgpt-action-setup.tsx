"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { createChatGptSendAction } from "@/lib/integrations/chatgpt-action";

export function ChatGptActionSetup({mailboxes}:{mailboxes:{id:string;address:string}[]}) {
 const {t}=useLanguage(),[mailboxId,setMailboxId]=useState(mailboxes[0]?.id ?? ""),[failed,setFailed]=useState(false);
 function download() {
  try {
   const mailbox=mailboxes.find(item=>item.id===mailboxId);if(!mailbox)return;
   const schema=createChatGptSendAction(window.location.origin,mailbox),url=URL.createObjectURL(new Blob([JSON.stringify(schema,null,2)],{type:"application/json"}));
   const anchor=document.createElement("a");anchor.href=url;anchor.download="mailflare-chatgpt-action.json";document.body.appendChild(anchor);anchor.click();anchor.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);setFailed(false);
  }catch{setFailed(true);}
 }
 return <details className="rounded-xl border border-neutral-200 bg-white p-3 text-sm text-neutral-700">
  <summary className="cursor-pointer py-1 font-medium">{t("apiKeys.chatgpt.title")}</summary>
  <ol className="my-3 list-decimal space-y-2 pl-5"><li>{t("apiKeys.chatgpt.step1")}</li><li>{t("apiKeys.chatgpt.step2")}</li><li>{t("apiKeys.chatgpt.step3")}</li></ol>
  {mailboxes.length>1 && <label className="mb-3 block">{t("gmail.destination")}<Select className="mt-1 w-full" value={mailboxId} onChange={event=>setMailboxId(event.target.value)}>{mailboxes.map(mailbox=><option key={mailbox.id} value={mailbox.id}>{mailbox.address}</option>)}</Select></label>}
  <Button type="button" variant="outline" className="h-auto min-h-11 max-w-full whitespace-normal" disabled={!mailboxId} onClick={download}>{t("apiKeys.chatgpt.download")}</Button>
  <p className="mt-3 text-xs text-neutral-500">{t("apiKeys.chatgpt.access")}</p>
  {failed && <p role="alert" className="mt-2 text-red-600">{t("apiKeys.chatgpt.failed")}</p>}
 </details>;
}
