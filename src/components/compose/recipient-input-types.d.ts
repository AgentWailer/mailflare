import type { RecipientCandidate } from "@/lib/contacts/recipient-directory-types";
import type { RecipientField } from "./recipient-utils";

export type RecipientMoveTarget = { field: RecipientField; label: string };

export type RecipientInputProps = {
	id: string;
	label: string;
	value: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
	disabled?: boolean;
	required?: boolean;
	/** Focus the field when it first appears, e.g. after the Cc/Bcc toggle reveals it. */
	autoFocus?: boolean;
	/** Rendered at the right edge of the row, e.g. the Cc/Bcc toggles. */
	trailing?: React.ReactNode;
	/** Id of the inline error that explains why the field is invalid. */
	errorId?: string;
	/** Which line this is; marks the row and its chips for dragging between lines. */
	field?: RecipientField;
	/** Ranked address book that suggestions are taken from while typing. */
	directory?: readonly RecipientCandidate[];
	/** Addresses already on the message (any line), lower-cased; never suggested again. */
	chosen?: ReadonlySet<string>;
	/** The other lines a chip can be moved to from its menu. */
	moveTargets?: readonly RecipientMoveTarget[];
	onMove?: (entry: string, to: RecipientField) => void;
	/** Where a dragged chip would land in this line, or null when it is not over it. */
	dropIndex?: number | null;
	/** The chip being dragged, shown dimmed in its line. */
	draggingEntry?: string | null;
};

export type RecipientFieldsProps = {
	idPrefix: string;
	to: string[];
	cc: string[];
	bcc: string[];
	onChange: (next: { to: string[]; cc: string[]; bcc: string[] }) => void;
	showCc: boolean;
	showBcc: boolean;
	onShowCc: () => void;
	onShowBcc: () => void;
	disabled?: boolean;
	directory?: readonly RecipientCandidate[];
	/** Placeholder of the To line; shorter on phones. */
	toPlaceholder?: string;
	/** Why a line was refused when sending; shown under that line. */
	error?: { field: RecipientField; message: string } | null;
};
