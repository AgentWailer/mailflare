"use client";

import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMailboxFolders } from "@/components/messages/use-mailbox-folders";
import { useLabelVisibility } from "@/components/messages/use-label-visibility";
import { getLabelPath } from "@/lib/folders/hierarchy";
import { LabelParentSelect } from "./label-parent-select";
import { Button } from "@/components/ui/button";

export function LabelVisibilitySettings() {
	const { t } = useLanguage();
	const { selectedMailbox, isLoading: mailboxLoading } = useSelectedMailbox();
	const canManage = !!selectedMailbox && (!selectedMailbox.permission || selectedMailbox.permission === "full_access");
	const folders = useMailboxFolders(selectedMailbox?.id);
	const { hiddenLabelIds, isLoading, failed, saving, setVisible, retry } = useLabelVisibility(selectedMailbox?.id);
	return <details id="labels" className="scroll-mt-4 space-y-3" aria-label={t("labels.visibility.title")}>
		<summary className="cursor-pointer rounded-lg py-2 text-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
			<span className="text-base font-semibold">{t("labels.visibility.title")}</span>
		</summary>
		<div>
			<p className="mt-1 text-sm text-neutral-500">{t("labels.visibility.description")}</p>
			<p className="mt-1 text-sm text-neutral-500">{t("labels.hierarchyDescription")}</p>
			{selectedMailbox && <p className="mt-2 break-all text-sm text-neutral-700">{selectedMailbox.localPart}@{selectedMailbox.hostname}</p>}
		</div>
		{failed && <div role="alert" className="text-sm text-red-700"><p>{t("labels.visibility.failed")}</p><Button variant="outline" className="mt-2 min-h-11" onClick={() => void retry()}>{t("labels.visibility.retry")}</Button></div>}
		{mailboxLoading || isLoading ? <p role="status" className="text-sm text-neutral-500">{t("common.loading")}</p> : folders.length === 0 ? <p className="text-sm text-neutral-500">{t("navigation.noFolders")}</p> : folders.map(folder => <div key={`${selectedMailbox?.id}:${folder.id}`} className="space-y-2 rounded-xl bg-neutral-50 p-3"><div className="flex min-h-11 items-center gap-3">
			<span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: folder.color }} />
			<span className="min-w-0 flex-1 break-words text-sm text-neutral-900">{getLabelPath(folder, folders)}</span>
			<span className="shrink-0 text-xs text-neutral-500">{t(hiddenLabelIds.includes(folder.id) ? "labels.visibility.hidden" : "labels.visibility.shown")}</span>
			<button type="button" role="switch" aria-checked={!hiddenLabelIds.includes(folder.id)} disabled={saving || isLoading} onClick={() => { void setVisible({ labelId: folder.id, visible: hiddenLabelIds.includes(folder.id) }).catch(() => {}); }} aria-label={t("labels.visibility.toggle", { name: folder.name })} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 disabled:opacity-50">
				<span aria-hidden="true" className={`flex h-6 w-11 items-center rounded-full transition-colors ${hiddenLabelIds.includes(folder.id) ? "bg-neutral-300" : "bg-blue-600"}`}><span className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${hiddenLabelIds.includes(folder.id) ? "translate-x-0.5" : "translate-x-[21px]"}`} /></span>
			</button>
		</div>{canManage && selectedMailbox && <LabelParentSelect mailboxId={selectedMailbox.id} folder={folder} folders={folders} />}
		</div>)}
	</details>;
}
