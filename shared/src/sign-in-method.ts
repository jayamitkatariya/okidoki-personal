const SIGN_IN_METHODS = ['google', 'apple', 'email'] as const;
export type SignInMethod = (typeof SIGN_IN_METHODS)[number];
export type OAuthSignInMethod = Exclude<SignInMethod, 'email'>;
