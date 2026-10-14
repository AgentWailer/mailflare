import type { Metadata } from "next";
import { getHomeBranding } from "./home-server-utils";
import LoginPage from "./(auth)/login/page";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
	const branding = await getHomeBranding();
	return {
		title: branding.appName,
		icons: { icon: branding.hasCustomIcon ? "/api/branding/icon" : "/icon-96.png" },
	};
}

export default function HomePage() {
	// The entry point uses the same session checks and login flow as /login.
	// Adding another account remains an explicit /login?add=1 action.
	return LoginPage({ searchParams: Promise.resolve({}) });
}
