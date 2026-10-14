import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { readJsonBody } from "@/lib/http/request";
import { MAIL_CATEGORIES } from "@/lib/mail-sorting/categories";
import { controlContentAudit, latestContentAudit, publicContentAudit, reviewAuditIssue, startContentAudit } from "@/lib/mail-sorting/audit-jobs";
import { simplifyLabelStructure } from "@/lib/mail-sorting/label-structure";

const headers = { "Cache-Control": "private, no-store" };
const inputSchema = z.discriminatedUnion("action", [
 z.object({ action: z.enum(["start", "pause", "resume", "structure"]), mailboxId: z.string().min(1).max(128) }).strict(),
 z.object({ action: z.literal("review"), mailboxId: z.string().min(1).max(128), issueId: z.string().min(1).max(128), category: z.enum(MAIL_CATEGORIES).nullable() }).strict(),
]);
export async function GET(request: Request) {
 const env = getEnv(), auth = await requireSessionUser(env, request); if (auth.error) return auth.error;
 const query = new URL(request.url).searchParams, mailboxId = query.get("mailboxId");
 if (!mailboxId || !(await getMailboxAccessLevel(getDb(env), auth.user, mailboxId))?.canManage) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
 const job = await latestContentAudit(env, mailboxId);
 const after = Number(query.get("after") ?? 0);
 if (!Number.isSafeInteger(after) || after < 0) return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
 const issues = (await env.DB.prepare(`SELECT i.rowid cursor,i.id,i.message_id messageId,i.category,i.suggested_category suggestedCategory,i.reason,m.subject,m.from_addr sender,substr(m.snippet,1,200) snippet FROM mail_content_audit_issues i JOIN mail_content_audit_jobs j ON j.id=i.job_id JOIN messages m ON m.id=i.message_id AND m.mailbox_id=j.mailbox_id WHERE j.mailbox_id=? AND i.status='pending' AND i.rowid>? AND m.status IN ('received','archived') AND m.category=i.category AND m.sorting_decision IS i.expected_decision ORDER BY i.rowid LIMIT 21`).bind(mailboxId, after).all()).results;
 return NextResponse.json({ job: job ? publicContentAudit(job) : null, issues: issues.slice(0, 20), next: issues.length > 20 ? (issues[19] as { cursor: number }).cursor : null }, { headers });
}
export async function POST(request: Request) {
 const env = getEnv(), auth = await requireSessionUser(env, request); if (auth.error) return auth.error;
 if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
 const parsed = inputSchema.safeParse(await readJsonBody(request, 2048).catch(() => null));
 if (!parsed.success) return NextResponse.json({ error: "Invalid audit action" }, { status: 400 });
 const input = parsed.data;
 if (!(await getMailboxAccessLevel(getDb(env), auth.user, input.mailboxId))?.canManage) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
 try {
  if (input.action === "structure") return NextResponse.json(await simplifyLabelStructure(env, auth.user, input.mailboxId), { headers });
  if (input.action === "review") {
   const result = await reviewAuditIssue(env, auth.user, input.mailboxId, input.issueId, input.category);
   return result === "ok" ? NextResponse.json({ ok: true }, { headers }) : NextResponse.json({ error: result === "stale" ? "Message changed; reload the review" : "Review not found" }, { status: result === "stale" ? 409 : 404 });
  }
  const job = input.action === "start" ? await startContentAudit(env, auth.user, input.mailboxId) : await controlContentAudit(env, auth.user, input.mailboxId, input.action);
  return NextResponse.json({ job }, { status: input.action === "start" ? 202 : 200, headers });
 } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to start content audit" }, { status: 400 }); }
}
