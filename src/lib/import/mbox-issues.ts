import type { SessionUser } from "@/lib/auth/types";
import { getOwnedMboxJob } from "./mbox-jobs";

export type MboxImportIssue = {
 id: string; byte_offset: number; next_offset: number; message_size: number;
 reason: "oversized" | "invalid_message" | "explicit_skip"; error: string; status: "pending" | "dismissed"; created_at: number; reviewed_at: number | null;
};
export async function listMboxIssues(env: CloudflareEnv, user: SessionUser, jobId: string, after = -1) {
 await getOwnedMboxJob(env, user, jobId);
 const rows = await env.DB.prepare("SELECT id,byte_offset,next_offset,message_size,reason,error,status,created_at,reviewed_at FROM mbox_import_issues WHERE import_job_id=? AND byte_offset>? ORDER BY byte_offset LIMIT 21").bind(jobId, after).all<MboxImportIssue>();
 return { issues: rows.results.slice(0, 20), next: rows.results.length > 20 ? rows.results[19].byte_offset : null };
}
export async function reviewMboxIssue(env: CloudflareEnv, user: SessionUser, jobId: string, issueId: string) {
 await getOwnedMboxJob(env, user, jobId);
 const row = await env.DB.prepare("UPDATE mbox_import_issues SET status='dismissed',reviewed_at=? WHERE id=? AND import_job_id=? RETURNING id").bind(Date.now(), issueId, jobId).first();
 if (!row) throw new Error("Import issue not found");
}
/** Stream the exact single-message MBOX range, even for very large messages. */
export async function downloadMboxIssue(env: CloudflareEnv, user: SessionUser, jobId: string, issueId: string) {
 const job = await getOwnedMboxJob(env, user, jobId);
 const issue = await env.DB.prepare("SELECT byte_offset,next_offset FROM mbox_import_issues WHERE id=? AND import_job_id=?").bind(issueId, jobId).first<Pick<MboxImportIssue, "byte_offset" | "next_offset">>();
 if (!issue || issue.byte_offset < 0 || issue.next_offset <= issue.byte_offset || issue.next_offset > job.object_size) throw new Error("Import issue not found or invalid source range");
 const object = await env.BUCKET.get(job.object_key, { range: { offset: issue.byte_offset, length: issue.next_offset - issue.byte_offset }, onlyIf: { etagMatches: job.object_etag } });
 if (!object || !("body" in object) || object.etag !== job.object_etag || object.size !== job.object_size) throw new Error("Original archive is unavailable or changed; restore it before downloading");
 return new Response(object.body, { headers: {
  "Content-Type": "application/mbox", "Content-Disposition": `attachment; filename="message-${issue.byte_offset}.mbox"`,
  "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
 } });
}
