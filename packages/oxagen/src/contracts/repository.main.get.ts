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
 *   - `github.connectUrl` / `github.installUrl` / `github.manageUrl`: the
 *     three doors to GitHub, which are three different doors and not one worn
 *     three ways. CONNECT is the identity leg, for an account that already
 *     carries the App. INSTALL is `installations/new`, for an account that does
 *     not. Both carry the API's HMAC-signed state naming this org and
 *     workspace, so the callback can attach the installation to the workspace
 *     that asked for it and to no other, and both expire. MANAGE is the App's
 *     configuration page for an installation already attached, and is unsigned
 *     because it starts no flow. All three are null when this deployment cannot
 *     complete a connect round trip.
 *
 *     The install door was the unsigned manage URL until #3254, so a first-ever
 *     install — the primary first-run path for every new customer — round-
 *     tripped no state, hit the callback's no-state branch, attached nothing,
 *     and left the person on the app root with the workspace unconnected.
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
          /** The host: a GitHub repository or a gitlab.com project (#3762). */
          provider: z.enum(["github", "gitlab"]),
          owner: z.string().min(1),
          name: z.string().min(1),
          /** `owner/name` as GitHub reports it. */
          fullName: z.string().min(1),
          /** The branch `.oxagen/` is read from unless a context branch overrides it. */
          defaultRef: z.string().min(1),
          htmlUrl: z.string().url(),
          boundAt: z.string().datetime({ offset: true }),
          /**
           * The GitHub connection this binding hangs off is still live — not
           * soft-deleted, and not left at `status = 'deleting'` by
           * `delete_connection` for a purge that has not run yet.
           *
           * False is a reachable and unrecoverable-looking state, not a
           * theoretical one. Delete the workspace's GitHub connection and
           * reconnect: the delete leaves the old row at `deleting`, so the
           * install callback's attach — which only ever sees live rows — has to
           * insert a NEW connection, while the binding head still points at the
           * retired one. `readGitHubConnection` joins head → binding →
           * connection and filters exactly those statuses, so from that moment
           * it resolves nothing and steering and Context PRs are off, silently.
           *
           * It is reported rather than hidden because the repository is still
           * the one the workspace binds and the person has to be told which it
           * is. `bind_main_repository` is the repair: re-binding the SAME
           * repository supersedes the binding onto the live connection and
           * moves the head with it (changing to a DIFFERENT repository stays
           * `conflict: main_repo_bound`, an org owner's decision, spec §10.1).
           */
          connectionLive: z.boolean(),
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
           * CONNECT — the identity leg: GitHub's user-authorization URL
           * (`login/oauth/authorize`) carrying the API's HMAC-signed state.
           * It ALWAYS round-trips a fresh `code` and our state, installed or
           * not, so it is the door for an account that already carries the App
           * somewhere: the callback exchanges the code, asks
           * `GET /user/installations` what this person reaches, and attaches
           * the one it finds. It never returns an `installation_id`, so it
           * cannot by itself put the App on an account that lacks it.
           *
           * Null when this deployment cannot complete the round trip (any of
           * the App's client id, client secret, slug or state secret unset) —
           * the handler returns no door rather than one the callback answers
           * with 503. All three URLs are null together.
           */
          connectUrl: z.string().url().nullable(),
          /**
           * INSTALL — `installations/new`, SIGNED with the same state the
           * connect leg carries. This is the first-run door: the account has
           * the App nowhere, so there is nothing for `/user/installations` to
           * find and the identity leg alone would loop.
           *
           * Signed, not bare. The unsigned form round-trips nothing, so the
           * callback took its no-state branch, attached nothing, and dropped
           * the person on the app root at `/?github_installed=1` — workspace
           * still unconnected, with no way back but to guess. With the state
           * here the callback knows which org and workspace asked, and lands
           * them on the dialog either attached or told what to click next.
           *
           * What comes back still depends on the App's "request user
           * authorization (OAuth) during installation" setting, which is
           * external configuration: with it, GitHub returns `code` + state +
           * `installation_id` and the callback verifies the id against the
           * authorizing user's own `/user/installations` before attaching
           * anything. Without it there is no `code`, so nothing can testify
           * that this person reaches the installation the query names — and an
           * unverifiable claim is no claim, so nothing is attached and the
           * dialog is told to finish through the connect door.
           */
          installUrl: z.string().url().nullable(),
          /**
           * MANAGE — the App's own configuration page for an installation that
           * is already attached: change which repositories it reaches, or put
           * it on a further account. Unsigned on purpose, because it starts no
           * flow and carries nothing back; never offer it as the way to
           * establish a connection.
           */
          manageUrl: z.string().url().nullable(),
        })
        .strict(),
    })
    .strict(),
});

export type RepositoryMainGetInput = z.output<typeof repositoryMainGet.input>;
export type RepositoryMainGetOutput = z.output<typeof repositoryMainGet.output>;
