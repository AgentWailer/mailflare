import { getServerTranslator } from "@/lib/i18n/server";
import { FORK_SOURCE_URL } from "@/lib/fork";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function LicensesPage() {
	const t = await getServerTranslator();
	return (
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader>
				<CardTitle>{t("fork.unlocked")}</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4 text-sm text-neutral-600">
				<p>{t("fork.features")}</p>
				<p>{t("fork.permissions")}</p>
				<p>{t("fork.updateManual")}</p>
				<a href={FORK_SOURCE_URL} target="_blank" rel="noreferrer" className="font-medium text-blue-700 underline">{t("fork.source")}</a>
			</CardContent>
		</Card>
	);
}
