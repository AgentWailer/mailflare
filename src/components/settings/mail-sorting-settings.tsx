"use client";
import { useEffect, useState } from "react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth/client";
type Settings = {
	mode: "active" | "observe" | "off";
	dailyLimit: number;
	threshold: number;
};
type State = {
	settings: Settings;
	available: boolean;
	learningExamples: number;
	usage: { requests: number; inputTokens: number };
	overrides: Array<{ sender: string; category: string }>;
};
export function MailSortingSettings() {
	const { selectedMailbox } = useSelectedMailbox();
	return (
		<MailSortingForm
			key={selectedMailbox?.id ?? "none"}
			mailboxId={selectedMailbox?.id}
		/>
	);
}
function MailSortingForm({ mailboxId }: { mailboxId?: string }) {
	const { t } = useLanguage();
	const [data, setData] = useState<State | null>(null);
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState("");
	useEffect(() => {
		let active = true;
		if (mailboxId)
			authFetch(
				`/api/settings/mail-sorting?${new URLSearchParams({ mailboxId })}`,
			)
				.then(async (response) => {
					if (!response.ok) throw new Error();
					return response.json();
				})
				.then((value) => {
					if (active) setData(value as State);
				})
				.catch(() => {
					if (active) setNotice(t("smart.failed"));
				});
		return () => {
			active = false;
		};
	}, [mailboxId, t]);
	async function save() {
		if (!mailboxId || !data) return;
		setPending(true);
		setNotice("");
		try {
			const response = await authFetch("/api/settings/mail-sorting", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId, ...data.settings }),
			});
			if (!response.ok) throw new Error();
			setNotice(t("smart.saved"));
		} catch {
			setNotice(t("smart.failed"));
		} finally {
			setPending(false);
		}
	}
	async function forget(sender: string) {
		if (!mailboxId) return;
		setPending(true);
		try {
			const response = await authFetch("/api/settings/mail-sorting", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mailboxId, sender }),
			});
			if (!response.ok) throw new Error();
			setData((current) =>
				current
					? {
							...current,
							overrides: current.overrides.filter(
								(item) => item.sender !== sender,
							),
						}
					: null,
			);
		} catch {
			setNotice(t("smart.failed"));
		} finally {
			setPending(false);
		}
	}
	async function clearLearning() {
		if (!mailboxId || !window.confirm(t("smart.clearLearningConfirm"))) return;
		setPending(true);
		try {
			const response = await authFetch("/api/settings/mail-sorting", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId, clearLearning: true }) });
			if (!response.ok) throw new Error();
			setData((current) => current ? { ...current, learningExamples: 0 } : null);
		} catch { setNotice(t("smart.failed")); }
		finally { setPending(false); }
	}
	function change(key: keyof Settings, value: string | number) {
		setData((current) =>
			current
				? { ...current, settings: { ...current.settings, [key]: value } }
				: null,
		);
	}
	return (
		<section className="space-y-4">
			<h3 className="text-base font-semibold">{t("smart.title")}</h3>
			<p className="text-sm text-neutral-500">{t("smart.description")}</p>
			{data && (
				<>
					<div className="grid gap-4 sm:grid-cols-2">
						<label className="grid gap-2 text-sm">
							{t("smart.mode")}
							<select
								className="min-h-11 rounded-lg border border-neutral-200 bg-white px-3 text-base"
								value={data.settings.mode}
								disabled={pending}
								onChange={(event) => change("mode", event.target.value)}
							>
								<option value="active">{t("smart.active")}</option>
								<option value="observe">{t("smart.observe")}</option>
								<option value="off">{t("smart.off")}</option>
							</select>
						</label>
						<label className="grid gap-2 text-sm">
							{t("smart.limit")}
							<Input
								className="min-h-11 text-base"
								type="number"
								min="0"
								max="10000"
								value={data.settings.dailyLimit}
								disabled={pending}
								onChange={(event) =>
									change("dailyLimit", Number(event.target.value))
								}
							/>
						</label>
						<label className="grid gap-2 text-sm">
							{t("smart.threshold")}
							<Input
								className="min-h-11 text-base"
								type="number"
								min="80"
								max="99"
								step="1"
								value={Math.round(data.settings.threshold*100)}
								disabled={pending}
								onChange={(event) =>
									change("threshold", Number(event.target.value)/100)
								}
							/>
						</label>
					</div>
					<p className="text-sm text-neutral-500">{t("smart.learningCount", { count: data.learningExamples ?? 0 })}</p>
					{!!data.learningExamples && <Button variant="outline" disabled={pending} onClick={() => void clearLearning()}>{t("smart.clearLearning")}</Button>}
					{!data.available && (
						<p role="status" className="text-sm text-amber-700">
							{t("smart.unavailable")}
						</p>
					)}
					<p className="text-sm text-neutral-500">
						{t("smart.usage", {
							requests: data.usage.requests,
							tokens: data.usage.inputTokens,
						})}
					</p>
					<Button disabled={pending} onClick={() => void save()}>
						{pending ? t("common.saving") : t("rules.saveChanges")}
					</Button>
					{!!data.overrides.length && (
						<div className="space-y-2">
							<h4 className="text-sm font-medium">{t("smart.overrides")}</h4>
							{data.overrides.map((item) => (
								<div
									key={item.sender}
									className="flex items-center gap-2 text-sm"
								>
									<span className="min-w-0 flex-1 break-words">
										{item.sender} ·{" "}
										{t(
											item.category === "primary"
												? "smart.primary"
												: item.category === "social"
													? "smart.social"
													: "smart.promotions",
										)}
									</span>
									<Button
										variant="ghost"
										disabled={pending}
										onClick={() => void forget(item.sender)}
									>
										{t("common.delete")}
									</Button>
								</div>
							))}
						</div>
					)}
				</>
			)}
			<p className="text-xs text-neutral-500">{t("smart.privacy")}</p>
			{notice && (
				<p role="status" className="text-sm">
					{notice}
				</p>
			)}
		</section>
	);
}
