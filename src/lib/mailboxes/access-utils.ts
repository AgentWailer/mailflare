import type { AppDatabase } from "@/db";
import { SELF_HOSTED_ENTITLEMENTS } from "@/lib/licenses/features";

export async function isTeamMailboxSharingEnabled(db: AppDatabase): Promise<boolean> {
	void db; // Sharing still checks per-user mailbox_access grants in access.ts.
	return SELF_HOSTED_ENTITLEMENTS.canShareMailboxes;
}
