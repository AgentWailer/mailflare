export type FolderListItem = {
	id: string;
	userId: string;
	mailboxId: string;
	name: string;
	parentId: string | null;
	color: string;
	createdAt: Date;
};
