import { htmlToReadableText } from "@/lib/email/reply-content-utils";
import { isAccountSecurityNotice, isConsequentialNotice, resolveTransactionMail, resolveRoutineMail } from "./routine";
import type { SortingDecision } from "./categories";
import { cleanSnippetText } from "@/lib/email/snippet";

export const CONTENT_POLICY_VERSION = 6;
export type ReviewMessage = {
 id: string; row_id: number; from_addr: string; to_addr: string; subject: string | null;
 category: string; sorting_decision: string | null; text_body: string | null; html_body: string | null;
 snippet: string | null; spam_score: number | null; in_reply_to: string | null;
};

/** Analyze bounded visible content, never instructions in the email or attachment bytes. */
export function reviewText(message: Pick<ReviewMessage, "text_body" | "html_body" | "snippet">) {
 const plain = message.text_body?.trim() ?? "";
 // A bounded HTML prefix may end inside a stylesheet. Strip incomplete non-content
 // blocks too, so CSS, template markup and invisible padding never become examples.
 const source = (message.html_body ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
  .replace(/<(style|script|head)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, " ");
 const html = htmlToReadableText(source).trim();
 const fallbackOnly = /does not support.{0,20}html|html.{0,20}(?:nicht|not) support|unterstützt.{0,30}keine html|email client supporting html/i.test(plain);
 return cleanSnippetText(plain.length >= 80 && !fallbackOnly ? plain : html || plain || message.snippet || "").slice(0, 6000);
}
export function savedDecision(message: Pick<ReviewMessage, "sorting_decision">): Record<string, unknown> {
 try { const value: unknown = JSON.parse(message.sorting_decision ?? "null"); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
 catch { return {}; }
}
/** Explicit user decisions and saved mailbox rules are evidence to review, never overwrite. */
export function isExplicitDecision(message: Pick<ReviewMessage, "sorting_decision">) {
 const previous = savedDecision(message);
 return ["manual", "reviewed", "override"].includes(String(previous.source)) || !!previous.ruleId ||
  previous.reason === "existing_mail_filter" || previous.reason === "mailbox_rule";
}
export function deterministicReview(message: ReviewMessage): SortingDecision | null {
 if ((message.spam_score ?? 0) >= 40) return null;
 const headers: Record<string, string> = message.in_reply_to ? { "in-reply-to": message.in_reply_to } : {};
 const input = { sender: message.from_addr, subject: message.subject, text: reviewText(message),
  headers };
 if (isConsequentialNotice(input)) return { category: "primary", source: "rule", reason: "protected_legal_or_payment_demand" };
 if (isAccountSecurityNotice(input)) return { category: "primary", source: "rule", reason: "protected_account_security" };
 // A reply may mention an invoice from quoted history; protect the conversation.
 if (/^(?:re|aw)\s*:/i.test(message.subject?.trim() ?? "") || message.in_reply_to)
  return message.category === "primary" ? { category: "primary", source: "rule", reason: "protected_conversation" } : null;
 if (/^(?:fw|fwd|wg)\s*:/i.test(message.subject?.trim() ?? "")) return null;
 return resolveTransactionMail(input) ?? resolveRoutineMail(input);
}
export function shouldAuditWithAi(message: ReviewMessage) {
 if (!["primary", "invoices", "orders"].includes(message.category) || isExplicitDecision(message)) return false;
 const previous = savedDecision(message);
 // Evaluable primary decisions from this policy are already known; fallback remains reviewable.
 return !(Number(previous.policyVersion) >= CONTENT_POLICY_VERSION && previous.source !== "fallback");
}
