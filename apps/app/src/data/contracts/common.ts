// Shared view-model vocabulary, in the spec's vocabulary (spec App. A), never
// the mockup's strings. Only what a remaining page or primitive reads lives
// here; each page lane adds the vocabulary of the contracts it binds.
import { z } from "zod";

/** `org.org_users.role` (App. A.2). */
export const OrgRole = z.enum([
  "owner",
  "admin",
  "member",
  "billing",
  "compliance",
  "viewer",
]);
export type OrgRole = z.infer<typeof OrgRole>;

/**
 * A prefixed public id (`arun_…`, `apr_…`, `inv_…`, `usr_…`), the only id a
 * view model carries (INV-11): a raw database uuid never reaches the page.
 */
export const PublicId = z.string().regex(/^[a-z]+_[A-Za-z0-9]+$/);
