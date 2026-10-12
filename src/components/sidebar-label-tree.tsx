"use client";

import { useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import type { CustomFolder } from "./dashboard-nav-types";
import { useLanguage } from "./language-provider";
import { useSidebar } from "./sidebar-state";
import { NavItem } from "./components-nav";
import { LabelActions } from "./label-actions";
import { ReorderableList } from "./reorderable-list";
import { getLabelPath, visibleLabelGroups } from "@/lib/folders/hierarchy";
import { moveMessagesToCustomFolder } from "./dashboard-nav-utils";

const memoryPreferences = new Map<string, string>();
const EVENT = "mailflare:label-groups-changed";
function subscribe(callback: () => void) {
 const changed = (event: Event) => {
  if (event instanceof StorageEvent && event.key) memoryPreferences.delete(event.key);
  callback();
 };
 window.addEventListener(EVENT, changed); window.addEventListener("storage", changed);
 return () => { window.removeEventListener(EVENT, changed); window.removeEventListener("storage", changed); };
}
const serverSnapshot = () => "[]";
function snapshot(key: string) {
 if (memoryPreferences.has(key)) return memoryPreferences.get(key)!;
 try { return localStorage.getItem(key) ?? "[]"; } catch { return "[]"; }
}
function readCollapsed(raw: string): string[] {
 try { const value: unknown = JSON.parse(raw); return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; } catch { return []; }
}
function saveCollapsed(key: string, ids: string[]) {
 const raw = JSON.stringify(ids);
 try { localStorage.setItem(key, raw); memoryPreferences.delete(key); } catch { memoryPreferences.set(key, raw); }
 window.dispatchEvent(new Event(EVENT));
}

/** Newly created sublabels should be visible even when their ancestors were collapsed. */
export function revealLabel(mailboxId: string, label: CustomFolder, folders: CustomFolder[]) {
 const key = `mailflare:nav:collapsed-labels:${mailboxId}`, ancestors = new Set<string>();
 let parentId = label.parentId;
 while (parentId && !ancestors.has(parentId)) {
  ancestors.add(parentId); parentId = folders.find(folder => folder.id === parentId)?.parentId;
 }
 saveCollapsed(key, readCollapsed(snapshot(key)).filter(id => !ancestors.has(id)));
}

export function SidebarLabelTree({ mailboxId, folders, hiddenIds, counts, canManage, onDelete, onCreateChild, onRename }: {
 mailboxId: string; folders: CustomFolder[]; hiddenIds: string[];
 counts: Record<string, { unread: number }>; canManage: boolean;
 onDelete: (folder: CustomFolder) => void; onCreateChild: (folder: CustomFolder) => void; onRename: (folder: CustomFolder) => void;
}) {
 const { t } = useLanguage(), { minimal } = useSidebar();
 const storageKey = `mailflare:nav:collapsed-labels:${mailboxId}`;
 const raw = useSyncExternalStore(subscribe, () => snapshot(storageKey), serverSnapshot);
 const collapsed = readCollapsed(raw);
 const groups = visibleLabelGroups(folders, hiddenIds);
 function toggle(id: string) {
  saveCollapsed(storageKey, collapsed.includes(id) ? collapsed.filter(item => item !== id) : [...collapsed, id]);
 }

 function group(parent: string | null, depth = 0) {
  const siblings = groups.get(parent) ?? [];
  if (!siblings.length) return null;
  return <ReorderableList key={parent ?? "root"}
   storageKey={`mailflare:nav:layout:folders:${mailboxId}${parent ? `:children:${parent}` : ""}`}
   fallbackStorageKey="mailflare:nav:layout:folders" enabled={!minimal} itemLabel={item => siblings.find(folder => folder.id === item.id)?.name ?? item.id}
   lists={[{ id: "folders", items: siblings.map(folder => ({ id: folder.id, node: <NavItem link={{ href: `/folders/${folder.id}`, label: getLabelPath(folder, folders), icon: Folder, iconColor: folder.color, count: counts[folder.id]?.unread, preloadMessages: true, onMessageDrop: canManage ? ids => void moveMessagesToCustomFolder(ids, folder.id) : undefined }} /> })) }]}
   renderItem={(item, actions) => {
    const folder = siblings.find(label => label.id === item.id)!;
    if (minimal) return item.node;
    const children = groups.get(folder.id)?.length;
    return <div className="sidebar-label-row relative flex min-w-0 items-center" style={{ paddingLeft: Math.min(depth, 5) * 12 }}>
     {/* The disclosure control uses the link's leading gutter, never an extra column. */}
     {children ? <button type="button" className="label-group-toggle absolute top-0 flex h-11 w-6 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-200/60 md:h-9" style={{ left: Math.min(depth, 5) * 12 }} aria-expanded={!collapsed.includes(folder.id)} aria-label={t(collapsed.includes(folder.id) ? "labels.expand" : "labels.collapse", { name: folder.name })} onClick={() => toggle(folder.id)}>{collapsed.includes(folder.id) ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button> : null}
     <div className="sidebar-label-link min-w-0 flex-1" title={getLabelPath(folder, folders)}><NavItem labelClassName="text-sm whitespace-nowrap" link={{ href: `/folders/${folder.id}`, label: folder.parentId && groups.has(folder.parentId) ? folder.name : getLabelPath(folder, folders), icon: Folder, iconColor: folder.color, count: counts[folder.id]?.unread, preloadMessages: true, onMessageDrop: canManage ? ids => void moveMessagesToCustomFolder(ids, folder.id) : undefined }} /></div>
     <LabelActions name={folder.name} actions={actions} canDelete={canManage} onDelete={() => onDelete(folder)} onRename={() => onRename(folder)} onCreateChild={() => onCreateChild(folder)} />
    </div>;
   }}
   renderAfterItem={item => minimal || !collapsed.includes(item.id) ? group(item.id, depth + 1) : null}
  />;
 }
 return group(null);
}
