export type ContactAvatarProps = {
	mailboxId: string | null;
	address: string;
	name: string;
	hasManagedAvatar?: boolean;
	managedAvatarUrl?: string;
	fallbackAvatarUrl?: string;
	className?: string;
};
