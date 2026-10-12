import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { readJsonBody } from "@/lib/http/request";
import { getMailboxFolderAccess, listFoldersForMailbox } from "@/app/api/folders/utils";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const inputSchema = z.object({ mailboxId: id, parentId: id.nullable(), order: z.array(id).max(2000), onlyIfAbsent: z.boolean().optional() }).strict();
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
 const env = getEnv(), { user, error } = await requireSessionUser(env, request);
 if (error) return error;
 const mailbox = id.safeParse(new URL(request.url).searchParams.get("mailboxId"));
 if (!mailbox.success) return NextResponse.json({ error: "Mailbox required" }, { status: 400 });
 const db = getDb(env);
 if (!(await getMailboxFolderAccess(db, user, mailbox.data))) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
 const row = await env.DB.prepare("SELECT label_order FROM users WHERE id = ?").bind(user.id).first<{ label_order: string }>();
 let stored: Record<string, Record<string, unknown>> = {};
 try { stored = JSON.parse(row?.label_order ?? "{}"); } catch { /* Recover from malformed preferences. */ }
 const saved = stored && typeof stored === "object" ? stored[mailbox.data] : undefined;
 const known = new Set((await listFoldersForMailbox(db, mailbox.data)).map(label => label.id));
 const orders: Record<string, string[]> = {};
 if (saved && typeof saved === "object" && !Array.isArray(saved)) {
  for (const [group, value] of Object.entries(saved)) {
   if ((group === "root" || known.has(group)) && Array.isArray(value)) orders[group] = [...new Set(value.filter((item): item is string => typeof item === "string" && known.has(item)))];
  }
 }
 return NextResponse.json({ orders }, { headers });
}

/** Personal display preference: readable mailboxes suffice, including read-only shares. */
export async function PATCH(request: Request) {
 const env = getEnv(), { user, error } = await requireSessionUser(env, request);
 if (error) return error;
 if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
 const parsed = inputSchema.safeParse(await readJsonBody(request, 262144).catch(() => null));
 if (!parsed.success || new Set(parsed.data.order).size !== parsed.data.order.length) return NextResponse.json({ error: "Invalid label order" }, { status: 400 });
 const { mailboxId, parentId, order, onlyIfAbsent } = parsed.data, db = getDb(env);
 if (!(await getMailboxFolderAccess(db, user, mailboxId))) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
 const known = new Set((await listFoldersForMailbox(db, mailboxId)).map(label => label.id));
 if (parentId && !known.has(parentId) || order.some(labelId => !known.has(labelId))) return NextResponse.json({ error: "Label not found" }, { status: 404 });
 // Update a single sibling group atomically, preserving concurrent changes to other
 // groups/mailboxes. Legacy-browser adoption must never overwrite another device.
 const path = `$."${mailboxId}"."${parentId ?? "root"}"`;
 const current = "CASE WHEN json_valid(label_order) THEN CASE WHEN json_type(label_order) = 'object' THEN label_order ELSE '{}' END ELSE '{}' END";
 await env.DB.prepare(`UPDATE users SET label_order = json_set(${current}, ?, json(?)) WHERE id = ? AND (? = 0 OR json_type(${current}, ?) IS NULL)`)
  .bind(path, JSON.stringify(order), user.id, onlyIfAbsent ? 1 : 0, path).run();
 return NextResponse.json({ ok: true }, { headers });
}
