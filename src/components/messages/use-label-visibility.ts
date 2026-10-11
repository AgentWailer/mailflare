"use client";

import { useEffect } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import { LABELS_CHANGED_EVENT } from "./use-mailbox-folders";

type Visibility = { hiddenLabelIds: string[] };

export function useLabelVisibility(mailboxId: string | undefined) {
	const client = useQueryClient();
	const key = ["label-visibility", mailboxId];
	const query = useQuery({
		queryKey: key, enabled: !!mailboxId, staleTime: 0,
		refetchOnMount: "always", refetchOnWindowFocus: true, refetchOnReconnect: true,
		queryFn: async ({ signal }) => {
			const session = getClientSessionToken();
			const response = await authFetch(`/api/settings/labels?${new URLSearchParams({ mailboxId: mailboxId! })}`, { signal, cache: "no-store" });
			if (!response.ok || session !== getClientSessionToken()) throw new Error("Unable to load label visibility");
			const data = await response.json() as Visibility;
			if (session !== getClientSessionToken()) throw new Error("Account changed while loading label visibility");
			return data;
		},
	});
	const mutation = useMutation({
		mutationKey: key,
		mutationFn: async ({ labelId, visible }: { labelId: string; visible: boolean }) => {
			if (!mailboxId) throw new Error("Mailbox required");
			const session = getClientSessionToken();
			const response = await authFetch("/api/settings/labels", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId, labelId, visible }) });
			if (!response.ok || session !== getClientSessionToken()) throw new Error("Unable to save label visibility");
			const data = await response.json() as Visibility;
			if (session !== getClientSessionToken()) throw new Error("Account changed while saving label visibility");
			return data;
		},
		onMutate: () => client.cancelQueries({ queryKey: key }),
		onSuccess: data => { client.setQueryData(key, data); },
	});
	const saving = useIsMutating({ mutationKey: key }) > 0;
	useEffect(() => {
		const reload = () => { void client.invalidateQueries({ queryKey: ["label-visibility", mailboxId] }); };
		window.addEventListener(LABELS_CHANGED_EVENT, reload);
		return () => window.removeEventListener(LABELS_CHANGED_EVENT, reload);
	}, [client, mailboxId]);
	return { hiddenLabelIds: query.data?.hiddenLabelIds ?? [], isLoading: !!mailboxId && query.isPending, failed: query.isError || mutation.isError, saving, setVisible: mutation.mutateAsync, retry: () => { mutation.reset(); return query.refetch(); } };
}
