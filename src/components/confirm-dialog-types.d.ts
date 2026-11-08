export type ConfirmOptions = {
	/** The question, phrased so it can stand alone. */
	title: string;
	/** Consequences the visitor should weigh before confirming. */
	description?: string;
	/** Names the action, e.g. "Delete forever"; never a bare "OK". */
	confirmLabel: string;
	cancelLabel?: string;
	destructive?: boolean;
};
