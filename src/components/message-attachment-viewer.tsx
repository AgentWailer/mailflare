"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowDownToLine, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { Skeleton } from "@/components/ui/skeleton";
import type { MessageAttachmentViewerProps } from "./message-attachment-viewer-types";
import {
	getAttachmentFileUrl,
	getAttachmentPreviewKind,
} from "./message-attachment-viewer-utils";

const PdfAttachmentPreview = lazy(() => import("./pdf-attachment-preview"));

export function MessageAttachmentViewer({
	attachment,
	messageId,
	onOpenChange,
	open,
}: MessageAttachmentViewerProps) {
	const { t } = useLanguage();
	const [textContent, setTextContent] = useState("");
	const [textError, setTextError] = useState("");

	const previewKind = attachment ? getAttachmentPreviewKind(attachment) : "unsupported";
	const previewUrl = attachment
		? getAttachmentFileUrl(messageId, attachment.id, "preview")
		: "";
	const downloadUrl = attachment
		? getAttachmentFileUrl(messageId, attachment.id, "download")
		: "";

	useEffect(() => {
		if (!open || !attachment || previewKind !== "text") return;
		let cancelled = false;
		setTextContent("");
		setTextError("");

		authFetch(previewUrl)
			.then(async (response) => {
				if (!response.ok) throw new Error(t("attachment.loadFailed"));
				const content = await response.text();
				if (!cancelled) setTextContent(content);
			})
			.catch((error) => {
				if (!cancelled) {
					setTextError(error instanceof Error ? error.message : t("attachment.loadFailed"));
				}
			});

		return () => {
			cancelled = true;
		};
	}, [attachment, open, previewKind, previewUrl, t]);

	if (!attachment) return null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent data-attachment-viewer style={{ paddingLeft: "env(safe-area-inset-left)", paddingRight: "env(safe-area-inset-right)" }} className="flex h-[min(92dvh,1000px)] w-[min(1200px,calc(100vw-48px))] max-h-[calc(100dvh-48px)] flex-col overflow-hidden p-0 md:p-0 max-lg:inset-0 max-lg:h-[100dvh] max-lg:max-h-[100dvh] max-lg:w-full max-lg:translate-x-0 max-lg:translate-y-0 max-lg:rounded-none" closeClassName="right-[max(8px,env(safe-area-inset-right))] top-[max(8px,env(safe-area-inset-top))] flex h-11 w-11 items-center justify-center p-0">
				<DialogHeader className="mb-0 flex shrink-0 flex-row items-center gap-2 space-y-0 border-b border-neutral-200 pb-2 pl-3 pr-14 pt-[max(8px,env(safe-area-inset-top))]">
					<DialogTitle className="min-w-0 flex-1 truncate text-sm">{attachment.filename}</DialogTitle>
					<DialogDescription className="sr-only">{attachment.type}</DialogDescription>
					<Button asChild variant="ghost" size="sm" className="h-11 w-11 shrink-0 p-0">
						<a href={downloadUrl} download={attachment.filename} aria-label={t("attachment.download")} title={t("attachment.download")}><ArrowDownToLine className="h-5 w-5" /></a>
					</Button>
				</DialogHeader>

				<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-neutral-100">
					{previewKind === "image" && (
						<img
							src={previewUrl}
							alt={attachment.filename}
							className="max-h-full max-w-full object-contain"
						/>
					)}
					{open && previewKind === "pdf" && (
						<Suspense fallback={<div role="status" className="p-6 text-sm">{t("nav.loadingPage")}</div>}><PdfAttachmentPreview key={previewUrl} url={previewUrl} /></Suspense>
					)}
					{previewKind === "audio" && (
						<audio src={previewUrl} controls className="w-[min(560px,90%)]" />
					)}
					{previewKind === "video" && (
						<video src={previewUrl} controls className="max-h-full max-w-full" />
					)}
					{previewKind === "text" && (
						textError || textContent ? (
							<pre className="h-full w-full overflow-auto whitespace-pre-wrap p-5 text-sm text-neutral-800">
								{textError || textContent}
							</pre>
						) : (
							<div className="h-full w-full space-y-3 bg-white p-5">
								<Skeleton className="h-4 w-full" />
								<Skeleton className="h-4 w-11/12" />
								<Skeleton className="h-4 w-4/5" />
							</div>
						)
					)}
					{previewKind === "unsupported" && (
						<div className="flex flex-col items-center gap-3 px-6 text-center">
							<FileWarning className="h-10 w-10 text-neutral-400" />
							<p className="text-sm text-neutral-600">
								{t("attachment.unsupported")}
							</p>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
