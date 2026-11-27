export type AuthFetchOptions = RequestInit & {
	redirectOnUnauthorized?: boolean;
	/**
	 * This plain GET may be answered by the request the page started for the same address before the
	 * application loaded (`early-requests.ts`). Only for the first, unforced read of startup data.
	 */
	early?: boolean;
};

export type AuthSessionResponse = {
	ok?: boolean;
	token?: string;
	redirect?: string;
	error?: string;
};

export type AuthSessionChangedDetail = {
	authenticated: boolean;
};
