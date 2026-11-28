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
