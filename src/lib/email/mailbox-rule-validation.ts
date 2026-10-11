import { and, eq } from "drizzle-orm";
import { messages } from "@/db/schema";
import type { AppDatabase } from "@/db";

export async function hasRuleSourceMessage(db: AppDatabase, mailboxId: string, messageId?: string) {
	if (!messageId) return true;
	const [message] = await db.select({id:messages.id}).from(messages).where(and(eq(messages.id,messageId),eq(messages.mailboxId,mailboxId),eq(messages.direction,"inbound"))).limit(1);
	return !!message;
}
