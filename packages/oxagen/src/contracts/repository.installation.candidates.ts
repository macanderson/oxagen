/**
 * `list_github_installations`: the GitHub App installations this workspace
 * could attach, read from the GitHub user token the connect leg stored.
 *
 * Why it exists. The Workspace settings dialog connects GitHub through the
 * IDENTITY url (`login/oauth/authorize`), because `installations/new` only
 * round-trips a `code` and our signed state on the FIRST install of the App on
 * an account — so reconnecting, and connecting a second workspace to an
 * account that already has the App, both dead-ended at the callback's no-state
 * branch. The identity leg fixed that and introduced its own gap: it always
 * returns a `code` and never an `installation_id`. A person authorizing from a
 * machine whose account already has the App came back holding a token, with
 * `github.connected` still false and one button to press that would do the
 * same thing again.
 *
 * The callback closes most of that itself — it lists the authorizing user's
 * installations and attaches the one, when there is exactly one. What it
 * cannot do is choose: a person who administers two accounts that both have
 * the App must say which one this workspace acts through. This read is that
 * choice, and `attach_github_installation` is the write that settles it.
 *
 * The ids in this output are not a handle anyone gains by reading it. Every
 * row comes from `GET /user/installations` answered for this workspace's own
 * stored token — GitHub showing a person their own installations — and the
 * attach re-asks that same list before it persists anything. This is the one
 * place an installation id is spoken out loud, and it is spoken only to the
 * account that owns it. `get_main_repository` still withholds the ATTACHED id
 * for the same reason it always did: nothing on screen needs it.
 *
 * A workspace whose org has never completed a GitHub authorization has no
 * token to ask with, and that is `conflict: github_not_authorized` — connect
 * GitHub first. An empty list is not a refusal: it is the honest answer for an
 * account that has authorized Oxagen and installed the App nowhere, and the
 * surface answers it with the install door.
 *
 * Roles: org Owner or Admin, checked by the handler (INV-29) — the pair that
 * may attach and bind. A settings read: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const repositoryInstallationCandidates = registerCapability({
  name: "list_github_installations",
  domain: "repository",
  description:
    "The GitHub App installations the workspace's stored GitHub authorization can reach, the set attach_github_installation will accept.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({}).strict(),
  output: z
    .object({
      installations: z.array(
        z
          .object({
            /**
             * GitHub's numeric installation id as text — the value
             * `attach_github_installation` takes, and which it re-verifies
             * against this same list before persisting it.
             */
            installationId: z.string().regex(/^[1-9]\d{0,19}$/),
            /** The account the App is installed on, as a person names it. */
            accountLogin: z.string().min(1),
            /** `User` or `Organization`; null when GitHub reported none. */
            accountType: z.string().min(1).nullable(),
            /** The account's avatar, so two similar logins are tellable apart. */
            avatarUrl: z.string().url().nullable(),
            /** `all` or `selected` — whether the App reaches every repository on the account. */
            repositorySelection: z.string().min(1).nullable(),
          })
          .strict(),
      ),
    })
    .strict(),
});

export type RepositoryInstallationCandidatesInput = z.output<
  typeof repositoryInstallationCandidates.input
>;
export type RepositoryInstallationCandidatesOutput = z.output<
  typeof repositoryInstallationCandidates.output
>;
