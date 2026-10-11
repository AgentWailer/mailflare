"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { notifyLabelsChanged } from "@/components/messages/use-mailbox-folders";
import { getLabelPath } from "@/lib/folders/hierarchy";
import { getClientSessionToken } from "@/lib/auth/client";
import { createRuleLabel } from "./inbox-rules-utils";
import type { RuleFolder, RuleFoldersResponse } from "./inbox-rules-types";
import { RoutingRuleSelect } from "./domain-routing/routing-rule-select";

export function RuleLabelCreator({ mailboxId, folders, onCreated, onPendingChange }: {
 mailboxId: string; folders: RuleFolder[]; onCreated: (labelId: string) => void; onPendingChange: (pending: boolean) => void;
}) {
 const { t } = useLanguage(), client = useQueryClient();
 const [open, setOpen] = useState(false), [name, setName] = useState(""), [parentId, setParentId] = useState("");
 const [pending, setPending] = useState(false), [failed, setFailed] = useState<string | null>(null);
 const mounted = useRef(true), creating = useRef(false);
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; onPendingChange(false); }; }, [onPendingChange]);
 async function create() {
  if (creating.current || !name.trim()) return;
  creating.current = true; setPending(true); setFailed(null); onPendingChange(true);
  const token = getClientSessionToken();
  try {
   const folder = await createRuleLabel({ mailboxId, name: name.trim(), parentId: parentId || null }, t);
   await client.cancelQueries({ queryKey: ["folders", mailboxId] });
   if (token !== getClientSessionToken()) throw new Error(t("labels.createFailed"));
   client.setQueryData<RuleFoldersResponse>(["folders", mailboxId], previous => ({ folders: [...(previous?.folders ?? []).filter(item => item.id !== folder.id), folder].sort((a, b) => a.name.localeCompare(b.name)) }));
   notifyLabelsChanged();
   if (mounted.current) { onCreated(folder.id); setName(""); setParentId(""); setOpen(false); }
  } catch (error) { if (mounted.current) setFailed(error instanceof Error ? error.message : t("labels.createFailed")); }
  finally { creating.current = false; if (mounted.current) { setPending(false); onPendingChange(false); } }
 }
 if (!open) return <Button type="button" variant="outline" className="mt-2 min-h-11" disabled={!mailboxId} onClick={() => { setFailed(null); setOpen(true); }}><Plus className="h-4 w-4" />{t("labels.new")}</Button>;
 return <div className="mt-2 space-y-3 rounded-xl border border-neutral-200 bg-neutral-50 p-3" role="group" aria-label={t("labels.new")}>
  <label className="grid gap-1 text-sm">{t("navigation.folderName")}<Input autoFocus className="min-h-11 text-base" maxLength={80} value={name} disabled={pending} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void create(); } }} /></label>
  <label className="grid gap-1 text-sm">{t("labels.parent")}<RoutingRuleSelect className="min-h-11" value={parentId} disabled={pending} onChange={event => setParentId(event.target.value)}><option value="">{t("labels.topLevel")}</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{getLabelPath(folder, folders)}</option>)}</RoutingRuleSelect></label>
  {failed && <p role="alert" className="text-sm text-red-700">{failed}</p>}
  <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={pending} onClick={() => setOpen(false)}>{t("common.cancel")}</Button><Button type="button" className="min-h-11" disabled={pending || !name.trim()} onClick={() => void create()}>{t(pending ? "navigation.creating" : "labels.create")}</Button></div>
 </div>;
}
