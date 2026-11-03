"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff, LockKeyhole, Minus, Plus, ScanLine } from "lucide-react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { authFetch } from "@/lib/auth/client";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type PasswordStatus = "required" | "incorrect" | "checking";

function PdfPasswordForm({ status, onSubmit, onCancel }: { status: PasswordStatus; onSubmit: (password: string) => void; onCancel: () => void }) {
	const { t } = useLanguage();
	const id = useId(), input = useRef<HTMLInputElement>(null);
	const [visible, setVisible] = useState(false);
	const checking = status === "checking";
	useEffect(() => {
		if (!checking) input.current?.focus({ preventScroll: true });
	}, [checking]);
	return <form data-pdf-password className="mx-auto my-6 w-full max-w-md space-y-4 rounded-2xl border border-neutral-200 bg-white p-5 text-sm text-neutral-800" aria-busy={checking} onSubmit={event => {
		event.preventDefault();
		if (checking || !input.current?.value) return;
		// Keep the secret out of React state, URLs and storage; hand it straight to PDF.js.
		const password = input.current.value;
		input.current.value = "";
		setVisible(false);
		onSubmit(password);
	}}>
		<LockKeyhole className="h-7 w-7 text-neutral-500" aria-hidden="true" />
		<h2 className="text-lg font-semibold">{t("attachment.pdfPasswordTitle")}</h2>
		<p id={`${id}-hint`} className="text-neutral-600">{t("attachment.pdfPasswordHint")}</p>
		<div className="space-y-2">
			<label htmlFor={id} className="block font-medium">{t("attachment.pdfPassword")}</label>
			<div className="relative">
				<Input ref={input} id={id} type={visible ? "text" : "password"} required autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={checking} aria-invalid={status === "incorrect"} aria-describedby={`${id}-hint${status === "incorrect" ? ` ${id}-error` : ""}`} className="h-11 pr-12 text-base" />
				<button type="button" disabled={checking} aria-label={t(visible ? "attachment.pdfHidePassword" : "attachment.pdfShowPassword")} onClick={() => setVisible(value => !value)} className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 disabled:opacity-50">{visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
			</div>
			{status === "incorrect" && <p id={`${id}-error`} role="alert" className="text-red-600">{t("attachment.pdfPasswordIncorrect")}</p>}
		</div>
		<p className="text-xs text-neutral-500">{t("attachment.pdfPasswordPrivacy")}</p>
		<div className="flex flex-wrap justify-end gap-2">
			<Button type="button" variant="outline" className="min-h-11" onClick={() => { if (input.current) input.current.value = ""; onCancel(); }}>{t("common.cancel")}</Button>
			<Button type="submit" disabled={checking} className="min-h-11">{t(checking ? "attachment.pdfUnlocking" : "attachment.pdfUnlock")}</Button>
		</div>
	</form>;
}

function PdfPage({ pdf, number, width, scroll }: { pdf: PDFDocumentProxy; number: number; width: number; scroll: HTMLDivElement | null }) {
	const { t } = useLanguage();
	const element = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
	const [nearby, setNearby] = useState(number === 1);
	const [ratio, setRatio] = useState(Math.SQRT2);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!element.current || !scroll) return;
		const observer = new IntersectionObserver(entries => setNearby(entries[0].isIntersecting), { root: scroll, rootMargin: "600px 0px" });
		observer.observe(element.current);
		return () => observer.disconnect();
	}, [scroll]);
	useEffect(() => {
		if (!nearby || !width || !canvas.current) return;
		let cancelled = false, render: RenderTask | undefined;
		const target = canvas.current, container = element.current!;
		delete container.dataset.pdfRendered;
		container.setAttribute("aria-busy", "true");
		void pdf.getPage(number).then(async page => {
			if (cancelled) return;
			setFailed(false);
			const base = page.getViewport({ scale: 1 });
			setRatio(base.height / base.width);
			const viewport = page.getViewport({ scale: width / base.width });
			// Bound high-DPI/zoom memory; off-screen pages release their canvases.
			const density = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
			target.width = Math.ceil(viewport.width * density);
			target.height = Math.ceil(viewport.height * density);
			render = page.render({ canvas: target, viewport, transform: [density, 0, 0, density, 0, 0], background: "white" });
			await render.promise;
			if (!cancelled) { container.dataset.pdfRendered = "true"; container.setAttribute("aria-busy", "false"); page.cleanup(); }
		}).catch(() => { if (!cancelled) { setFailed(true); container.setAttribute("aria-busy", "false"); } });
		return () => { cancelled = true; render?.cancel(); target.width = target.height = 0; delete container.dataset.pdfRendered; };
	}, [pdf, number, nearby, width]);
	return <div ref={element} data-pdf-page={number} aria-busy="true" className="relative shrink-0 bg-white shadow-sm" style={{ width, height: width * ratio }}>
		<canvas ref={canvas} role="img" aria-label={t("attachment.pdfPage", { page: number, total: pdf.numPages })} className="block h-full w-full" />
		{failed && <p role="alert" className="absolute inset-0 flex items-center justify-center p-4 text-sm text-neutral-700">{t("attachment.loadFailed")}</p>}
	</div>;
}

/** Browser-local rendering avoids iOS's clipped, single-page native PDF iframe. */
export default function PdfAttachmentPreview({ url, onClose }: { url: string; onClose: () => void }) {
	const { t } = useLanguage();
	const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
	const [scroll, setScroll] = useState<HTMLDivElement | null>(null), [width, setWidth] = useState(0), [zoom, setZoom] = useState(1);
	const [passwordStatus, setPasswordStatus] = useState<PasswordStatus | null>(null);
	const updatePassword = useRef<((password: string) => void) | null>(null);
	useEffect(() => {
		if (!scroll) return;
		const measure = () => setWidth(Math.max(0, scroll.clientWidth - 16));
		measure();
		const observer = new ResizeObserver(measure); observer.observe(scroll);
		return () => observer.disconnect();
	}, [scroll]);
	useEffect(() => {
		const controller = new AbortController();
		let cancelled = false, loading: PDFDocumentLoadingTask | undefined;
		void (async () => {
			// The matching legacy builds support browsers without recent Map upsert APIs
			// (Chrome <145, Safari <26.2). Both still load only when a PDF is opened.
			const [engine, worker, response] = await Promise.all([
				import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
				authFetch(url, { signal: controller.signal, cache: "no-store" }),
			]);
			if (cancelled) { await response.body?.cancel(); return; }
			if (!response.ok) throw new Error("Unable to load PDF");
			const data = new Uint8Array(await response.arrayBuffer());
			if (cancelled) return;
			engine.GlobalWorkerOptions.workerSrc = worker.default;
			const resources = `/_next/static/pdfjs-${engine.version}/`;
			loading = engine.getDocument({ data, enableXfa: false,
				cMapUrl: resources + "cmaps/", cMapPacked: true,
				standardFontDataUrl: resources + "standard_fonts/", wasmUrl: resources + "wasm/" });
			loading.onPassword = (update: (password: string) => void, reason: number) => {
				if (cancelled) return;
				updatePassword.current = update;
				setPasswordStatus(reason === engine.PasswordResponses.INCORRECT_PASSWORD ? "incorrect" : "required");
			};
			const document = await loading.promise;
			if (!cancelled) { updatePassword.current = null; setPasswordStatus(null); setPdf(document); }
		})().catch(() => { if (!cancelled) { updatePassword.current = null; setPasswordStatus(null); setError(true); } });
		return () => { cancelled = true; updatePassword.current = null; controller.abort(); void loading?.destroy().catch(() => undefined); };
	}, [url, attempt]);
	return <div data-pdf-preview className="flex h-full min-h-0 w-full flex-col">
		<div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-2 text-sm">
			<span className="min-w-0 truncate text-neutral-600" aria-live="polite">{pdf ? t("attachment.pdfPages", { total: pdf.numPages }) : t(error ? "attachment.loadFailed" : passwordStatus ? "attachment.pdfPasswordTitle" : "nav.loadingPage")}</span>
			<div className="flex shrink-0 items-center">
				<button type="button" aria-label={t("attachment.zoomOut")} disabled={!pdf || zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - .25))} className="flex h-11 w-11 items-center justify-center rounded-lg disabled:opacity-30"><Minus className="h-4 w-4" /></button>
				<button type="button" aria-label={t("attachment.fitWidth")} disabled={!pdf} onClick={() => setZoom(1)} className="flex h-11 items-center justify-center gap-1 rounded-lg px-2 disabled:opacity-30"><ScanLine className="h-4 w-4" /><span className="tabular-nums">{Math.round(zoom * 100)}%</span></button>
				<button type="button" aria-label={t("attachment.zoomIn")} disabled={!pdf || zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + .25))} className="flex h-11 w-11 items-center justify-center rounded-lg disabled:opacity-30"><Plus className="h-4 w-4" /></button>
			</div>
		</div>
		<div ref={setScroll} data-pdf-scroll className="min-h-0 flex-1 overflow-auto overscroll-contain bg-neutral-200 pb-[max(8px,env(safe-area-inset-bottom))]">
			{passwordStatus ? <div className="px-3"><PdfPasswordForm status={passwordStatus} onCancel={onClose} onSubmit={password => {
				const update = updatePassword.current;
				if (!update) return;
				// One callback per attempt prevents double submissions; wrong passwords
				// supply a fresh callback without fetching or parsing a new attachment.
				updatePassword.current = null;
				setPasswordStatus("checking");
				update(password);
			}} /></div> : error ? <div role="alert" className="space-y-3 p-6 text-center text-sm"><p>{t("attachment.loadFailed")}</p><button type="button" className="min-h-11 rounded-xl border border-neutral-300 px-4" onClick={() => { setPdf(null); setError(false); setAttempt(value => value + 1); }}>{t("message.retry")}</button><a href={url} target="_blank" rel="noopener noreferrer" className="mx-2 inline-flex min-h-11 items-center rounded-xl border border-neutral-300 px-4">{t("attachment.openSeparately")}</a></div> : pdf && width > 0 ?
				<div className="mx-auto flex min-w-full flex-col items-center gap-2 p-2" style={{ width: width * zoom + 16 }}>
					{Array.from({ length: pdf.numPages }, (_, index) => <PdfPage key={index} pdf={pdf} number={index + 1} width={width * zoom} scroll={scroll} />)}
				</div> : <div role="status" className="p-6 text-center text-sm text-neutral-600">{t("nav.loadingPage")}</div>}
		</div>
	</div>;
}
