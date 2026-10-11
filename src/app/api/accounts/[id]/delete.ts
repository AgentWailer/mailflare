import { newId } from "@/lib/ids";
import { avatarPreviewKeyFor } from "@/lib/avatar-images";

/** Delete the login identity, retaining mail and file assets under the primary admin. */
export async function deleteManagedAccount(
	env: CloudflareEnv,
	input: { id: string; email: string; actorId: string; successorId: string },
) {
	const { id, email, actorId, successorId } = input;
	const prepare = (sql: string, ...params: (string | number)[]) => env.DB.prepare(sql).bind(...params);
	const avatars = await env.DB.prepare(`SELECT avatar_key FROM users WHERE id = ?
		UNION SELECT avatar_key FROM contacts WHERE user_id = ?`).bind(id, id).all<{ avatar_key: string | null }>();
	const auditId = newId("audit");
	await env.DB.batch([
		// Recheck protection, permissions and recipient inside the atomic batch. A failed
		// guard aborts the whole transaction, including if an admin role changed meanwhile.
		prepare(`SELECT CASE WHEN EXISTS (
			SELECT 1 FROM users target, users actor, users successor
			WHERE target.id = ? AND target.email = ? AND target.is_primary_admin = 0
			AND actor.id = ? AND actor.id <> target.id AND actor.disabled = 0 AND actor.role = 'admin'
			AND (actor.is_primary_admin = 1 OR (actor.can_manage_users = 1 AND target.role = 'user'))
			AND successor.id = ? AND successor.id <> target.id
			AND successor.is_primary_admin = 1 AND successor.role = 'admin' AND successor.disabled = 0
		) THEN 1 ELSE json('account_deletion_conflict') END`, id, email, actorId, successorId),
		// Keep the former profile picture on its personal mailboxes before deleting the profile.
		prepare(`UPDATE mailboxes SET avatar_key = (SELECT avatar_key FROM users WHERE id = ?)
			WHERE user_id = ? AND type = 'personal' AND avatar_key IS NULL`, id, id),
		prepare(`UPDATE mailbox_agent_settings SET auto_draft_enabled = 0, reviewer_user_id = NULL
			WHERE reviewer_user_id = ? OR mailbox_id IN (SELECT id FROM mailboxes WHERE user_id = ?)`, id, id),
		prepare("UPDATE domains SET user_id = ? WHERE user_id = ?", successorId, id),
		prepare("UPDATE mailboxes SET user_id = ? WHERE user_id = ?", successorId, id),
		prepare("UPDATE folders SET user_id = ? WHERE user_id = ?", successorId, id),
		// Cancel scheduled sends while retaining their text and attachments as drafts.
		prepare(`UPDATE messages SET status = 'draft' WHERE id IN
			(SELECT message_id FROM outbound_jobs WHERE user_id = ? AND status = 'queued')`, id),
		prepare("UPDATE messages SET user_id = ? WHERE user_id = ?", successorId, id),
		prepare("UPDATE routing_rules SET user_id = ? WHERE user_id = ?", successorId, id),
		// Completed uploads retain their object keys; old public Drive links are revoked.
		prepare("UPDATE drive_items SET owner_id = ?, link_token = NULL WHERE owner_id = ?", successorId, id),
		prepare(`INSERT INTO audit_logs (id, actor_user_id, action, metadata, created_at)
			VALUES (?, ?, 'account.deleted', ?, ?)`, auditId, actorId,
			JSON.stringify({ accountId: id, email, assetsTransferredTo: successorId }), Math.floor(Date.now() / 1000)),
		// Foreign keys revoke sessions, push subscriptions, reset/MFA tokens, API keys,
		// account shares and private profile data. Mailbox IDs and Cloudflare routes stay valid.
		prepare("DELETE FROM users WHERE id = ?", id),
	]);

	// Only avatars with no surviving reference are removed. Mail and Drive objects are retained.
	const candidates = [...new Set(avatars.results.map((row) => row.avatar_key).filter((key): key is string => !!key))];
	const unused: string[] = [];
	try {
		for (let offset = 0; offset < candidates.length; offset += 500) {
			const keys = candidates.slice(offset, offset + 500);
			const encoded = JSON.stringify(keys);
			const references = await env.DB.prepare(`SELECT avatar_key FROM users WHERE avatar_key IN (SELECT value FROM json_each(?))
				UNION SELECT avatar_key FROM mailboxes WHERE avatar_key IN (SELECT value FROM json_each(?))
				UNION SELECT avatar_key FROM contacts WHERE avatar_key IN (SELECT value FROM json_each(?))`).bind(encoded, encoded, encoded).all<{ avatar_key: string }>();
			const retained = new Set(references.results.map((row) => row.avatar_key));
			for (const key of keys) if (!retained.has(key)) unused.push(key, avatarPreviewKeyFor(key));
		}
		// R2 accepts at most 1,000 object keys in one delete request.
		for (let offset = 0; offset < unused.length; offset += 1000) await env.BUCKET.delete(unused.slice(offset, offset + 1000));
	} catch {
		// The identity is already gone. Record cleanup work rather than reporting a
		// failed deletion that could encourage a second destructive request.
		await env.DB.prepare("UPDATE audit_logs SET metadata = ? WHERE id = ?").bind(
			JSON.stringify({ accountId: id, email, assetsTransferredTo: successorId, pendingAvatarCleanup: unused, avatarCandidates: candidates }), auditId,
		).run().catch(() => console.error("Could not record pending account avatar cleanup", auditId));
		return { cleanupPending: true };
	}
	return { cleanupPending: false };
}
