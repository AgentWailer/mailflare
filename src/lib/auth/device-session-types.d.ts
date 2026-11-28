export type AppSignInUser = {
	id: string;
	email: string;
	name: string;
	role: string;
};

export type AppSignInResult = {
	token: string;
	user: AppSignInUser;
};

/** A device signed in to an account, as its owner sees it. Never carries the token or its hash. */
export type SignedInDevice = {
	id: string;
	name: string;
	signedInAt: string;
	lastUsedAt: string | null;
	/** True for the device that is asking. */
	current: boolean;
};
