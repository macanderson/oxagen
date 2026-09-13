// Fixed destinations inside the sign-in flows. Kept out of actions.ts: a
// "use server" module may export only async functions.

/** Where a brand-new account goes: the onboarding gate (spec §4.4). */
export const AFTER_SIGNUP = "/welcome";
