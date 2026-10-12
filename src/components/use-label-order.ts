"use client";

import { useEffect, useRef } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { authFetch, getClientSessionToken } from "@/lib/auth/client";
import { getLayoutSnapshot, parseLayoutSnapshot } from "./reorderable-list-utils";
import { useLanguage } from "./language-provider";
import type { CustomFolder } from "./dashboard-nav-types";

type Orders = { orders: Record<string, string[]> };
type Change = { parentId: string | null; order: string[]; session: string | null; onlyIfAbsent?: boolean };

/** Optimistic, serial saves keep rapid drags in order. Focus/polling picks up other devices. */
export function useLabelOrder(mailboxId: string, groups: Map<string | null, CustomFolder[]>) {
 const client = useQueryClient(), { t } = useLanguage();
 const queryKey = ["label-order", mailboxId];
 const adopted = useRef(new Set<string>());
 const saving = useIsMutating({ mutationKey: queryKey }) > 0;
 const query = useQuery({ queryKey, enabled: mailboxId !== "none" && !saving, staleTime: 0,
  refetchOnWindowFocus: true, refetchOnReconnect: true, refetchInterval: 30000,
  queryFn: async ({ signal }) => {
   const session = getClientSessionToken();
   const response = await authFetch(`/api/settings/label-order?${new URLSearchParams({ mailboxId })}`, { signal, cache: "no-store" });
   if (!response.ok) throw new Error("Unable to load label order");
   const data = await response.json() as Orders;
   if (session !== getClientSessionToken()) throw new Error("Account changed while loading label order");
   if (!data?.orders || typeof data.orders !== "object" || Array.isArray(data.orders)) throw new Error("Invalid label order response");
   return data;
  },
 });
 const mutation = useMutation({ mutationKey: queryKey, scope: { id: `label-order:${mailboxId}` }, retry: (count, error) => count < 2 && !error.message.startsWith("Account changed"),
  mutationFn: async (change: Change) => {
   if (change.session !== getClientSessionToken()) throw new Error("Account changed while saving label order");
   const response = await authFetch("/api/settings/label-order", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId, parentId: change.parentId, order: change.order, onlyIfAbsent: change.onlyIfAbsent }) });
   if (change.session !== getClientSessionToken()) throw new Error("Account changed while saving label order");
   if (!response.ok) throw new Error("Unable to save label order");
  },
  onMutate: change => {
   void client.cancelQueries({ queryKey });
   if (change.session === getClientSessionToken()) client.setQueryData<Orders>(queryKey, current => ({ orders: { ...current?.orders, [change.parentId ?? "root"]: change.order } }));
  },
  onError: (_error, change) => { if (change.session === getClientSessionToken()) toast.error(t("labels.orderSaveFailed")); },
  onSettled: (_data, _error, change) => {
   if (change.session === getClientSessionToken() && client.isMutating({ mutationKey: queryKey }) === 1) void client.invalidateQueries({ queryKey });
  },
 });
 // Keep polling/focus requests from replacing a save that is still in flight.
 const save = mutation.mutate;
 useEffect(() => {
  // Existing orders have no timestamp. Prefer the desktop's legacy arrangement;
  // an older phone cache must not become the account default first.
  if (!query.data || mailboxId === "none" || window.innerWidth < 768) return;
  const known = new Set([...groups.values()].flat().map(label => label.id));
  for (const parentId of groups.keys()) {
   const group = parentId ?? "root";
   if (query.data.orders[group] !== undefined || adopted.current.has(group)) continue;
   adopted.current.add(group);
   const storageKey = `mailflare:nav:layout:folders:${mailboxId}${parentId ? `:children:${parentId}` : ""}`;
   const local = parseLayoutSnapshot(getLayoutSnapshot(storageKey, parentId ? undefined : "mailflare:nav:layout:folders")).folders;
   const order = Array.isArray(local) ? [...new Set(local.filter(id => known.has(id)))] : [];
   if (order.length) save({ parentId, order, session: getClientSessionToken(), onlyIfAbsent: true });
  }
 }, [query.data, mailboxId, groups, save]);
 return {
  orders: query.data?.orders ?? {},
  saveOrder: (parentId: string | null, order: string[]) => save({ parentId, order, session: getClientSessionToken() }),
 };
}
