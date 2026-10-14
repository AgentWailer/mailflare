"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useLanguage } from "@/components/language-provider";
import { notifyLabelsChanged } from "@/components/messages/use-mailbox-folders";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

type Job = { id: string; mailboxId: string; connectionId: string; status: string; processed: number; imported: number; skipped: number; total: number; error: string | null; canSkip?: boolean };
type Status = { configured: boolean; missing: string[]; redirectUri: string | null; authorizationFailed: boolean; preferredConnectionId?: string | null; connections: { id: string; email: string }[]; jobs: Job[] };
async function request<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
	const session = getClientSessionToken();
	const response = await authFetch(path, body === undefined ? { method, cache: "no-store" } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const data = await response.json() as T & { error?: string };
	if (session !== getClientSessionToken()) throw new Error("Account changed; reopen the import");
	if (!response.ok) throw new Error(data.error ?? "Google import request failed");
	return data;
}
export function GmailImport({ embedded = false }: { embedded?: boolean } = {}) {
	const user = useCurrentUser(), { selectedMailbox } = useSelectedMailbox(), { t } = useLanguage();
	const running = useRef(false);
	const [busy, setBusy] = useState(false), [pausing, setPausing] = useState(false);
	const [activeImport, setActiveImport] = useState(false);
	const [connectionId, setConnectionId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const query = useQuery({ queryKey: ["gmail-import", user?.id], enabled: !!user,
		queryFn: () => { const params = new URLSearchParams(window.location.search); return request<Status>(`/api/import/gmail?${new URLSearchParams({ callback: params.get("gmail") ?? "", connection: params.get("googleConnection") ?? "" })}`, undefined, "GET"); },
		refetchOnWindowFocus: true,
		refetchInterval: q => q.state.data?.jobs.some(job => job.status === "running") ? 5000 : false,
	});
	useEffect(() => () => { running.current = false; }, [user?.id, selectedMailbox?.id]);
	const connection = query.data?.connections.find(item => item.id === connectionId) ?? query.data?.connections.find(item => item.id === query.data?.preferredConnectionId) ?? query.data?.connections[0];
	const canManage = !!selectedMailbox && (!selectedMailbox.permission || selectedMailbox.permission === "full_access");
	async function connect() {
		setError(null); setBusy(true);
		try { const result = await request<{ url: string }>("/api/import/gmail/connect", {}); window.location.assign(result.url); }
		catch (err) { setError(err instanceof Error ? err.message : t("gmail.failed")); setBusy(false); }
	}
	async function run(existing?: Job) {
		if (!connection || !selectedMailbox || running.current || busy) return;
		setError(null); setBusy(true); setActiveImport(true); setPausing(false); running.current = true;
		try {
			let job = existing ?? (await request<{ job: Job }>("/api/import/gmail/jobs", { connectionId: connection.id, mailboxId: selectedMailbox.id })).job;
			notifyLabelsChanged();
			await query.refetch();
			while (running.current && job.status !== "completed") {
				job = (await request<{ job: Job }>(`/api/import/gmail/jobs/${job.id}`, { action: "advance" })).job;
				await query.refetch(); notifyLabelsChanged();
				if (job.status === "failed") break;
				if (running.current) await new Promise(resolve => setTimeout(resolve, 150));
			}
		} catch (err) { setError(err instanceof Error ? err.message : t("gmail.failed")); }
		finally { running.current = false; setBusy(false); setActiveImport(false); setPausing(false); void query.refetch(); }
	}
	const jobs = query.data?.jobs.filter(job => job.mailboxId === selectedMailbox?.id) ?? [];
	return <section id={embedded ? undefined : "gmail-import"} className={`space-y-4 ${embedded ? "" : "rounded-3xl bg-white p-6"} [&_button]:h-auto [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_select]:min-h-11`}>
		{!embedded && <div><h2 className="text-xl font-semibold text-neutral-900">{t("gmail.title")}</h2><p className="mt-1 text-sm text-neutral-500">{t("gmail.description")}</p></div>}
		{query.isPending && <p role="status" className="text-sm text-neutral-500">{t("common.loading")}</p>}
		{query.data && !query.data.configured && <div className="space-y-2 rounded-xl bg-neutral-50 p-4 text-sm text-neutral-700">
			<p>{t("gmail.setup")}</p><p className="break-all font-mono text-xs">{query.data.missing.join(", ")}</p>
			<p>{t("gmail.redirect")}</p><p className="break-all font-mono text-xs">{query.data.redirectUri ?? "https://mail.stepo-data.de/api/import/gmail/callback"}</p>
			<a className="text-blue-700 underline" href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noreferrer">{t("gmail.console")}</a>
			<div><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("gmail.checkSetup")}</Button></div>
		</div>}
		<Button variant="outline" onClick={() => void connect()} disabled={!query.data?.configured || busy}>{t("gmail.connect")}</Button>
		{query.data?.connections.length ? <div className="space-y-3">
			<label className="block text-sm text-neutral-700">{t("gmail.source")}<Select aria-label={t("gmail.source")} className="mt-1 w-full" value={connection?.id ?? ""} onChange={event => setConnectionId(event.target.value)} disabled={busy}>{query.data.connections.map(item => <option key={item.id} value={item.id}>{item.email}</option>)}</Select></label>
			<p className="break-all text-sm text-neutral-700">{t("gmail.destination")}: {selectedMailbox ? `${selectedMailbox.localPart}@${selectedMailbox.hostname}` : t("importPage.selectMailboxFirst")}</p>
			<div className="flex flex-wrap gap-2"><Button onClick={() => void run()} disabled={!canManage || busy || !query.data.configured}>{t("gmail.start")}</Button>
			<Button variant="outline" disabled={busy} onClick={() => { if (connection && window.confirm(t("gmail.disconnectConfirm"))) { setBusy(true); void request(`/api/import/gmail/connections/${connection.id}`, undefined, "DELETE").then(() => query.refetch()).catch(err => setError(err instanceof Error ? err.message : t("gmail.failed"))).finally(() => setBusy(false)); } }}>{t("gmail.disconnect")}</Button></div>
		</div> : null}
		{busy && activeImport && <Button variant="outline" disabled={pausing} onClick={() => { running.current = false; setPausing(true); }}>{t(pausing ? "gmail.pausing" : "gmail.pause")}</Button>}
		{jobs.map(job => <div key={job.id} className="space-y-2 rounded-xl bg-neutral-50 p-4 text-sm text-neutral-700">
			<p className="break-all font-medium">{query.data?.connections.find(item => item.id === job.connectionId)?.email} → {selectedMailbox?.localPart}@{selectedMailbox?.hostname}</p>
			<p role="status">{job.status === "completed" ? t("gmail.completed") : job.status === "failed" ? t("gmail.interrupted") : t("gmail.progress", { processed: job.processed, total: job.total })}</p>
			<p>{t("gmail.counts", { imported: job.imported, skipped: job.skipped })}</p>{job.error && <p role="alert" className="break-words text-red-600">{job.error}</p>}
			{job.status !== "completed" && <Button variant="outline" disabled={busy || !canManage || !query.data?.configured} onClick={() => void run(job)}>{t("gmail.resume")}</Button>}
			{job.canSkip && <Button variant="outline" className="ml-2" disabled={busy || !canManage} onClick={() => { if (window.confirm(t("gmail.skipConfirm"))) { setBusy(true); void request(`/api/import/gmail/jobs/${job.id}`, { action: "skip" }).then(() => query.refetch()).catch(err => setError(err instanceof Error ? err.message : t("gmail.failed"))).finally(() => setBusy(false)); } }}>{t("gmail.skip")}</Button>}
		</div>)}
		{(error || query.isError || query.data?.authorizationFailed) && <div role="alert" className="text-sm text-red-600"><p>{error ?? t("gmail.failed")}</p><Button variant="outline" className="mt-2" onClick={() => { setError(null); const url = new URL(window.location.href); url.searchParams.delete("gmail"); window.history.replaceState({}, "", url); void query.refetch(); }}>{t("labels.visibility.retry")}</Button></div>}
		<p className="text-xs text-neutral-500">{t("gmail.note")}</p>
	</section>;
}
