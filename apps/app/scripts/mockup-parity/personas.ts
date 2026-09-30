// The people the mockup parity audit views the app as (#4818). CI-only audit
// tooling: `seed-personas.ts` creates these accounts and memberships after
// `seed:e2e`, and `capture.ts` signs in as each one. Nothing under `src/`
// imports this file (INV-07, INV-22), and it is not an e2e spec (INV-20).
//
// The keys and roles come from the page registry's `personas` list,
// `mockups/pages/pages.json` in macanderson/oxagen-roadmap. The design names
// each persona by the role it holds in the design's organization and in its
// Core platform workspace. Here that is e2e-org and its workspace `core`.
//
// This module imports no platform package, so the capture and its unit test
// load it without a database.
import path from "node:path";
import { z } from "zod";
import { AUTH_DIR } from "../../e2e/support";

/** A persona key in the registry. */
export type PersonaKey =
  | "marcus"
  | "priya"
  | "amara"
  | "dana"
  | "jordan"
  | "admin"
  | "compliance"
  | "guest"
  | "outsider"
  | "anonymous";

/** An organization role as `org_users.role` stores it, lowercased. */
export type OrgRole = "owner" | "admin" | "member" | "billing" | "compliance";

/** A workspace role as `workspace_users.role` stores it, lowercased. */
export type WorkspaceRole = "owner" | "member" | "viewer";

export type Persona = {
  readonly key: PersonaKey;
  /** The display name the design gives this persona. */
  readonly name: string;
  /** The sign-in email, or null for the persona with no account. */
  readonly email: string | null;
  /** The role in e2e-org, or null when the persona is not a member of it. */
  readonly orgRole: OrgRole | null;
  /** The role in workspace `core`, or null when not a member of it. */
  readonly workspaceRole: WorkspaceRole | null;
};

/**
 * The one password every persona signs in with. Like `SEED.password`, it
 * exists only in the CI database the audit seeds, and it meets the password
 * policy (12 characters, a digit, and a symbol).
 */
export const PERSONA_PASSWORD = "e2e-persona-password-1";

/** A persona's sign-in address, on the domain the build scan refuses. */
function personaEmail(key: PersonaKey): string {
  return `${key}@e2e.oxagen.test`;
}

/** Every persona in the registry, in the registry's order. */
export const PERSONAS: readonly Persona[] = [
  {
    key: "marcus",
    name: "Marcus Bell",
    email: personaEmail("marcus"),
    orgRole: "member",
    workspaceRole: "owner",
  },
  {
    key: "priya",
    name: "Priya Natarajan",
    email: personaEmail("priya"),
    orgRole: "owner",
    workspaceRole: "member",
  },
  {
    key: "amara",
    name: "Amara Lindqvist",
    email: personaEmail("amara"),
    orgRole: "member",
    workspaceRole: "member",
  },
  {
    key: "dana",
    name: "Dana Okafor",
    email: personaEmail("dana"),
    orgRole: "billing",
    workspaceRole: "viewer",
  },
  {
    key: "jordan",
    name: "Jordan Reyes",
    email: personaEmail("jordan"),
    orgRole: "member",
    // The design gives Jordan a fourth workspace role, code graph admin. This
    // app has no such role (workspace roles are Owner, Member, and Viewer), so
    // Jordan is a workspace Member here, and the missing role is itself a
    // finding on the pages that need it.
    workspaceRole: "member",
  },
  {
    key: "admin",
    name: "Org admin",
    email: personaEmail("admin"),
    orgRole: "admin",
    workspaceRole: "member",
  },
  {
    key: "compliance",
    name: "Compliance officer",
    email: personaEmail("compliance"),
    orgRole: "compliance",
    workspaceRole: null,
  },
  {
    // An organization Member in no workspace of it. The design draws its
    // denied page ("You cannot see this workspace") for this person, and the
    // app answers its workspace denied page.
    key: "guest",
    name: "Workspace outsider",
    email: personaEmail("guest"),
    orgRole: "member",
    workspaceRole: null,
  },
  {
    // Signed in, and a member of another organization only: the owner of
    // OUTSIDE_ORG, with no membership in e2e-org. The app answers it with
    // the root not-found page.
    key: "outsider",
    name: "Outsider",
    email: personaEmail("outsider"),
    orgRole: null,
    workspaceRole: null,
  },
  {
    key: "anonymous",
    name: "Signed out",
    email: null,
    orgRole: null,
    workspaceRole: null,
  },
];

/** The persona with this key; undefined for a key this table lacks. */
export function personaByKey(key: string): Persona | undefined {
  return PERSONAS.find((persona) => persona.key === key);
}

/** The outsider's own organization and its one workspace. */
export const OUTSIDE_ORG = {
  slug: "e2e-outside",
  name: "E2E Outside",
  workspaceSlug: "home",
  workspaceName: "Home",
} as const;

/** The second workspace of e2e-org: marcus owns it, and it holds nothing. */
export const EMPTY_WORKSPACE = { slug: "empty", name: "Empty" } as const;

/**
 * The seeded invitations the `invite` page opens. The open one (`{token}`) is
 * for the outsider, so the outsider opening it is the right account and amara
 * is the wrong one. The expired (`{expiredToken}`) and declined
 * (`{declinedToken}`) ones are for addresses no account holds.
 */
export const INVITATIONS = {
  open: personaEmail("outsider"),
  expired: "expired-invitee@e2e.oxagen.test",
  declined: "declined-invitee@e2e.oxagen.test",
} as const;

/**
 * The placeholders a registry path can carry, without their braces. The
 * registry's `appPlaceholders` describes each one.
 */
export const PLACEHOLDERS = [
  "org",
  "ws",
  "run",
  "agent",
  "runtime",
  "mandate",
  "server",
  "operator",
  "record",
  "token",
  "step",
  "proposal",
  "tool",
  "email",
  "expiredToken",
  "declinedToken",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** Written by `seed:audit` beside `seed.json`, in the gitignored `e2e/.auth/`. */
export const PERSONAS_RECORD = path.join(AUTH_DIR, "personas.json");

/**
 * What `seed:audit` writes and `capture.ts` reads: the slugs, the value of
 * each placeholder it could seed, the reason for each it could not, and the
 * account behind each persona. The run's id is in `seed.json` (`SEED_RECORD`),
 * because `seed:e2e` mints it.
 */
export const personasRecordSchema = z.object({
  schema: z.literal(1),
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  emptyWorkspaceSlug: z.string().min(1),
  outsideOrgSlug: z.string().min(1),
  outsideWorkspaceSlug: z.string().min(1),
  values: z.partialRecord(z.enum(PLACEHOLDERS), z.string().min(1)),
  missing: z.partialRecord(z.enum(PLACEHOLDERS), z.string().min(1)),
  personas: z.record(
    z.string(),
    z.object({ email: z.string().min(1), userId: z.string().min(1) }),
  ),
});
export type PersonasRecord = z.infer<typeof personasRecordSchema>;

/** What `seed:e2e` writes to `seed.json`: the seeded run's public id. */
export const seedRecordSchema = z.object({ runPublicId: z.string().min(1) });
