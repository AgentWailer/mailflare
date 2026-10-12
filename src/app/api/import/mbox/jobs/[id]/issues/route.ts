import { z } from "zod";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { downloadMboxIssue, listMboxIssues, reviewMboxIssue } from "@/lib/import/mbox-issues";
import { readJsonBody } from "@/lib/http/request";

const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
 const env = getEnv(), auth = await requireSessionUser(env, request);
 if (auth.error) return auth.error;
 if (auth.user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403, headers });
 try {
  const query = new URL(request.url).searchParams, id = (await context.params).id;
  const issueId = query.get("download");
  if (issueId) return await downloadMboxIssue(env, auth.user, id, z.string().min(1).max(200).parse(issueId));
  const after = z.coerce.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).parse(query.get("after") ?? -1);
  return Response.json(await listMboxIssues(env, auth.user, id, after), { headers });
 } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to load import issues" }, { status: 400, headers }); }
}
export async function POST(request: Request, context: Context) {
 const env = getEnv(), auth = await requireSessionUser(env, request);
 if (auth.error) return auth.error;
 if (auth.user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403, headers });
 if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403, headers });
 try {
  const input = z.object({ issueId: z.string().min(1).max(200), action: z.literal("dismiss") }).strict().parse(await readJsonBody(request, 1024));
  await reviewMboxIssue(env, auth.user, (await context.params).id, input.issueId);
  return Response.json({ ok: true }, { headers });
 } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to review import issue" }, { status: 400, headers }); }
}
