import type { SettingsNavSection } from "./settings-nav-types";

export const settingsNavSections: SettingsNavSection[] = [
	{
		labelKey: "settings.guide.personal",
		items: [
			{ href: "/settings/account", labelKey: "settings.nav.account" },
			{ href: "/settings/security", labelKey: "settings.nav.security" },
		],
	},
	{
		labelKey: "settings.guide.mail",
		items: [
			{ href: "/settings/inbox", labelKey: "settings.nav.inbox" },
			{ href: "/settings/rules", labelKey: "settings.nav.rules" },
		],
	},
	{
		labelKey: "settings.guide.connections",
		items: [
			{ href: "/settings/api-keys", labelKey: "settings.nav.apiKeys" },
			{ href: "/settings/app-passwords", labelKey: "settings.nav.appPasswords" },
		],
	},
	{
		labelKey: "settings.guide.data",
		items: [
			{ href: "/settings/import", labelKey: "settings.nav.import" },
			{ href: "/settings/export", labelKey: "settings.nav.export" },
		],
	},
];

export function isActiveSettingsPath(pathname: string, href: string): boolean {
	return pathname === href || pathname.startsWith(`${href}/`);
}
