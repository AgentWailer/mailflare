import { defaultTranslator, type Translator } from "@/lib/i18n/utils";
import { authFetch } from "@/lib/auth/client";
import type { InboxRule, InboxRuleInput, InboxRulesResponse, RuleFoldersResponse } from "./inbox-rules-types";

function ruleError(error: unknown, t: Translator): string {
	if (error === "forwarding_unverified") return t("rules.forwardUnverified");
	if (error === "forwarding_unavailable") return t("rules.forwardUnavailable");
	if (error === "forwarding_loop") return t("rules.forwardLoop");
	if (error === "forwarding_status_conflict") return t("rules.forwardConflict");
	return typeof error === "string" ? error : t("smart.failed");
}

export async function fetchInboxRules(mailboxId: string): Promise<InboxRulesResponse> {
	const params = new URLSearchParams({ mailboxId });
	const response = await authFetch(`/api/routing-rules?${params.toString()}`);
	return (await response.json()) as InboxRulesResponse;
}

export async function fetchRuleFolders(mailboxId: string): Promise<RuleFoldersResponse> {
	const params = new URLSearchParams({ mailboxId });
	const response = await authFetch(`/api/folders?${params.toString()}`);
	return (await response.json()) as RuleFoldersResponse;
}

export async function createInboxRule(input: InboxRuleInput, t: Translator = defaultTranslator) {
	const response = await authFetch("/api/routing-rules", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(ruleError(data.error, t));
	return data;
}

export async function updateInboxRule(ruleId: string, input: InboxRuleInput, t: Translator = defaultTranslator) {
	const response = await authFetch(`/api/routing-rules/${ruleId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(ruleError(data.error, t));
	return data;
}

export async function deleteInboxRule(ruleId: string) {
	const response = await authFetch(`/api/routing-rules/${ruleId}`, {
		method: "DELETE",
	});
	if (!response.ok) throw new Error("Failed to delete rule");
}

export function getRuleFieldLabel(field: string, t: Translator = defaultTranslator): string {
	if (field === "content") return t("rules.field.content");
	if (field === "title") return t("rules.field.title");
	return t("rules.field.email");
}

export function getRuleOperatorLabel(operator: string, t: Translator = defaultTranslator): string {
	return operator === "exact" ? t("rules.operator.exact") : t("rules.operator.contains");
}

export function getInboxRuleDestination(rule: Pick<InboxRule, "action" | "folderId">): string {
	if (rule.action === "spam" || rule.action === "trash") return rule.action;
	return rule.folderId ? `folder:${rule.folderId}` : "";
}
