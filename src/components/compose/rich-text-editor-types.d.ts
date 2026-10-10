import type { TranslationKey } from "@/lib/i18n/types";
export type RichTextEditorProps = {
	id: string;
	/** Mailbox authorizing AI text refinement; omit outside the mail composer. */
	mailboxId?: string | null;
	/** Editable HTML. */
	value: string;
	onChange: (html: string) => void;
	/** Quoted or forwarded HTML shown folded under the editable area. */
	quotedHtml?: string | null;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
	toolbarStart?: React.ReactNode;
	toolbarEnd?: React.ReactNode;
	footerContent?: React.ReactNode;
	/** Block sending while the user reviews an uncommitted suggestion. */
	onRefineActiveChange?: (active: boolean) => void;
};

export type ToolbarCommand = {
	command: string;
	labelKey: TranslationKey;
	icon: React.ComponentType<{ className?: string }>;
	value?: string;
};
