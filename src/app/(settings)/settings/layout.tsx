import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
	return (
		<div className="flex flex-col justify-start gap-4 min-h-[calc(100dvh-4rem)] bg-inherit md:flex-row md:justify-start">
			<SettingsNav />
			<div className="min-w-0 flex-1 px-4 pt-4 pb-24 sm:px-6 max-md:pb-[calc(6rem+env(safe-area-inset-bottom,0px))]">
				<div className="mx-auto w-full max-w-3xl">{children}</div>
			</div>
		</div>
	);
}
