import type { TranslationKey } from "@/lib/i18n/types";
import type { RefineReplyContext } from "@/lib/agent/refine-input";
export type RichTextEditorProps = {
	id: string;
	/** Mailbox authorizing AI text refinement; omit outside the mail composer. */
	mailboxId?: string | null;
	/** Editable HTML. */
	value: string;
	onChange: (html: string) => void;
	/** Quoted or forwarded HTML shown folded under the editable area. */
	quotedHtml?: string | null;
	/** Conversation used to suggest a reply when the editable body is empty. */
	replyContext?: RefineReplyContext;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
	toolbarStart?: React.ReactNode;
	toolbarEnd?: React.ReactNode;
	toolbarAttachment?: React.ReactNode;
	footerContent?: React.ReactNode;
	/** Block sending while an AI request is active. */
	onRefineActiveChange?: (active: boolean) => void;
};

export type ToolbarCommand = {
	command: string;
	labelKey: TranslationKey;
	icon: React.ComponentType<{ className?: string }>;
	value?: string;
};
