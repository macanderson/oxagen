// Fixed destinations inside the sign-in flows. Kept out of actions.ts: a
// "use server" module may export only async functions.

/** Where a brand-new account goes: create its organization (ARCHITECTURE.md §1.2). */
export const AFTER_SIGNUP = "/new-organization";
