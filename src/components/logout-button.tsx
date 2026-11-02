"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { logoutClientSession } from "@/lib/auth/logout";

export function LogoutButton() {
	const { t } = useLanguage();
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);
	return (
		<div>
			<Button
				variant="outline"
				className="w-full"
				disabled={pending}
				onClick={async () => {
					setPending(true);
					setFailed(false);
					try {
						const switched = await logoutClientSession();
						router.replace(switched ? "/inbox" : "/login");
						router.refresh();
					} catch { setFailed(true); }
					finally { setPending(false); }
				}}
			>
				{t("auth.logout")}
			</Button>
			{failed && <p role="alert" className="mt-2 text-sm text-red-600">{t("auth.logoutFailed")}</p>}
		</div>
	);
}
