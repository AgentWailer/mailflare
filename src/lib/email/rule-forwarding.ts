import { safeErrorCategory } from "@/lib/security/logging";
import { and, desc, asc, eq } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db";
import { domains, routingRules } from "@/db/schema";
import { cfRequest } from "@/lib/cloudflare-api";
import { getEmailAddress } from "./address";
import { MAILFLARE_FORWARDED_HEADER } from "./account-forwarding";
import { buildSnippet, parseRawMime } from "./parse";
import { matchesRule, recordRuleMatch, resolveInboundAddress } from "./routing";

export class RuleForwardingError extends Error {
	constructor(public readonly code: "forwarding_unverified" | "forwarding_unavailable" | "forwarding_loop") {
		super(code);
	}
}

/** Validate without sending verification mail or exposing other account destinations. */
export async function validateRuleForwardingTarget(env: CloudflareEnv, db: AppDatabase, mailbox: {id: string; domainId: string}, target: string) {
	if ((await resolveInboundAddress(db, target))?.mailbox?.mailboxId === mailbox.id) throw new RuleForwardingError("forwarding_loop");
	const [domain] = await db.select({zoneId: domains.zoneId}).from(domains).where(eq(domains.id, mailbox.domainId)).limit(1);
	try {
		if (!domain || domain.zoneId === "manual") throw new Error("Cloudflare routing is unavailable");
		const zone = await cfRequest<{account: {id: string}}>(env, `/zones/${domain.zoneId}`);
		if (!zone.account?.id) throw new Error("Cloudflare account is unavailable");
		for (let page = 1; page <= 10; page++) {
			const addresses = await cfRequest<{email: string; verified: string | null}[]>(env, `/accounts/${zone.account.id}/email/routing/addresses?per_page=100&page=${page}`);
			const address = addresses.find(row => row.email.toLowerCase() === target.toLowerCase());
			if (address?.verified) return;
			if (address || addresses.length < 100) throw new RuleForwardingError("forwarding_unverified");
		}
	} catch (error) {
		if (error instanceof RuleForwardingError) throw error;
		throw new RuleForwardingError("forwarding_unavailable");
	}
	throw new RuleForwardingError("forwarding_unavailable");
}

/** The live intake can forward the original MIME; the queue always keeps the local copy. */
export async function forwardMatchingMailboxRules(
	env: CloudflareEnv,
	input: {mailboxId: string; from: string; to: string; raw: ArrayBuffer; headers: Record<string, string>},
	forward: (destination: string, headers: Record<string, string>) => Promise<boolean>,
): Promise<string[]> {
	if (Object.entries(input.headers).some(([key,value]) => key.toLowerCase() === MAILFLARE_FORWARDED_HEADER.toLowerCase() && value === "1")) return [];
	try {
		const db = getDb(env);
		const rules = await db.select().from(routingRules).where(and(
			eq(routingRules.scope, "mailbox"),
			eq(routingRules.mailboxId, input.mailboxId),
			eq(routingRules.enabled, true),
			eq(routingRules.action, "forward"),
		)).orderBy(desc(routingRules.priority), asc(routingRules.createdAt));
		if (!rules.length) return [];
		const parsed = await parseRawMime(input.raw);
		const match = {
			toAddress: input.to,
			fromAddress: parsed.fromAddr ?? input.from,
			subject: parsed.subject,
			content: [parsed.text, parsed.html, buildSnippet(parsed.text, parsed.html)].filter(Boolean).join(" "),
		};
		for (const rule of rules) {
			const target = rule.forwardTo?.trim();
			if (!target || getEmailAddress(target).toLowerCase() === getEmailAddress(input.to).toLowerCase() || !matchesRule(rule, match)) continue;
			try {
				if (await forward(target, { [MAILFLARE_FORWARDED_HEADER]: "1" })) {
					// A statistics failure must not trigger a second forwarding target.
					try { await recordRuleMatch(db, rule.id); }
					catch (error) { console.error("Mailbox forwarding statistics failed", { ruleId: rule.id, error: safeErrorCategory(error) }); }
					return [target.toLowerCase()];
				}
			} catch (error) {
				console.error("Mailbox rule forwarding failed", { ruleId: rule.id, error: safeErrorCategory(error) });
			}
			// The highest-priority matching rule wins; failures still keep the local copy.
			return [];
		}
		return [];
	} catch (error) {
		console.error("Mailbox rule forwarding unavailable; keeping original message", safeErrorCategory(error));
		return [];
	}
}
