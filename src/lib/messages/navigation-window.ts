import { sql, type SQL } from "drizzle-orm";
import { messages } from "@/db/schema";
import type { getDb } from "@/db";
import type { MessageNavigationWindow } from "@/app/api/messages/navigation/types";

/** Return one position and two neighbours, never the archive as a JS array. */
export async function loadNavigationWindow(db: ReturnType<typeof getDb>, where: SQL, messageId: string, grouped: boolean): Promise<MessageNavigationWindow> {
	const key = sql`coalesce(${messages.threadId}, ${messages.id})`;
	const matched = sql`select ${messages.id} as id, ${messages.createdAt} as created_at, ${key} as thread_key from ${messages} where ${where}`;
	const heads = grouped ? sql`
		select id, created_at, thread_key from (
			select *, row_number() over (partition by thread_key order by created_at desc, id desc) as member_position
			from matched
		) where member_position = 1
	` : sql`select * from matched`;
	const targetCondition = grouped ? sql`thread_key = (select thread_key from matched where id = ${messageId})` : sql`id = ${messageId}`;
	const [row] = await db.all<MessageNavigationWindow>(sql`
		with matched as (${matched}), heads as materialized (${heads}), target as (select * from heads where ${targetCondition} limit 1)
		select
		(select h.id from heads h, target t where h.created_at > t.created_at or (h.created_at = t.created_at and h.id > t.id) order by h.created_at, h.id limit 1) as previousId,
		(select h.id from heads h, target t where h.created_at < t.created_at or (h.created_at = t.created_at and h.id < t.id) order by h.created_at desc, h.id desc limit 1) as nextId,
		coalesce(sum(case when h.created_at > t.created_at or (h.created_at = t.created_at and h.id > t.id) then 1 else 0 end), 0) + 1 as position,
		count(*) as total
		from heads h, target t having count(*) > 0
	`);
	return row ?? { previousId: null, nextId: null, position: 0, total: 0 };
}
