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
