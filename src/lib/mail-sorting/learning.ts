import type { MailCategory } from "./categories";
import { getEmailAddress } from "@/lib/email/address";
import { isMailCategory } from "./categories";

export const LEARNING_EXAMPLE_LIMIT = 6;

/** Only explicit category corrections from this mailbox become examples; archiving is not feedback. */
export async function getSortingExamples(env: Pick<CloudflareEnv, "DB">, mailboxId: string, context?: { sender: string; subject?: string | null }) {
	const rows = await env.DB.prepare(`SELECT sender AS from_addr, subject, category FROM mail_sorting_feedback
		WHERE mailbox_id = ? ORDER BY corrected_at DESC, id DESC LIMIT 90`)
		.bind(mailboxId).all<{ from_addr: string; subject: string | null; category: MailCategory }>();
	const sender = context ? getEmailAddress(context.sender).trim().toLowerCase() : "";
	// Retrieve older corrections from this exact sender too; bulk imports must not crowd them out.
	const sameSender = sender ? (await env.DB.prepare(`SELECT sender AS from_addr, subject, category FROM mail_sorting_feedback
		WHERE mailbox_id=? AND sender=? ORDER BY corrected_at DESC, id DESC LIMIT 30`).bind(mailboxId, sender)
		.all<{ from_addr: string; subject: string | null; category: MailCategory }>()).results : [];
	const tokens = (subject: string | null | undefined) => new Set((subject?.normalize("NFKC").toLowerCase().match(/[\p{L}]{4,}/gu) ?? []).filter(word => !["ihre", "deine", "your", "this", "from", "eine"].includes(word)));
	const wanted = tokens(context?.subject);
	const seen = new Set<string>();
	const examples = [...sameSender, ...rows.results].filter((row) => {
		if (!isMailCategory(row.category)) return false;
		const key = `${getEmailAddress(row.from_addr).toLowerCase()}\n${row.subject?.toLowerCase()}\n${row.category}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const score = (row: typeof examples[number]) => {
		const words = tokens(row.subject);
		const overlap = [...wanted].filter(word => words.has(word)).length;
		return (getEmailAddress(row.from_addr).toLowerCase() === sender ? 4 : 0) + (overlap ? 8 * overlap / Math.max(wanted.size, words.size) : 0);
	};
	examples.sort((a, b) => score(b) - score(a));
	// Relevant examples first, then diverse categories rather than six copies of one newsletter.
	const selected = examples.filter(row => score(row) > 0).slice(0, LEARNING_EXAMPLE_LIMIT);
	for (const row of examples) {
		if (selected.length >= LEARNING_EXAMPLE_LIMIT) break;
		if (!selected.includes(row) && !selected.some(other => other.category === row.category)) selected.push(row);
	}
	for (const row of examples) {
		if (selected.length >= LEARNING_EXAMPLE_LIMIT) break;
		if (!selected.includes(row)) selected.push(row);
	}
	return selected.map((row) => ({
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
