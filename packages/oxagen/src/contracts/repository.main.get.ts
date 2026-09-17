/**
 * `get_main_repository`: what the Workspace settings dialog needs to show, and
 * to unblock, the workspace's main repository (MC spec §10.1; #2967).
 *
 * The main repo is where `.oxagen/` lives — published steering, the promotion
 * ledger, and every agent definition (spec §10.2). A workspace has exactly one,
 * and until it is bound the workspace is provisional: runs record and spend
 * counts, but steering, records and agent definitions stay off.
 *
 * `bind_main_repository` is the write, and it refuses
 * `conflict: github_not_connected` unless the workspace already carries a
 * GitHub App installation. Nothing in the app could produce one: the install
 * leg is an HTTP flow the API runs (`/connections/github/auth-url` → GitHub →
 * the HMAC-verified callback), and no capability exposed it, so the only repo
 * a person could ever bind was the git remote the enrolling host happened to
 * report. This read closes that hole. It answers three things at once, because
 * they are three faces of one question — "can this workspace keep its steering
 * in git yet, and if not, what is the next click":
 *
 *   - `repository`: the bound main repo, or null while none is bound.
 *   - `github.connected`: whether an installation is attached, which is
 *     exactly the precondition `bind_main_repository` checks.
 *   - `github.installUrl` / `github.manageUrl`: the doors to GitHub. The
 *     Connect URL carries the API's HMAC-signed state naming this org and
 *     workspace, so the callback can attach the installation to the workspace
 *     that asked for it and to no other. It expires, and both are null when
 *     this deployment cannot complete a connect round trip.
 *
 * The installation id is deliberately NOT in the output. A caller that could
 * name an installation could mint tokens for another account's installation,
 * which is why the bind takes it from the connection rather than from input;
 * shipping it to a browser would hand back the same handle by another route.
 *
 * Roles: org Owner or Admin, checked by the handler (INV-29) — the same pair
 * the bind admits, because the install URL in this output is the first half of
 * that write. A settings read: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const repositoryMainGet = registerCapability({
  name: "get_main_repository",
  domain: "repository",
  description:
    "The workspace's main repository, whether a GitHub App installation is attached, and the signed URLs to connect GitHub or to change which repositories the installation reaches.",
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
      /** The bound main repo, or null while the workspace binds none. */
      repository: z
        .object({
          bindingId: z.string().regex(/^rpb_[0-9a-f]+$/),
          owner: z.string().min(1),
          name: z.string().min(1),
          /** `owner/name` as GitHub reports it. */
          fullName: z.string().min(1),
          /** The branch `.oxagen/` is read from unless a context branch overrides it. */
          defaultRef: z.string().min(1),
          htmlUrl: z.string().url(),
          boundAt: z.string().datetime({ offset: true }),
        })
        .strict()
        .nullable(),
      github: z
        .object({
          /**
           * An installation is attached to this workspace's GitHub connection.
           * False is exactly the state in which `bind_main_repository` answers
           * `conflict: github_not_connected`.
           */
          connected: z.boolean(),
          /**
           * The Connect action: GitHub's user-authorization URL
           * (`login/oauth/authorize`) carrying the API's HMAC-signed state.
           * NOT `installations/new` — that only round-trips a `code` and our
           * state on the FIRST install of the App on an account, so with it
           * here a reconnect, and a second workspace connecting to an account
           * that already has the App, both dead-ended at the callback's
           * no-state branch. Null when this deployment cannot complete the
           * round trip (any of the App's client id, client secret, slug or
           * state secret unset) — the handler returns no door rather than one
           * the callback answers with 503.
           */
          installUrl: z.string().url().nullable(),
          /** Change which repositories the existing installation reaches, and install it on a further account; null on the same condition as `installUrl`. */
          manageUrl: z.string().url().nullable(),
        })
        .strict(),
    })
    .strict(),
});

export type RepositoryMainGetInput = z.output<typeof repositoryMainGet.input>;
export type RepositoryMainGetOutput = z.output<typeof repositoryMainGet.output>;
