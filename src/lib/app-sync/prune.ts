const KEEP_DAYS = 45;

/**
 * Drop sync log entries older than 45 days. A device that was away longer finds its cursor
 * below the log and is told to sync from scratch.
 */
export async function pruneMailChanges(env: CloudflareEnv, now: Date): Promise<number> {
	const before = Math.floor(now.getTime() / 1000) - KEEP_DAYS * 86_400;
	try {
		const result = await env.DB.prepare("DELETE FROM mail_changes WHERE changed_at < ?").bind(before).run();
		return result.meta.changes ?? 0;
	} catch (error) {
		// The code can be live before migration 0085 is applied; then there is nothing to prune yet.
		if (error instanceof Error && /no such table/i.test(error.message)) return 0;
		throw error;
	}
}
