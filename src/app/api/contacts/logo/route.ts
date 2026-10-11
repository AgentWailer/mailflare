import { and, eq } from "drizzle-orm";
import { getEnv } from "@/lib/cloudflare";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { normalizeEmailAddress } from "@/lib/email/address";
import { senderLogoDomain } from "@/lib/contacts/sender-logos";
import { getCachedSenderLogo } from "@/lib/contacts/logo-cache";

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	const params = new URL(request.url).searchParams;
	const email = normalizeEmailAddress(params.get("address") ?? "");
	const domain = senderLogoDomain(email);
	const mailboxId = params.get("mailboxId");
	const missing = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
	if (!domain || !mailboxId) return missing();
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, auth.user, mailboxId);
	if (!access?.canRead) return missing();
	const [contact] = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.userId, access.mailbox.userId), eq(contacts.email, email))).limit(1);
	if (!contact) return missing();
	try {
		const image = await getCachedSenderLogo(env.BUCKET, access.mailbox.userId, domain);
		if (!image) return missing();
		return new Response(image, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
	} catch {
		return new Response("Unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
	}
}
