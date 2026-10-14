import { and, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { messageAttachments, messages } from "@/db/schema";

/** Page-only metadata: never load attachment objects or message bodies for list icons. */
export async function getListAttachmentCounts(db: AppDatabase, rows: Array<{id:string;threadId:string|null}>, grouped: boolean, scope: SQL | undefined) {
 const key = grouped ? sql<string>`coalesce(${messages.threadId}, ${messages.id})` : sql<string>`${messages.id}`;
 const keys = [...new Set(rows.map(row => grouped ? row.threadId ?? row.id : row.id))];
 const counts = new Map<string, number>();
 // Leave room for mailbox, search and folder filter parameters in D1's binding limit.
 for(let offset=0;offset<keys.length;offset+=60) {
  const result = await db.select({key,total:count()}).from(messages)
   .innerJoin(messageAttachments,eq(messageAttachments.messageId,messages.id))
   .where(and(scope,inArray(key,keys.slice(offset,offset+60)),eq(messageAttachments.disposition,"attachment"),isNull(messageAttachments.trashedAt)))
   .groupBy(key);
  for(const row of result)counts.set(row.key,Number(row.total));
 }
 return counts;
}
