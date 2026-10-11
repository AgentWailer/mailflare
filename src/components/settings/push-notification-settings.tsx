"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/language-provider";
import {
	disablePushNotifications,
	enablePushNotifications,
	getPushState,
	needsHomeScreenInstallation,
	sendTestPushNotification,
} from "@/lib/push/client";

type State = {
	loading: boolean;
	supported: boolean;
	configured: boolean;
	permission: NotificationPermission | "unsupported";
	subscribed: boolean;
	error: string | null;
};

const initialState: State = {
	loading: true,
	supported: false,
	configured: false,
	permission: "unsupported",
	subscribed: false,
	error: null,
};

export function PushNotificationSettings() {
	const { t } = useLanguage();
	const [state, setState] = useState<State>(initialState);
	const [installRequired] = useState(needsHomeScreenInstallation);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<"sent" | "failed" | null>(null);

	useEffect(() => {
		let cancelled = false;
		getPushState()
			.then((next) => {
				if (!cancelled) setState({ ...next, loading: false, error: next.syncFailed ? t("settings.push.updateFailed") : null });
			})
			.catch(() => {
				if (!cancelled) {
					setState((current) => ({
						...current,
						loading: false,
						error: t("settings.push.loadFailed"),
					}));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [t]);

	const disabled =
		state.loading ||
		installRequired ||
		!state.supported ||
		(!state.configured && !state.subscribed) ||
		(state.permission === "denied" && !state.subscribed);
	let description = t("settings.push.description");
	if (state.loading) description = t("settings.push.loading");
	else if (installRequired) description = t("settings.push.install");
	else if (!state.supported) description = t("settings.push.unsupported");
	else if (!state.configured) description = t("settings.push.notConfigured");
	else if (state.permission === "denied") description = t("settings.push.blocked");

	return (
		<div>
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">{t("settings.push.title")}</span>
					<span className="mt-1 block text-sm text-neutral-500">{description}</span>
				</span>
				<Switch
					checked={state.subscribed}
					disabled={disabled}
					onCheckedChange={(enabled) => {
						setTestResult(null);
						setState((current) => ({ ...current, loading: true, error: null }));
						void (enabled ? enablePushNotifications() : disablePushNotifications())
							.then(() => getPushState())
							.then((next) => setState({ ...next, loading: false, error: next.syncFailed ? t("settings.push.updateFailed") : null }))
								.catch(() => {
								setState((current) => ({
									...current,
									loading: false,
									error: t("settings.push.updateFailed"),
								}));
							});
					}}
					aria-label={t("settings.push.enable")}
				/>
			</label>
			<p className="mt-2 px-4 text-sm text-neutral-500">{t("settings.push.badge")}</p>
			{state.subscribed && (
				<div className="mt-3 px-4">
					<Button type="button" variant="outline" disabled={testing || state.loading} onClick={() => {
						setTesting(true);
						setTestResult(null);
						void sendTestPushNotification().then(() => setTestResult("sent"), () => setTestResult("failed")).finally(() => setTesting(false));
					}}>{t(testing ? "settings.push.testing" : "settings.push.test")}</Button>
				</div>
			)}
			{testResult && <p role="status" className={`mt-2 px-4 text-sm ${testResult === "failed" ? "text-red-600" : "text-neutral-600"}`}>{t(testResult === "sent" ? "settings.push.testSent" : "settings.push.testFailed")}</p>}
			{state.error && <p role="alert" className="mt-2 px-4 text-sm text-red-600">{state.error}</p>}
		</div>
	);
}
