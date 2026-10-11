"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";

type ExternalContentSettings = { enabled: boolean };
const changedKey = "mailflare:external-content-changed";

/** Shared account preference. Unknown or failed settings never authorize a remote request. */
export function useExternalContent() {
	const user = useCurrentUser();
	const client = useQueryClient();
	const key = ["external-content-settings", user?.id];
	const query = useQuery({
		queryKey: key, enabled: !!user, staleTime: 60_000,
		refetchOnWindowFocus: true, refetchOnReconnect: true,
		queryFn: async ({ signal }) => {
			const session = getClientSessionToken();
			const response = await authFetch("/api/settings/external-content", { signal, cache: "no-store" });
			const data = await response.json() as ExternalContentSettings;
			if (!response.ok || typeof data.enabled !== "boolean" || session !== getClientSessionToken()) throw new Error("Unable to load external content settings");
			return data;
		},
	});
	const mutation = useMutation({
		mutationKey: key,
		mutationFn: async (enabled: boolean) => {
			const session = getClientSessionToken();
			const response = await authFetch("/api/settings/external-content", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
			const data = await response.json() as ExternalContentSettings;
			if (!response.ok || typeof data.enabled !== "boolean" || session !== getClientSessionToken()) throw new Error("Unable to save external content settings");
			return data;
		},
		onMutate: () => client.cancelQueries({ queryKey: key }),
		onSuccess: data => {
			client.setQueryData(key, data);
			try { localStorage.setItem(changedKey, JSON.stringify({ at: Date.now() })); } catch { /* The saved server setting still applies. */ }
		},
	});
	useEffect(() => {
		const changed = (event: StorageEvent) => { if (event.key === changedKey) void client.invalidateQueries({ queryKey: ["external-content-settings"] }); };
		window.addEventListener("storage", changed);
		return () => window.removeEventListener("storage", changed);
	}, [client]);
	return {
		enabled: query.data?.enabled ?? false, settings: query.data,
		isLoading: !user || query.isPending, failed: query.isError || mutation.isError,
		saving: mutation.isPending, setEnabled: mutation.mutateAsync,
		retry: () => { mutation.reset(); return query.refetch(); },
	};
}
