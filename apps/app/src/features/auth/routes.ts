// Fixed destinations inside the sign-in flows, shared by the forms and the
// browser-side Better Auth calls in auth-client.ts.
import { routes } from "@/shared/safe-path";

/** Where a brand-new account goes: create its organization (ARCHITECTURE.md §1.2). */
export const AFTER_SIGNUP = routes.newOrganization();
