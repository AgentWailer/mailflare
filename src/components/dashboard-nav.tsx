"use client";
import { ReceiptText, Package } from "lucide-react";

import type { FormEvent } from "react";
import Link from "next/link";
import { useLanguage } from "./language-provider";
import { folderColorKeys } from "@/lib/folders/color-keys";
import type { TranslationKey } from "@/lib/i18n/types";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Archive,
  CalendarClock,
  Clock,
  FileText,
  Inbox,
  Megaphone,
  Users,
  MailPlus,
  Mails,
  Plus,
  Send,
  Settings2,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessageCounts } from "@/hooks/use-message-counts";
import { authFetch } from "@/lib/auth/client";
import {
  DEFAULT_FOLDER_COLOR,
  FOLDER_COLOR_OPTIONS,
} from "@/lib/folders/colors";
import type { FolderColor } from "@/lib/folders/types";
import { NavItem } from "./components-nav";
import type { NavLink } from "./components-nav-types";
import type { CustomFolder } from "./dashboard-nav-types";
import {
  getFolderNavCount,
  moveMessagesToCategory,
  moveMessagesToSystemFolder,
} from "./dashboard-nav-utils";
import { revealLabel, SidebarLabelTree } from "./sidebar-label-tree";
import { LabelRenameDialog } from "./label-rename-dialog";
import { getLabelPath } from "@/lib/folders/hierarchy";
import { notifyLabelsChanged } from "./messages/use-mailbox-folders";
import { useLabelVisibility } from "./messages/use-label-visibility";
import { ReorderableList } from "./reorderable-list";
import { SidebarFooter } from "./sidebar-footer";
import { SidebarHeader } from "./sidebar-header";
import { SidebarScaffold } from "./sidebar-scaffold";
import { useSidebar } from "./sidebar-state";

const links = [
  { href: "/compose", labelKey: "navigation.compose", icon: MailPlus, primary: true },
  { href: "/inbox", labelKey: "navigation.inbox", icon: Inbox, preloadMessages: true },
  { href: "/promotions", labelKey: "smart.promotions", icon: Megaphone, preloadMessages: true },
  { href: "/social", labelKey: "smart.social", icon: Users, preloadMessages: true },
  { href: "/invoices", labelKey: "smart.invoices", icon: ReceiptText, preloadMessages: true },
  { href: "/orders", labelKey: "smart.orders", icon: Package, preloadMessages: true },
  { href: "/starred", labelKey: "navigation.starred", icon: Star, preloadMessages: true },
  { href: "/all", labelKey: "navigation.allMail", icon: Mails, preloadMessages: true },
  { href: "/snoozed", labelKey: "navigation.snoozed", icon: Clock, preloadMessages: true },
  { href: "/sent", labelKey: "navigation.sent", icon: Send, preloadMessages: true },
  { href: "/scheduled", labelKey: "navigation.scheduled", icon: CalendarClock, preloadMessages: true },
  { href: "/drafts", labelKey: "navigation.drafts", icon: FileText, preloadMessages: true },
  {
    href: "/archived",
    labelKey: "navigation.archived",
    icon: Archive,
    preloadMessages: true,
  },
  { href: "/spam", labelKey: "navigation.spam", icon: ShieldAlert, preloadMessages: true },
  { href: "/trash", labelKey: "navigation.trash", icon: Trash2, preloadMessages: true },
] satisfies (Omit<NavLink, "label"> & { labelKey: TranslationKey })[];


// Keep the saved two-list ordering compatible while displaying both lists in full.
const MORE_LINK_HREFS = ["/drafts", "/archived", "/spam", "/trash"];

export function DashboardNav({ className }: { className?: string }) {
  const { t } = useLanguage();
  const { minimal } = useSidebar();
  const pathname = usePathname();
  const router = useRouter();
  const { selectedMailbox, isLoading } = useSelectedMailbox();
  const { counts } = useMessageCounts(selectedMailbox?.id, !isLoading);
  const { hiddenLabelIds } = useLabelVisibility(selectedMailbox?.id);
  const [deletingLabel, setDeletingLabel] = useState<CustomFolder | null>(null);
  const [renamingLabel, setRenamingLabel] = useState<{ mailboxId: string; folder: CustomFolder } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const canManageLabels = !!selectedMailbox && (!selectedMailbox.permission || selectedMailbox.permission === "full_access");
  const [folderState, setFolderState] = useState<{ mailboxId: string; folders: CustomFolder[] } | null>(null);
  const folders = folderState?.mailboxId === selectedMailbox?.id ? folderState?.folders ?? [] : [];
  const [newFolderParentId, setNewFolderParentId] = useState<string>("");
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderColor, setNewFolderColor] =
    useState<FolderColor>(DEFAULT_FOLDER_COLOR);
  const [addingFolder, setAddingFolder] = useState(false);
  const [folderCreateError, setFolderCreateError] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const linksWithCounts: NavLink[] = links.map(({ labelKey, ...rest }): NavLink => {
    const link = { ...rest, label: t(labelKey) };
    if (link.href === "/inbox") {
      return { ...link, count: getFolderNavCount("inbox", counts.folders), onMessageDrop: canManageLabels && selectedMailbox ? (ids: string[]) => void moveMessagesToCategory(ids, "primary", selectedMailbox.id) : undefined };
    }
    if (link.href === "/promotions" || link.href === "/social" || link.href === "/invoices" || link.href === "/orders") {
      const category = link.href.slice(1) as "promotions" | "social" | "invoices" | "orders";
      return { ...link, count: getFolderNavCount(category, counts.folders), onMessageDrop: canManageLabels && selectedMailbox ? (ids: string[]) => void moveMessagesToCategory(ids, category, selectedMailbox.id) : undefined };
    }
    if (link.href === "/starred") {
      return { ...link, count: getFolderNavCount("starred", counts.folders) };
    }
    if (link.href === "/all") {
      return { ...link, count: getFolderNavCount("all", counts.folders) };
    }
    if (link.href === "/snoozed") {
      return { ...link, count: getFolderNavCount("snoozed", counts.folders) };
    }
    if (link.href === "/sent") {
      return { ...link, count: getFolderNavCount("sent", counts.folders) };
    }
    if (link.href === "/scheduled") {
      return { ...link, count: counts.folders.scheduled.total };
    }
    if (link.href === "/drafts") {
      return { ...link, count: getFolderNavCount("drafts", counts.folders) };
    }
    if (link.href === "/archived") {
      return {
        ...link,
        count: getFolderNavCount("archived", counts.folders),
        onMessageDrop: (messageIds: string[]) =>
          void moveMessagesToSystemFolder(messageIds, "archive"),
      };
    }
    if (link.href === "/spam") {
      return {
        ...link,
        count: getFolderNavCount("spam", counts.folders),
        onMessageDrop: (messageIds: string[]) =>
          void moveMessagesToSystemFolder(messageIds, "spam"),
      };
    }
    if (link.href === "/trash") {
      return {
        ...link,
        count: getFolderNavCount("trash", counts.folders),
        onMessageDrop: (messageIds: string[]) =>
          void moveMessagesToSystemFolder(messageIds, "trash"),
      };
    }
    return link;
  });

  const isActiveHref = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const composeLink = linksWithCounts.find((link) => link.href === "/compose");
  const mainLinks = linksWithCounts.filter((link) => link.href !== "/compose" && !MORE_LINK_HREFS.includes(link.href!));
  const moreLinks = linksWithCounts.filter((link) => MORE_LINK_HREFS.includes(link.href!));
  const visibleFolders = folders.filter(folder => !hiddenLabelIds.includes(folder.id));

  useEffect(() => {
    if (!selectedMailbox?.id) return;
    const mailboxId = selectedMailbox.id;

    let cancelled = false;
    let requestNumber = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const params = new URLSearchParams({ mailboxId });
    function load() {
      const request = ++requestNumber;
      authFetch(`/api/folders?${params.toString()}`)
        .then((response) => { if (!response.ok) throw new Error("Unable to load labels"); return response.json() as Promise<{ folders?: CustomFolder[] }>; })
        .then((data) => {
          if (!cancelled && request === requestNumber) setFolderState({ mailboxId, folders: data.folders ?? [] });
        })
        .catch(() => {
          // Preserve already loaded labels during temporary network failures.
        });
    }
    function reload() {
      requestNumber += 1;
      clearTimeout(timer);
      timer = setTimeout(load, 150);
    }
    load();
    window.addEventListener("mailflare:messages-changed", reload);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("mailflare:messages-changed", reload);
    };
  }, [selectedMailbox?.id]);

  async function createFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMailbox?.id || !newFolderName.trim()) return;

    setAddingFolder(true);
    setFolderCreateError(false);
    try {
      const response = await authFetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailboxId: selectedMailbox.id,
          name: newFolderName,
          color: newFolderColor,
          parentId: newFolderParentId || null,
        }),
      });
      if (!response.ok) throw new Error("Unable to create label");
      const folder = (await response.json()) as CustomFolder;
      revealLabel(selectedMailbox.id, folder, folders);
      setFolderState(previous => previous?.mailboxId !== selectedMailbox.id ? previous : { ...previous, folders: [...previous.folders, folder].sort((a, b) => a.name.localeCompare(b.name)) });
      setNewFolderName("");
      setNewFolderParentId("");
      setNewFolderColor(DEFAULT_FOLDER_COLOR);
      setFolderDialogOpen(false);
      notifyLabelsChanged();
    } catch {
      setFolderCreateError(true);
    } finally {
      setAddingFolder(false);
    }
  }

  async function deleteLabel() {
    if (!deletingLabel || !selectedMailbox) return;
    setDeleting(true);
    setDeleteError(false);
    try {
      const response = await authFetch(`/api/folders/${encodeURIComponent(deletingLabel.id)}?${new URLSearchParams({ mailboxId: selectedMailbox.id })}`, { method: "DELETE" });
      if (!response.ok) { setDeleteError(true); return; }
      setFolderState(previous => previous?.mailboxId !== selectedMailbox.id ? previous : { ...previous, folders: previous.folders.filter(item => item.id !== deletingLabel.id).map(item => item.parentId === deletingLabel.id ? { ...item, parentId: null } : item) });
      if (isActiveHref(`/folders/${deletingLabel.id}`)) router.replace("/all");
      setDeletingLabel(null);
      notifyLabelsChanged();
    } catch { setDeleteError(true); }
    finally { setDeleting(false); }
  }

  return (
    <SidebarScaffold className={className} header={<SidebarHeader href="/inbox" />} footer={<SidebarFooter />}>
      {composeLink && <NavItem labelClassName="font-medium" link={composeLink} />}
      {minimal && <hr className="mx-6 my-2 border-neutral-200/70" />}
      <ReorderableList
        storageKey="mailflare:nav:layout"
        initialItemAfter={{ "/all": "/starred" }}
        enabled={!minimal}
        lists={[
          { id: "main", items: mainLinks.map((link) => ({ id: link.href!, node: <NavItem link={link} /> })) },
          {
            id: "more",
            items: moreLinks.map((link) => ({ id: link.href!, node: <NavItem link={link} /> })),
          },
        ]}
      />
      {minimal && <hr className="mx-6 my-2 border-neutral-200/70" />}
      {!minimal && (
        <div className="mt-2 ml-3 mr-2 flex min-h-11 shrink-0 items-center gap-1 pl-3">
          <span className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{t("smart.labels")}</span>
          <Link href="/settings/inbox#labels" aria-label={t("labels.visibility.title")} title={t("labels.visibility.title")} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-neutral-500 hover:bg-blue-50 hover:text-blue-700"><Settings2 className="h-4 w-4" /></Link>
          {canManageLabels && (
            <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
              <DialogTrigger asChild>
                <button
                  type="button"
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-neutral-500 hover:bg-blue-50 hover:text-blue-700 md:h-7 md:w-7"
                  onClick={() => { setNewFolderParentId(""); setFolderCreateError(false); }}
                  aria-label={t("navigation.createFolder")}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("navigation.createFolder")}</DialogTitle>
                  <DialogDescription>
                    {t("navigation.folderDescription")}
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={createFolder} className="space-y-4">
                  {folderCreateError && <p role="alert" className="text-sm text-red-700">{t("labels.createFailed")}</p>}
                  <div className="space-y-2">
                    <Label htmlFor="folderName">{t("navigation.folderName")}</Label>
                    <Input
                      id="folderName"
                      className="h-11 text-base md:h-10 md:text-sm"
                      value={newFolderName}
                      onChange={(event) => setNewFolderName(event.target.value)}
                      placeholder={t("navigation.folderExample")}
                      autoFocus
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="folderParent">{t("labels.parent")}</Label>
                    <select id="folderParent" value={newFolderParentId} onChange={event => setNewFolderParentId(event.target.value)} className="h-11 w-full min-w-0 rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-900">
                      <option value="">{t("labels.topLevel")}</option>
                      {folders.map(folder => <option key={folder.id} value={folder.id}>{getLabelPath(folder, folders)}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label>{t("navigation.color")}</Label>
                    <div
                      className="flex flex-wrap gap-2"
                      role="radiogroup"
                      aria-label={t("navigation.folderColor")}
                    >
                      {FOLDER_COLOR_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={newFolderColor === option.value}
                          aria-label={t(folderColorKeys[option.value])}
                          title={t(folderColorKeys[option.value])}
                          onClick={() => setNewFolderColor(option.value)}
                          className={`h-11 w-11 rounded-full border-2 transition-transform hover:scale-110 md:h-8 md:w-8 ${
                            newFolderColor === option.value
                              ? "border-neutral-900 ring-2 ring-neutral-300 ring-offset-2"
                              : "border-transparent"
                          }`}
                          style={{ backgroundColor: option.value }}
                        />
                      ))}
                    </div>
                  </div>
                  <Button
                    type="submit"
                    className="h-11 w-full md:h-10 md:w-auto"
                    disabled={addingFolder || !newFolderName.trim()}
                  >
                    {addingFolder ? t("navigation.creating") : t("navigation.createFolder")}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </div>
      )}
      
      {!minimal && visibleFolders.length === 0 && (
        <div className="px-4 py-1.5 text-xs text-neutral-500">
          {folders.length ? <Link href="/settings/inbox#labels" className="text-blue-700">{t("labels.visibility.allHidden")}</Link> : t("navigation.noFolders")}
        </div>
      )}
      <SidebarLabelTree key={selectedMailbox?.id ?? "none"} mailboxId={selectedMailbox?.id ?? "none"} folders={folders} hiddenIds={hiddenLabelIds} counts={counts.customFolders} canManage={canManageLabels}
        onDelete={folder => { setDeleteError(false); setDeletingLabel(folder); }}
        onRename={folder => { if (selectedMailbox) setRenamingLabel({ mailboxId: selectedMailbox.id, folder }); }}
        onCreateChild={folder => { setNewFolderParentId(folder.id); setNewFolderName(""); setFolderCreateError(false); setFolderDialogOpen(true); }} />
      {renamingLabel && renamingLabel.mailboxId === selectedMailbox?.id && canManageLabels && folders.some(folder => folder.id === renamingLabel.folder.id) && <LabelRenameDialog key={`${renamingLabel.mailboxId}:${renamingLabel.folder.id}`} mailboxId={renamingLabel.mailboxId} folder={renamingLabel.folder} onClose={() => setRenamingLabel(null)} onRenamed={folder => setFolderState(previous => previous?.mailboxId !== renamingLabel.mailboxId ? previous : { ...previous, folders: previous.folders.map(item => item.id === folder.id ? { ...item, ...folder } : item) })} />}
      <Dialog open={!!deletingLabel} onOpenChange={(open) => { if (!open && !deleting) setDeletingLabel(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("labels.deleteTitle", { name: deletingLabel?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("labels.deleteDescription")}</DialogDescription>
          </DialogHeader>
          {deleteError && <p role="alert" className="mb-4 text-sm text-red-600">{t("labels.deleteError")}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" className="max-md:min-h-11" disabled={deleting} onClick={() => setDeletingLabel(null)}>{t("common.cancel")}</Button>
            <Button className="bg-red-600 hover:bg-red-700 max-md:min-h-11" disabled={deleting} onClick={() => void deleteLabel()}>{t(deleting ? "labels.deleting" : "labels.delete")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </SidebarScaffold>
  );
}
