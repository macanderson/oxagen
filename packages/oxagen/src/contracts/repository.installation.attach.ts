/**
 * `attach_github_installation`: make one of the workspace's candidate GitHub
 * App installations the one it acts through.
 *
 * This is the write behind `list_github_installations`, and the two are one
 * decision: a person who administers several accounts that all carry the App
 * must say which of them this workspace reaches repositories through, because
 * `bind_main_repository` and `list_installation_repositories` both mint a
 * token with the platform App's private key against whatever installation the
 * workspace's GitHub connection names.
 *
 * That is exactly why the id here is checked rather than trusted. An
 * installation id names an account's source code, and the token minted through
 * it carries no caller entitlement at all — GitHub asks who the App is, not
 * who asked. So the id a caller supplies is matched against
 * `GET /user/installations` answered for this workspace's own stored GitHub
 * authorization before a single row is written, on exactly the rule the
 * HMAC-verified install callback applies to the `installation_id` GitHub
 * redirects with (apps/api/src/routes/v1/github-oauth.ts). An id that list does
 * not carry is `not_found: installation_unreachable`, whatever else is true of
 * it. Fail closed: a false refusal costs a click, a false acceptance costs
 * another tenant's repositories.
 *
 * It is idempotent by nature — attaching the installation a workspace already
 * acts through rewrites the same value — and it does not unbind anything. A
 * workspace that has already bound a main repository keeps it; the binding
 * pins a repository by GitHub's own numeric id, and moving a workspace to
 * another repository is `bind_main_repository`'s refusal to make.
 *
 * Roles: org Owner or Admin, checked by the handler (INV-29) — the pair that
 * may bind, because this is the first half of that write.
 * `noBillingGate: true`: a settings write that consumes no AI credits.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const repositoryInstallationAttach = registerCapability({
  name: "attach_github_installation",
  domain: "repository",
  description:
    "Make one of the workspace's reachable GitHub App installations the installation it acts through.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      /**
       * GitHub's numeric installation id as text, as
       * `list_github_installations` reported it. The shape is the one
       * `installationIdOf` accepts when the repository capabilities read it
       * back, so a value that would be silently skipped never reaches the row;
       * the shape is a pre-filter, not the check — reachability is.
       */
      installationId: z.string().regex(/^[1-9]\d{0,19}$/),
    })
    .strict(),
  output: z
    .object({
      /** The workspace's GitHub connection this installation now hangs off. */
      connectionId: z.string().regex(/^con_[0-9a-z]+$/),
      /**
       * The account the attached installation belongs to, so the surface can
       * name what it settled on. Null when GitHub reported the installation
       * without an account — rare, and not a reason to refuse an attach that
       * reachability has already allowed; the surface cites the id instead.
       */
      accountLogin: z.string().min(1).nullable(),
    })
    .strict(),
});

export type RepositoryInstallationAttachInput = z.output<
  typeof repositoryInstallationAttach.input
>;
export type RepositoryInstallationAttachOutput = z.output<
  typeof repositoryInstallationAttach.output
>;
