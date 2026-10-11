"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RuleLabelCreator } from "./rule-label-creator";
import { getLabelPath } from "@/lib/folders/hierarchy";
import { getEmailAddress } from "@/lib/email/address";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { RoutingRuleSelect } from "./domain-routing/routing-rule-select";
import {
	createInboxRule,
	updateInboxRule,
	deleteInboxRule,
	fetchInboxRules,
	fetchRuleFolders,
} from "./inbox-rules-utils";
import type {
	InboxRule,
	InboxRuleInput,
	RuleCondition,
	InboxRuleSource,
} from "./inbox-rules-types";
const freshCondition = (): RuleCondition => ({
	field: "sender",
	operator: "contains",
	value: "",
	negate: false,
});
function storedArray<T>(value: string | undefined): T[] {
	try {
		const parsed = JSON.parse(value ?? "[]");
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}
export function InboxRules({ sourceMessage, onClose }: {sourceMessage?: InboxRuleSource; onClose?: () => void} = {}) {
	const { t } = useLanguage();
	const { selectedMailbox, mailboxes } = useSelectedMailbox();
	const mailboxId = sourceMessage?.mailboxId ?? selectedMailbox?.id ?? "";
	const ruleMailbox = selectedMailbox?.id === mailboxId ? selectedMailbox : mailboxes.find(box => box.id === mailboxId);
	const canManageLabels = !!ruleMailbox && (!ruleMailbox.permission || ruleMailbox.permission === "full_access");
	const client = useQueryClient();
	const [open, setOpen] = useState(!!sourceMessage);
	const [step, setStep] = useState<"criteria" | "actions">("criteria");
	const criteriaStep = !!sourceMessage && step === "criteria";
	const [editing, setEditing] = useState<InboxRule | null>(null);
	const [conditions, setConditions] = useState<RuleCondition[]>([
		sourceMessage ? {field:"sender",operator:"exact",value:getEmailAddress(sourceMessage.fromAddr),negate:false} : freshCondition(),
	]);
	const [mode, setMode] = useState<"all" | "any">("all");
	const [labelCreating, setLabelCreating] = useState(false);
	const [labels, setLabels] = useState<string[]>([]);
	const [category, setCategory] = useState<
		"primary" | "promotions" | "social" | ""
	>("");
	const [destination, setDestination] = useState("keep");
	const [skip, setSkip] = useState(false);
	const [enabled, setEnabled] = useState(true);
	const [priority, setPriority] = useState(10);
	const [forward, setForward] = useState(false);
	const [forwardTo, setForwardTo] = useState("");
	function changeOpen(next: boolean) { setLabelCreating(false); setOpen(next); if (!next) onClose?.(); }
	const folders = useQuery({
		queryKey: ["folders", mailboxId],
		enabled: !!mailboxId,
		queryFn: () => fetchRuleFolders(mailboxId),
	});
	const rules = useQuery({
		queryKey: ["routing-rules", mailboxId],
		enabled: !!mailboxId,
		queryFn: () => fetchInboxRules(mailboxId),
	});
	const save = useMutation({
		mutationFn: () => {
			const first = conditions[0];
			const input: InboxRuleInput = {
				mailboxId,
				...(sourceMessage ? {sourceMessageId:sourceMessage.id} : {}),
				...(forward ? {forwardTo:forwardTo.trim()} : {}),
				matchField: first.field,
				matchOperator: first.operator,
				matchValue: first.value,
				conditions,
				conditionMode: mode,
				labelIds: labels,
				...(category ? { category } : {}),
				skipInbox: skip,
				enabled,
				priority,
				destination,
			};
			return editing
				? updateInboxRule(editing.id, input, t)
				: createInboxRule(input, t);
		},
		onSuccess: () => {
			changeOpen(false);
			client.invalidateQueries({ queryKey: ["routing-rules", mailboxId] });
		},
	});
	const remove = useMutation({
		mutationFn: deleteInboxRule,
		onSuccess: () =>
			client.invalidateQueries({ queryKey: ["routing-rules", mailboxId] }),
	});
	function show(rule: InboxRule | null) {
		setLabelCreating(false);
		setEditing(rule);
		const items = storedArray<RuleCondition>(rule?.conditions);
		setConditions(
			items.length
				? items
				: rule
					? [
							{
								field: rule.matchField,
								operator: rule.matchOperator,
								value: rule.matchValue || rule.pattern,
								negate: false,
							},
						]
					: [freshCondition()],
		);
		setMode(rule?.conditionMode ?? "all");
		setLabels([
			...new Set([
				...storedArray<string>(rule?.labelIds),
				...(rule?.folderId ? [rule.folderId] : []),
			]),
		]);
		setCategory(rule?.category ?? "");
		setDestination(
			rule?.action === "spam" || rule?.action === "trash"
				? rule.action
				: "keep",
		);
		setSkip(rule?.skipInbox || !!rule?.folderId || false);
		setEnabled(rule?.enabled ?? true);
		setPriority(rule?.priority ?? 10);
		setForward(!!rule?.forwardTo);
		setForwardTo(rule?.forwardTo ?? "");
		save.reset();
		setOpen(true);
	}
	function editCondition(index: number, patch: Partial<RuleCondition>) {
		setConditions((current) =>
			current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
		);
	}
	const fields = [
		{ value: "sender", label: t("smart.sender") },
		{ value: "recipient", label: t("smart.recipient") },
		{ value: "title", label: t("rules.field.title") },
		{ value: "content", label: t("rules.field.content") },
		{ value: "email", label: t("rules.field.email") },
	];
	return (
		<section className="space-y-4">
			{!sourceMessage && <>
			<div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
				<div className="min-w-0 flex-1">
					<h2 className="text-xl font-semibold">{t("rules.mailboxTitle")}</h2>
					<p className="mt-1 text-sm text-neutral-500">
						{t("smart.inboxHelp")}
					</p>
				</div>
				<Button disabled={!mailboxId} onClick={() => show(null)}>
					<Plus className="h-4 w-4" />
					{t("rules.new")}
				</Button>
			</div>
			<div className="space-y-2 rounded-3xl bg-white p-4">
				{!rules.data?.rules.length && (
					<p className="text-sm text-neutral-500">{t("rules.none")}</p>
				)}
				{rules.data?.rules.map((rule) => (
					<div
						key={rule.id}
						className="flex items-center gap-2 rounded-xl bg-neutral-50 p-2"
					>
						<button
							type="button"
							className="min-h-11 min-w-0 flex-1 text-left"
							onClick={() => show(rule)}
						>
							<span className="block truncate text-sm font-medium">
								{rule.matchValue || rule.pattern}
							</span>
							<span className="block truncate text-xs text-neutral-500">
								{rule.enabled ? t("smart.enabled") : t("smart.off")} ·{" "}
								{rule.forwardTo ? `${t("rules.forward")} · ${rule.forwardTo}` : rule.category
									? t(
											rule.category === "primary"
												? "smart.primary"
												: rule.category === "social"
													? "smart.social"
													: "smart.promotions",
										)
									: rule.action === "spam"
										? t("navigation.spam")
										: rule.action === "trash"
											? t("navigation.trash")
											: t("smart.labels")}{" "}
								· {rule.priority}
							</span>
						</button>
						<Button
							variant="ghost"
							className="min-h-11 min-w-11"
							aria-label={t("rules.delete")}
							disabled={remove.isPending}
							onClick={() => remove.mutate(rule.id)}
						>
							<Trash2 className="h-4 w-4" />
						</Button>
					</div>
				))}
				{(rules.isError || remove.isError) && (
					<p role="alert" className="text-sm text-red-600">
						{t("smart.failed")}
					</p>
				)}
			</div>
			</>}
			<Dialog open={open} onOpenChange={changeOpen}>
				<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>
							{sourceMessage ? t("rules.fromMessage") : editing ? t("rules.update") : t("rules.new")}
						</DialogTitle>
						<DialogDescription>
							{sourceMessage ? t(criteriaStep ? "rules.criteriaHelp" : "rules.actionsHelp") : t("rules.dialogDescription")}
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (criteriaStep) { setStep("actions"); return; }
							if (!labelCreating) save.mutate();
						}}
					>
						{(!sourceMessage || criteriaStep) && <>
						{sourceMessage && <div className="flex flex-wrap gap-2">
							<Button type="button" variant="outline" className="min-h-11" onClick={() => setConditions([{field:"sender",operator:"exact",value:getEmailAddress(sourceMessage.fromAddr),negate:false}])}>{t("rules.exactSender")}</Button>
							<Button type="button" variant="outline" className="min-h-11" onClick={() => setConditions([{field:"sender",operator:"ends_with",value:"@"+getEmailAddress(sourceMessage.fromAddr).split("@").at(-1),negate:false}])}>{t("rules.senderDomain")}</Button>
							{sourceMessage.subject && <Button type="button" variant="outline" className="min-h-11" disabled={conditions.length>=12} onClick={() => setConditions(current=>[...current,{field:"title",operator:"contains",value:sourceMessage.subject!.slice(0,500),negate:false}])}>{t("rules.addSubject")}</Button>}
						</div>}
						<label className="grid gap-2 text-sm">
							{t("rules.matchLabel")}
							<RoutingRuleSelect
								value={mode}
								onChange={(event) =>
									setMode(event.target.value as "all" | "any")
								}
							>
								<option value="all">{t("smart.all")}</option>
								<option value="any">{t("smart.any")}</option>
							</RoutingRuleSelect>
						</label>
						{conditions.map((condition, index) => (
							<fieldset
								key={index}
								className="space-y-2 rounded-xl border border-neutral-200 p-3"
							>
								<legend className="px-1 text-xs text-neutral-500">
									{index + 1}
								</legend>
								<div className="grid grid-cols-2 gap-2">
									<label className="grid gap-1 text-xs">
										{t("rules.fieldLabel")}
										<RoutingRuleSelect
											value={condition.field}
											onChange={(event) =>
												editCondition(index, {
													field: event.target.value as RuleCondition["field"],
												})
											}
										>
											{fields.map((field) => (
												<option key={field.value} value={field.value}>
													{field.label}
												</option>
											))}
										</RoutingRuleSelect>
									</label>
									<label className="grid gap-1 text-xs">
										{t("rules.matchLabel")}
										<RoutingRuleSelect
											value={condition.operator}
											onChange={(event) =>
												editCondition(index, {
													operator: event.target
														.value as RuleCondition["operator"],
												})
											}
										>
											<option value="contains">
												{t("rules.operatorOption.contains")}
											</option>
											<option value="exact">
												{t("rules.operatorOption.exact")}
											</option>
											<option value="starts_with">
												{t("routing.operator.starts_with")}
											</option>
											<option value="ends_with">
												{t("routing.operator.ends_with")}
											</option>
										</RoutingRuleSelect>
									</label>
								</div>
								<label className="grid gap-1 text-xs">
									{t("rules.valueLabel")}
									<Input
										className="min-h-11 text-base"
										required
										maxLength={500}
										value={condition.value}
										onChange={(event) =>
											editCondition(index, { value: event.target.value })
										}
									/>
								</label>
								<div className="flex items-center gap-2">
									<label className="flex min-h-11 flex-1 items-center gap-2 text-sm">
										<input
											type="checkbox"
											checked={condition.negate}
											onChange={(event) =>
												editCondition(index, { negate: event.target.checked })
											}
										/>
										{t("smart.except")}
									</label>
									<Button
										type="button"
										variant="ghost"
										aria-label={t("smart.removeCondition")}
										disabled={conditions.length === 1}
										onClick={() =>
											setConditions((current) =>
												current.filter((_, i) => i !== index),
											)
										}
									>
										<Trash2 className="h-4 w-4" />
									</Button>
								</div>
							</fieldset>
						))}
						<Button
							type="button"
							variant="outline"
							disabled={conditions.length >= 12}
							onClick={() =>
								setConditions((current) => [...current, freshCondition()])
							}
						>
							<Plus className="h-4 w-4" />
							{t("smart.addCondition")}
						</Button>
						</>}
						{!criteriaStep && <>
						<div className="grid gap-3 sm:grid-cols-2">
							<label className="grid gap-1 text-sm">
								{t("smart.category")}
								<RoutingRuleSelect
									aria-label={t("smart.category")}
									value={category}
									onChange={(event) =>
										setCategory(event.target.value as typeof category)
									}
								>
									<option value="">{t("smart.keep")}</option>
									<option value="primary">{t("smart.primary")}</option>
									<option value="promotions">{t("smart.promotions")}</option>
									<option value="social">{t("smart.social")}</option>
								</RoutingRuleSelect>
							</label>
							<label className="grid gap-1 text-sm">
								{t("rules.destination")}
								<RoutingRuleSelect
									aria-label={t("rules.destination")}
									value={destination}
									onChange={(event) => { setDestination(event.target.value); if (event.target.value !== "keep") setForward(false); }}
								>
									<option value="keep">{t("smart.keep")}</option>
									<option value="spam">{t("navigation.spam")}</option>
									<option value="trash">{t("navigation.trash")}</option>
								</RoutingRuleSelect>
							</label>
						</div>
						<div>
							<label className="flex min-h-11 items-center gap-3 text-sm">
								<input type="checkbox" checked={forward} disabled={destination !== "keep"} onChange={event=>setForward(event.target.checked)} />
								{t("rules.forward")}
							</label>
							{forward && <label className="mb-4 grid gap-2 text-sm">
								{t("settings.forwarding.destination")}
								<Input className="min-h-11 text-base" type="email" required maxLength={254} value={forwardTo} onChange={event=>setForwardTo(event.target.value)} placeholder="destination@example.com" />
								<span className="text-xs leading-5 text-neutral-500">{t("rules.forwardHelp")}</span>
							</label>}
						</div>
						<fieldset>
							<legend className="text-sm font-medium">
								{t("smart.labels")}
							</legend>
							<div className="max-h-44 overflow-y-auto">
								{folders.data?.folders.map((folder) => (
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
										<span className="min-w-0 break-words">{getLabelPath(folder, folders.data?.folders ?? [])}</span>
									</label>
								))}
							</div>
							{folders.isError && <p role="alert" className="text-sm text-red-700">{t("smart.failed")}</p>}
							{canManageLabels && <RuleLabelCreator key={mailboxId} mailboxId={mailboxId} folders={folders.data?.folders ?? []} onCreated={id => setLabels(current => [...new Set([...current, id])])} onPendingChange={setLabelCreating} />}
						</fieldset>
						<label className="flex min-h-11 items-center gap-3 text-sm">
							<input
								type="checkbox"
								checked={skip}
								onChange={(event) => setSkip(event.target.checked)}
							/>
							{t("smart.skip")}
						</label>
						<label className="flex min-h-11 items-center gap-3 text-sm">
							<input
								type="checkbox"
								checked={enabled}
								onChange={(event) => setEnabled(event.target.checked)}
							/>
							{t("smart.enabled")}
						</label>
						<label className="grid gap-2 text-sm">
							{t("smart.priority")}
							<Input
								className="min-h-11 text-base"
								type="number"
								min="-1000"
								max="1000"
								value={priority}
								onChange={(event) => setPriority(Number(event.target.value))}
							/>
						</label>
						{sourceMessage && <p className="text-sm text-neutral-500">{t("rules.futureOnly")}</p>}
						</>}
						{save.isError && (
							<p role="alert" className="text-sm text-red-600">
								{save.error.message}
							</p>
						)}
						<div className="flex flex-wrap justify-end gap-2 border-t border-neutral-100 pt-4">
							{sourceMessage && !criteriaStep && <Button type="button" variant="outline" className="min-h-11" onClick={()=>setStep("criteria")}>{t("rules.backToCriteria")}</Button>}
							<Button
								variant="outline"
								type="button"
								onClick={() => changeOpen(false)}
								className="min-h-11"
							>
								{t("common.cancel")}
							</Button>
							<Button
								type="submit"
								className="min-h-11"
								disabled={
									!mailboxId ||
									conditions.some((condition) => !condition.value.trim()) ||
									save.isPending || labelCreating
									|| (!criteriaStep && !!sourceMessage && !labels.length && !category && !skip && !forward && destination === "keep")
								}
							>
								{criteriaStep ? t("rules.chooseActions") : save.isPending ? t("common.saving") : sourceMessage ? t("rules.createFilter") : t("rules.saveChanges")}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</section>
	);
}
