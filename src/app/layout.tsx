import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { ForkSource } from "@/components/fork-source";
import { Providers } from "@/components/providers";
import { LanguageProvider } from "@/components/language-provider";
import { DEFAULT_LOCALE, getDirection } from "@/lib/i18n/utils";
import { getRequestLocale, loadServerMessages } from "@/lib/i18n/server";
import { sidebarBootstrapScript } from "@/components/sidebar-state-utils";
import { themeBootstrapScript } from "@/components/theme-utils";
import "./globals.css";

export const metadata: Metadata = {
	title: "Mailflare",
	description: "Multi-tenant email on Cloudflare",
	icons: { icon: "/api/branding/icon", apple: "/icon-192.png" },
	appleWebApp: {
		capable: true,
		title: "Mailflare",
	},
	robots: {
		index: false,
		follow: false,
		noarchive: true,
		nosnippet: true,
		noimageindex: true,
		googleBot: {
			index: false,
			follow: false,
			noarchive: true,
			nosnippet: true,
			noimageindex: true,
		},
	},
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	interactiveWidget: "resizes-content",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
	const locale = await getRequestLocale();
	const messages = locale === DEFAULT_LOCALE ? undefined : await loadServerMessages(locale);
	const dark = (await cookies()).get("mailflare-theme-color")?.value === "dark";
	return (
		<html lang={locale} dir={getDirection(locale)} className={dark ? "dark" : "light"} style={{ colorScheme: dark ? "dark" : "light", backgroundColor: dark ? "#202124" : "#f6f8fc" }} suppressHydrationWarning>
			<head>
				{/* WebKit must send the Access cookie when fetching installation metadata. */}
				<link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
				{/* Vinext emits the modern mobile-web-app-capable name; retain Apple's explicit opt-in. */}
				<meta name="apple-mobile-web-app-capable" content="yes" />
				{/* Render chrome metadata before the bootstrap to avoid a second late-streamed status tag. */}
				<meta name="apple-mobile-web-app-status-bar-style" content={dark ? "black" : "default"} suppressHydrationWarning />
				<meta name="theme-color" content={dark ? "#202124" : "#f6f8fc"} suppressHydrationWarning />
				<script dangerouslySetInnerHTML={{ __html: sidebarBootstrapScript }} />
				<script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
				<link rel="icon" href="/api/branding/icon"></link>
			</head>
			<body className="antialiased">
				<LanguageProvider initialLocale={locale} initialMessages={messages}><Providers>{children}</Providers><ForkSource /></LanguageProvider>
			</body>
		</html>
	);
}
