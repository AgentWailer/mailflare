import type { MailCategory } from "./categories";
import { getEmailAddress } from "@/lib/email/address";

export const LEARNING_EXAMPLE_LIMIT = 6;

/** Only explicit category corrections from this mailbox become examples; archiving is not feedback. */
export async function getSortingExamples(env: Pick<CloudflareEnv, "DB">, mailboxId: string) {
	const rows = await env.DB.prepare(`SELECT sender AS from_addr, subject, category FROM mail_sorting_feedback
		WHERE mailbox_id = ? ORDER BY corrected_at DESC, id DESC LIMIT 30`)
		.bind(mailboxId).all<{ from_addr: string; subject: string | null; category: MailCategory }>();
	const seen = new Set<string>();
	return rows.results.filter((row) => {
		const key = `${getEmailAddress(row.from_addr).toLowerCase()}\n${row.subject?.toLowerCase()}\n${row.category}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	}).slice(0, LEARNING_EXAMPLE_LIMIT).map((row) => ({
		sender: getEmailAddress(row.from_addr).toLowerCase().slice(0, 200),
		subject: row.subject?.slice(0, 200) ?? "",
		category: row.category,
	}));
}

export function createCategoryCorrection(category: MailCategory, previousDecision: string | null, actorUserId: string) {
	let previous: Record<string, unknown> | null = null;
	try {
		const value = JSON.parse(previousDecision ?? "null");
		if (value && typeof value === "object" && !Array.isArray(value)) previous = value;
	} catch { /* Old records may not contain a decision. */ }
	return {
		category,
		source: "manual",
		reason: "user_correction",
		learning: true,
		correctedAt: new Date().toISOString(),
		actorUserId,
		// Keep the original machine decision across repeated manual corrections.
		previousDecision: previous?.source === "manual" ? previous.previousDecision ?? null : previous,
	};
}
