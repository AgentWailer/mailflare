import type { SessionUser } from "@/lib/auth/types";

/** Listing and mutations must use the same registry for delegated administrators. */
export function getDomainRegistryOwnerId(user: Pick<SessionUser, "id" | "canManageMailboxes" | "createdByUserId">): string {
	return user.canManageMailboxes && user.createdByUserId ? user.createdByUserId : user.id;
}
