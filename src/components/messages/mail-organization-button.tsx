"use client";
import { useState } from "react";
import { Tags } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";
import { useMailboxFolders } from "./use-mailbox-folders";
import type { MailCategory } from "@/lib/mail-sorting/categories";

export function MailOrganizationButton({
	messageIds,
	mailboxId,
	onSaved,
}: {
	messageIds: string[];
	mailboxId: string;
	onSaved?: () => void;
}) {
	const { t } = useLanguage();
	const folders = useMailboxFolders(mailboxId);
	const [reason, setReason] = useState("");
	const [open, setOpen] = useState(false);
	const [labels, setLabels] = useState<string[]>([]);
	const [category, setCategory] = useState<MailCategory | "">("");
	const [categoryChanged, setCategoryChanged] = useState(false);
	const [skipChanged, setSkipChanged] = useState(false);
	const [initialLabels, setInitialLabels] = useState<string[]>([]);
	const [skip, setSkip] = useState(false);
	const [remember, setRemember] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [canManage, setCanManage] = useState(false);
	async function show() {
		setOpen(true);
		setPending(true);
		setError("");
		setCanManage(false);
		setRemember(false);
		setCategoryChanged(false);
		setSkipChanged(false);
		try {
			const params = new URLSearchParams({ mailboxId });
			messageIds.forEach((id) => params.append("messageId", id));
			const response = await authFetch(`/api/mail-organization?${params}`);
			if (!response.ok) throw new Error();
			const data = (await response.json()) as {
				canManage: boolean;
				messages: Array<{
					category: MailCategory;
					status: string;
					folderId: string | null;
					sortingDecision?: string | null;
					labels: Array<{ id: string }>;
				}>;
			};
			const first = data.messages[0];
			try {
				const decision = JSON.parse(first.sortingDecision ?? "null");
				setReason(
					decision
						? t(
								decision.reviewRequired && decision.reason !== "observation"
									? "smart.reasonBulkReview"
									: decision.reason === "observation"
									? "smart.reasonObserve"
									: decision.source === "clef"
										? "smart.reasonAi"
										: decision.source === "rule"
											? "smart.reasonRule"
											: decision.source === "override"
												? "smart.reasonSender"
												: decision.source === "manual"
													? "smart.reasonManual"
													: "smart.reasonFallback",
							)
						: "",
				);
			} catch {
				setReason("");
			}
			const common = first.labels
				.filter((label) =>
					data.messages.every((message) =>
						message.labels.some((item) => item.id === label.id),
					),
				)
				.map((label) => label.id);
			setLabels(common);
			setInitialLabels(common);
			setCategory(
				data.messages.every((message) => message.category === first.category)
					? first.category
					: "",
			);
			setSkip(
				data.messages.every(
					(message) => message.status === "archived" || !!message.folderId,
				),
			);
			setCanManage(data.canManage);
		} catch {
			setError(t("smart.failed"));
		} finally {
			setPending(false);
		}
	}
	async function save() {
		setPending(true);
		setError("");
		try {
			const response = await authFetch("/api/mail-organization", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mailboxId,
					messageIds,
					addLabelIds: labels.filter((id) => !initialLabels.includes(id)),
					removeLabelIds: initialLabels.filter((id) => !labels.includes(id)),
					...((categoryChanged || remember) && category ? { category } : {}),
					...(skipChanged ? { skipInbox: skip } : {}),
					rememberSender: remember,
				}),
			});
			if (!response.ok) throw new Error();
			window.dispatchEvent(new Event("mailflare:messages-changed"));
			setOpen(false);
			onSaved?.();
		} catch {
			setError(t("smart.failed"));
		} finally {
			setPending(false);
		}
	}
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				className="min-h-11 min-w-11"
				aria-label={t("smart.organize")}
				title={t("smart.organize")}
				onClick={() => void show()}
			>
				<Tags className="h-4 w-4" />
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{t("smart.organize")}</DialogTitle>
						<DialogDescription>{t("smart.organizeHelp")}</DialogDescription>
					</DialogHeader>
					<div className="space-y-4">
						{reason && messageIds.length === 1 && (
							<p className="text-sm text-neutral-500">{reason}</p>
						)}
						<label className="grid gap-2 text-sm">
							{t("smart.category")}
							<select
								aria-label={t("smart.category")}
								className="min-h-11 rounded-lg border border-neutral-200 bg-white px-3 text-base"
								value={category}
								disabled={pending || !canManage}
								onChange={(event) => {
									setCategory(event.target.value as MailCategory | "");
									setCategoryChanged(true);
								}}
							>
								<option value="">{t("smart.keep")}</option>
								<option value="primary">{t("smart.primary")}</option>
								<option value="promotions">{t("smart.promotions")}</option>
								<option value="social">{t("smart.social")}</option>
<option value="invoices">{t("smart.invoices")}</option>
<option value="orders">{t("smart.orders")}</option>
							</select>
						</label>
						<fieldset disabled={pending || !canManage}>
							<legend className="mb-2 text-sm font-medium">
								{t("smart.labels")}
							</legend>
							<div className="max-h-48 overflow-y-auto">
								{folders.map((folder) => (
									<label
										key={folder.id}
										className="flex min-h-11 items-center gap-3 text-sm"
									>
										<input
											type="checkbox"
											checked={labels.includes(folder.id)}
											onChange={(event) =>
												setLabels((current) =>
													event.target.checked
														? [...current, folder.id]
														: current.filter((id) => id !== folder.id),
												)
											}
										/>
										<span className="min-w-0 break-words">{folder.path ?? folder.name}</span>
									</label>
								))}
							</div>
						</fieldset>
						<label className="flex min-h-11 items-center gap-3 text-sm">
							<input
								type="checkbox"
								checked={skip}
								disabled={pending || !canManage}
								onChange={(event) => {
									setSkip(event.target.checked);
									setSkipChanged(true);
								}}
							/>
							{t("smart.skip")}
						</label>
						<label className="flex min-h-11 items-center gap-3 text-sm">
							<input
								type="checkbox"
								checked={remember}
								disabled={!category || pending || !canManage}
								onChange={(event) => setRemember(event.target.checked)}
							/>
							{t("smart.remember")}
						</label>
						<p className="text-xs text-neutral-500">{t("smart.learningHelp")}</p>
						<p className="text-xs text-neutral-500">{t("smart.inboxHelp")}</p>
						{error && (
							<p role="alert" className="text-sm text-red-600">
								{error}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => setOpen(false)}>
								{t("common.cancel")}
							</Button>
							<Button
								disabled={pending || !canManage}
								onClick={() => void save()}
							>
								{pending ? t("common.saving") : t("rules.saveChanges")}
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
