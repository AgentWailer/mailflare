export type RuleCondition={field:"email"|"sender"|"recipient"|"title"|"content";operator:"contains"|"exact"|"starts_with"|"ends_with";value:string;negate:boolean};
export type RuleFolder = {
	id: string;
	name: string;
	parentId?: string | null;
};

export type InboxRule = {
	id: string;
 enabled:boolean;conditions:string;conditionMode:"all"|"any";labelIds:string;category:"primary"|"promotions"|"social"|"invoices"|"orders"|null;skipInbox:boolean;
	pattern: string;
	matchField: "email" | "sender" | "recipient" | "content" | "title";
	matchOperator: "contains" | "exact" | "starts_with" | "ends_with";
	matchValue: string;
	action: "store" | "forward" | "reject" | "spam" | "trash";
	folderId: string | null;
	priority: number;
	forwardTo: string | null;
};

export type InboxRuleInput = {
 enabled?:boolean;conditions?:RuleCondition[];conditionMode?:"all"|"any";labelIds?:string[];category?:"primary"|"promotions"|"social"|"invoices"|"orders";skipInbox?:boolean;
	mailboxId: string;
	matchField: "email" | "sender" | "recipient" | "content" | "title";
	matchOperator: "contains" | "exact" | "starts_with" | "ends_with";
	matchValue: string;
	destination: string;
	priority: number;
	forwardTo?: string;
	sourceMessageId?: string;
};

export type InboxRuleSource = { id: string; mailboxId: string; fromAddr: string; subject?: string | null };

export type InboxRulesResponse = {
	rules: InboxRule[];
	error?: string;
};

export type RuleFoldersResponse = {
	folders: RuleFolder[];
	error?: string;
};
