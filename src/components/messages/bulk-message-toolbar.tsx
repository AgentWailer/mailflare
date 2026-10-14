"use client";

import { MailOrganizationButton } from "./mail-organization-button";
import { Archive, ArchiveRestore, ChevronDown, Folder, FolderInput, Inbox, Mail, MailOpen, MoreVertical, ShieldAlert, ShieldCheck, Tags, Trash2, Undo2, X } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useMailboxFolders } from "./use-mailbox-folders";
import { Tooltip } from "@/components/ui/tooltip";
import { supportsPermanentDelete } from "@/lib/messages/permanent-delete-utils";
import type { BulkMessageAction } from "@/app/api/messages/bulk/types";
import type { BulkMessageToolbarProps } from "./types";

const menuItemClass = "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-700 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-neutral-100";
const menuLabelClass = "mt-1 px-3 pb-1 pt-2 text-sm font-medium text-neutral-500";
const menuContentClass = "z-[130] max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-54 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg";

export function BulkMessageToolbar({
	messageIds,
	compact = false,
	mailboxId,
	selectedCount,
	hasUnreadSelection,
	hideSelectedCount = false,
	hideClearSelection = false,
	onAction,
	onClearSelection,
	pending,
	folder,
	onOrganizeAll,
	allCanManage,
	organizeDisabled,
}: BulkMessageToolbarProps) {
	const { t } = useLanguage();
	const managePending = pending || allCanManage === false;
	// In archived, spam and trash the usual button would be a no-op, so it becomes the way back to the inbox.
	const archive = folder === "archived"
		? { action: "inbox", label: t("common.unarchive"), Icon: ArchiveRestore }
		: { action: "archive", label: t("common.archive"), Icon: Archive };
	const spam = folder === "spam"
		? { action: "inbox", label: t("common.notSpam"), Icon: ShieldCheck }
		: { action: "spam", label: t("common.reportSpam"), Icon: ShieldAlert };
	const trash = folder === "trash"
		? { action: "inbox", label: t("common.restore"), Icon: Undo2 }
		: { action: "trash", label: t("common.delete"), Icon: Trash2 };
	// Trash and Spam also offer the irreversible delete; the page confirms before running it.
	const canDeleteForever = supportsPermanentDelete(folder);
	const moveOptions = [
		{ value: "inbox", label: t("navigation.inbox"), Icon: Inbox, hidden: !folder || folder === "inbox" },
		{ value: "archive", label: t("navigation.archived"), Icon: Archive, hidden: folder === "archived" },
		{ value: "spam", label: t("navigation.spam"), Icon: ShieldAlert, hidden: folder === "spam" },
		{ value: "trash", label: t("navigation.trash"), Icon: Trash2, hidden: folder === "trash" },
	].filter((option) => !option.hidden);
	const { selectedMailbox } = useSelectedMailbox();
	const folders = useMailboxFolders(mailboxId ?? selectedMailbox?.id);
	return (
		<div className="flex min-w-0 items-center gap-0 md:gap-2 text-neutral-600 w-full">
			{!hideSelectedCount && selectedCount > 0 && (
				<span className="md:mr-2 text-sm font-medium text-neutral-800">
					<span className={compact ? "" : "md:hidden"} aria-label={t("common.selectedCount", {count:selectedCount})}>{selectedCount}</span><span className={compact ? "hidden" : "max-md:hidden"}>{t("common.selectedCount", { count: selectedCount })}</span>
				</span>
			)}
			<span className={compact ? "flex-1" : "flex-1 md:hidden"} />
			{!!messageIds?.length && (mailboxId || selectedMailbox) && <MailOrganizationButton messageIds={messageIds} mailboxId={mailboxId ?? selectedMailbox!.id} onSaved={onClearSelection} onApplyAll={onOrganizeAll} allCount={selectedCount} allCanManage={allCanManage} disabled={pending || organizeDisabled || allCanManage === false} />}
			{!messageIds?.length && <Button variant="ghost" size="sm" disabled aria-label={t("smart.organize")}><Tags className="h-4 w-4" /></Button>}
			<Tooltip label={archive.label}>
				<Button variant="ghost" size="sm" className="max-md:h-11 max-md:w-11 max-md:shrink-0 max-md:px-0" onClick={() => onAction(archive.action as BulkMessageAction)} disabled={managePending} aria-label={archive.label}>
					<archive.Icon className="h-4 w-4" />
				</Button>
			</Tooltip>
			<Tooltip label={spam.label} className={compact ? "hidden" : "max-md:hidden"}>
				<Button variant="ghost" size="sm" onClick={() => onAction(spam.action as BulkMessageAction)} disabled={managePending} aria-label={spam.label}>
					<spam.Icon className="h-4 w-4" />
				</Button>
			</Tooltip>
			<Tooltip label={trash.label}>
				<Button variant="ghost" size="sm" onClick={() => onAction(trash.action as BulkMessageAction)} disabled={managePending} aria-label={trash.label}>
					<trash.Icon className="h-4 w-4" />
				</Button>
			</Tooltip>
			{canDeleteForever && (
				<Tooltip label={t("common.deleteForever")}>
					<Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => onAction("delete")} disabled={managePending} aria-label={t("common.deleteForever")}>
						<Trash2 className="h-4 w-4" />
					</Button>
				</Tooltip>
			)}
			<Tooltip label={hasUnreadSelection ? t("common.markRead") : t("common.markUnread")}>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => onAction(hasUnreadSelection ? "read" : "unread")}
					disabled={pending}
					aria-label={hasUnreadSelection ? t("common.markRead") : t("common.markUnread")}
				>
					{hasUnreadSelection ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
				</Button>
			</Tooltip>
			<DropdownMenu.Root>
				<Tooltip label={t("common.moveSelected")} className={compact ? "hidden" : "max-md:hidden"}>
					<DropdownMenu.Trigger asChild>
						<Button variant="ghost" size="sm" className={`${compact ? "hidden" : "max-md:hidden"} gap-1.5 bg-white text-xs font-medium text-neutral-700`} disabled={managePending} aria-label={t("common.moveSelected")}>
							<FolderInput className="h-4 w-4" />
							{t("common.moveTo")}
							<ChevronDown className="h-3.5 w-3.5 text-neutral-500" />
						</Button>
					</DropdownMenu.Trigger>
				</Tooltip>
				<DropdownMenu.Portal>
					<DropdownMenu.Content align="end" sideOffset={4} className={menuContentClass}>
						{moveOptions.map(({ value, label, Icon }) => (
							<DropdownMenu.Item key={value} className={menuItemClass} disabled={managePending} onSelect={() => onAction(value as BulkMessageAction)}><Icon className="h-4 w-4" />{label}</DropdownMenu.Item>
						))}
						{folders.length > 0 && (
							<>
								<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
								<DropdownMenu.Label className={menuLabelClass}>{t("navigation.folders")}</DropdownMenu.Label>
								{folders.map((item) => (
									<DropdownMenu.Item key={item.id} className={menuItemClass} disabled={managePending} onSelect={() => onAction("folder", item.id)}>
										<Folder className="h-4 w-4 shrink-0" style={{ color: item.color }} />
										<span className="truncate">{item.path ?? item.name}</span>
									</DropdownMenu.Item>
								))}
							</>
						)}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			{!hideClearSelection && <Tooltip label={t("common.clearSelection")} className={compact ? "hidden" : "max-md:hidden"}>
				<Button variant="ghost" size="sm" onClick={onClearSelection} disabled={pending} aria-label={t("common.clearSelection")}>
					<X className="h-4 w-4" />
				</Button>
			</Tooltip>}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<Button variant="ghost" size="sm" className={compact ? "" : "md:hidden"} disabled={pending} aria-label={t("common.moreActions")}>
						<MoreVertical className="h-4 w-4" />
					</Button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content align="end" sideOffset={4} className={`z-[130] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto min-w-44 rounded-xl border border-neutral-200 bg-white p-1 shadow-xl ${compact ? "" : "md:hidden"}`}>
						<DropdownMenu.Item className={menuItemClass} disabled={managePending} onSelect={() => onAction(archive.action as BulkMessageAction)}><archive.Icon className="h-4 w-4" />{archive.label}</DropdownMenu.Item>
						<DropdownMenu.Item className={menuItemClass} disabled={managePending} onSelect={() => onAction(spam.action as BulkMessageAction)}><spam.Icon className="h-4 w-4" />{spam.label}</DropdownMenu.Item>
						<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
						<DropdownMenu.Label className={menuLabelClass}>{t("common.moveTo")}</DropdownMenu.Label>
						{moveOptions.map(({ value, label, Icon }) => <DropdownMenu.Item key={value} className={menuItemClass} disabled={managePending} onSelect={() => onAction(value as BulkMessageAction)}><Icon className="h-4 w-4" />{label}</DropdownMenu.Item>)}
						{folders.map(item => <DropdownMenu.Item key={item.id} className={menuItemClass} disabled={managePending} onSelect={() => onAction("folder", item.id)}><Folder className="h-4 w-4 shrink-0" style={{ color: item.color }} /><span className="truncate">{item.path ?? item.name}</span></DropdownMenu.Item>)}
						{canDeleteForever && (
							<DropdownMenu.Item className={`${menuItemClass} text-red-600`} disabled={managePending} onSelect={() => onAction("delete")}><Trash2 className="h-4 w-4" />{t("common.deleteForever")}</DropdownMenu.Item>
						)}
						{!hideClearSelection && <><DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
						<DropdownMenu.Item className={menuItemClass} onSelect={onClearSelection}><X className="h-4 w-4" />{t("common.clearSelection")}</DropdownMenu.Item></>}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</div>
	);
}
