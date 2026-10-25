"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import { isMailMcpScope } from "@/lib/mcp/scopes";
import { keyPermissions, MCP_KEY_SCOPES } from "./api-keys-settings-utils";
import type { ManagedApiKey } from "./api-keys-settings-types";

type Status={identityStatus?:string;identitySource?:string;configured:boolean;serverUrl:string;identity:{email:string}|null;grant:{enabled:boolean;keyId:string;email:string;identityMatches:boolean}|null};
export function McpOauthSettings({keys}:{keys:ManagedApiKey[]}) {
 const user=useCurrentUser(),{t}=useLanguage();
 const [choice,setChoice]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 const query=useQuery({queryKey:["mcp-oauth",user?.id],enabled:!!user,queryFn:async()=>{
  const session=getClientSessionToken(),response=await authFetch("/api/settings/mcp-oauth",{cache:"no-store",redirectOnUnauthorized:false});
  if(!response.ok || session!==getClientSessionToken())throw new Error();return await response.json() as Status;
 }});
 const identityStatus=query.data?.identityStatus;
 const identityMessage=identityStatus==="certificates_unavailable"?"mcp.oauth.certsUnavailable":identityStatus==="not_user_identity"?"mcp.oauth.userLoginRequired":["expired_assertion","not_yet_valid","issuer_mismatch","audience_mismatch"].includes(identityStatus??"")?"mcp.oauth.sessionExpired":"mcp.oauth.noIdentity";
 const eligible=keys.filter(key=>key.kind==="mcp" && keyPermissions(key).length>0 && keyPermissions(key).every(isMailMcpScope));
 const selected=eligible.find(key=>key.id===(choice||query.data?.grant?.keyId))??eligible[0];
 async function update(enabled:boolean){
  setBusy(true);setError(null);const session=getClientSessionToken();
  try {
   const response=await authFetch("/api/settings/mcp-oauth",{method:"POST",redirectOnUnauthorized:false,headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled,...(enabled?{keyId:selected?.id}:{})})});
   const data=await response.json() as Status & {error?:string};
   if(session!==getClientSessionToken())throw new Error("oauth_update_failed");
   if(!response.ok)throw new Error(data.error??"oauth_update_failed");
   await query.refetch();
  }catch(cause){setError(cause instanceof Error?cause.message:"oauth_update_failed");}finally{setBusy(false);}
 }
 return <div className="space-y-3 rounded-2xl border border-neutral-200 bg-white p-4 sm:p-5">
  <div><h2 className="font-medium text-neutral-900">{t("mcp.oauth.title")}</h2><p className="mt-1 text-sm text-neutral-600">{t("mcp.oauth.description")}</p></div>
  {query.isPending && <p role="status" className="text-sm text-neutral-500">{t("common.loading")}</p>}
  {query.isError && <Button variant="outline" onClick={()=>void query.refetch()}>{t("labels.visibility.retry")}</Button>}
  {query.data && !query.data.configured && <details className="text-sm text-neutral-600"><summary className="cursor-pointer py-2">{t("mcp.oauth.setup")}</summary><p className="mt-2">{t("mcp.oauth.setupHelp")}</p></details>}
  {query.data?.configured && <>
   <p className="break-all text-sm text-neutral-700">{query.data.identity?t("mcp.oauth.identity",{email:query.data.identity.email}):t(identityMessage)}</p>
   {!query.data.identity && <div className="space-y-2">
    <div className="flex flex-wrap gap-2"><Button variant="outline" className="h-auto min-h-11 max-w-full whitespace-normal" disabled={query.isFetching} onClick={()=>{setError(null);void query.refetch();}}>{t("mcp.oauth.recheck")}</Button>
    {["expired_assertion","issuer_mismatch","audience_mismatch","not_user_identity"].includes(identityStatus??"") && <Button asChild variant="outline" className="h-auto min-h-11 max-w-full whitespace-normal"><a href="/cdn-cgi/access/logout">{t("mcp.oauth.reauthenticate")}</a></Button>}</div>
    {identityStatus && <details className="text-xs text-neutral-500"><summary className="cursor-pointer py-1">{t("mcp.oauth.diagnostics")}</summary><code className="break-all">{identityStatus} ({query.data.identitySource??"unknown"})</code></details>}
   </div>}
   {eligible.length ? <label className="block text-sm text-neutral-700">{t("mcp.oauth.permissions")}<Select className="mt-1 w-full" value={selected?.id??""} onChange={event=>setChoice(event.target.value)} disabled={busy}>{eligible.map(key=><option key={key.id} value={key.id}>{key.name}</option>)}</Select></label>:<p className="text-sm text-neutral-600">{t("mcp.oauth.createKey")}</p>}
   {selected && <ul className="flex flex-wrap gap-1 text-xs text-neutral-600">{MCP_KEY_SCOPES.filter(scope=>keyPermissions(selected).includes(scope.value)).map(scope=><li key={scope.value} className="rounded bg-neutral-100 px-2 py-1">{t(scope.labelKey)}</li>)}</ul>}
   {query.data.grant?.enabled && <p role="status" className="text-sm text-neutral-700">{t(query.data.grant.identityMatches?"mcp.oauth.active":"mcp.oauth.identityChanged")}</p>}
   <div className="flex flex-wrap gap-2">
    <Button className="h-auto min-h-11 max-w-full whitespace-normal" disabled={busy||!selected||!query.data.identity} onClick={()=>void update(true)}>{t(query.data.grant?.enabled?"mcp.oauth.update":"mcp.oauth.enable")}</Button>
    {query.data.grant?.enabled && <Button variant="outline" className="h-auto min-h-11 max-w-full whitespace-normal" disabled={busy} onClick={()=>void update(false)}>{t("mcp.oauth.disable")}</Button>}
   </div>
   <details className="text-sm text-neutral-600"><summary className="cursor-pointer py-2">{t("mcp.oauth.connect")}</summary><ol className="mt-2 list-decimal space-y-2 pl-5"><li>{t("mcp.oauth.step1")}</li><li><code className="break-all text-xs">{query.data.serverUrl}</code></li><li>{t("mcp.oauth.step2")}</li></ol></details>
   <p className="text-xs text-neutral-500">{t("mcp.oauth.review")}</p>
  </>}
  {error && <p role="alert" className="text-sm text-red-600">{t(error==="identity_already_linked"?"mcp.oauth.linkedElsewhere":error==="access_identity_required"?"mcp.oauth.noIdentity":"mcp.oauth.failed")}</p>}
 </div>;
}
