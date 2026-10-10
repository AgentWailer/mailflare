import type { LicenseEntitlements } from "./types";

/** All bundled features are available in the AgentWailer AGPL fork. */
export const SELF_HOSTED_ENTITLEMENTS: Readonly<LicenseEntitlements> = {
	plan: "team",
	canCustomizeBranding: true,
	canManageAccounts: true,
	canShareMailboxes: true,
	accountSeatLimit: null,
	canForwardEmail: true,
};
