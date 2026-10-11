"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { Trash2 } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteManagedAccount } from "@/app/(admin)/accounts/[id]/utils";

export function DeleteAccountDialog({ accountId, email }: { accountId: string; email: string }) {
	const { t } = useLanguage();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [confirmation, setConfirmation] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	function changeOpen(next: boolean) {
		if (pending) return;
		setOpen(next);
		setConfirmation("");
		setError(null);
	}
	async function remove(event: React.FormEvent) {
		event.preventDefault();
		if (pending || confirmation.trim().toLowerCase() !== email.toLowerCase()) return;
		setPending(true);
		setError(null);
		try {
			const result = await deleteManagedAccount(accountId, confirmation);
			setOpen(false);
			if (result.cleanupPending) toast(t("account.delete.cleanupPending"));
			else toast.success(t("account.delete.done"));
			router.push("/accounts");
			router.refresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("account.delete.failed"));
		} finally {
			setPending(false);
		}
	}
	return <>
		<section className="space-y-3 rounded-3xl border border-red-200 bg-white p-4 md:p-6">
			<h2 className="text-lg font-semibold text-neutral-900">{t("account.delete.title")}</h2>
			<p className="text-sm text-neutral-500">{t("account.delete.summary")}</p>
			<Button variant="destructive" className="min-h-11" onClick={() => changeOpen(true)}><Trash2 className="h-4 w-4" />{t("account.delete.button")}</Button>
		</section>
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogContent onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }} onPointerDownOutside={(event) => { if (pending) event.preventDefault(); }}>
				<DialogHeader>
					<DialogTitle>{t("account.delete.confirmTitle")}</DialogTitle>
					<DialogDescription className="break-all">{t("account.delete.for", { email })}</DialogDescription>
				</DialogHeader>
				<form className="space-y-4" onSubmit={(event) => void remove(event)}>
					<p className="text-sm text-neutral-700">{t("account.delete.keepAssets")}</p>
					<p className="text-sm text-neutral-700">{t("account.delete.removePrivateData")}</p>
					<p className="text-sm text-neutral-700">{t("account.delete.revokeAccess")}</p>
					<div className="space-y-2">
						<Label htmlFor="delete-account-email">{t("account.delete.confirmEmail")}</Label>
						<Input id="delete-account-email" type="email" autoComplete="off" autoCapitalize="none" spellCheck={false} className="min-h-11 text-base" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={pending} required />
					</div>
					{error && <p role="alert" className="text-sm text-red-600">{error}</p>}
					<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<Button type="button" variant="outline" className="min-h-11" disabled={pending} onClick={() => changeOpen(false)}>{t("common.cancel")}</Button>
						<Button type="submit" variant="destructive" className="min-h-11" disabled={pending || confirmation.trim().toLowerCase() !== email.toLowerCase()}>{t(pending ? "account.delete.deleting" : "account.delete.button")}</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	</>;
}
