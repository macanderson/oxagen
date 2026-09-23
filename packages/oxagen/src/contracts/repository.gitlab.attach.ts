/**
 * `attach_gitlab_project`: connect one gitlab.com project to the workspace
 * with a project access token (#3762).
 *
 * A GitLab token is not a GitHub App installation, so this is its own connect
 * flow rather than an arm of `attach_github_installation`. What it proves
 * before it stores anything:
 *
 * - The token is live: GitLab answers it, and reports it active and not
 *   revoked.
 * - The token is a PROJECT access token for THIS project. GitLab gives each
 *   project access token a bot user named `project_<id>_bot…`, so a personal
 *   token, a group token, or another project's token is refused
 *   (`gitlab_token_not_project_scoped`). A personal token would let the
 *   workspace act as a person on every project that person can reach.
 * - The token carries the `api` scope, which merge requests and commit
 *   statuses need, and no administrative scope (`gitlab_token_scope`).
 *
 * The token and a fresh webhook secret are envelope-encrypted into one
 * credential row. Nothing returns either. Connecting the same project again
 * rotates the stored token on the existing connection. Disconnecting is
 * `delete_connection`; from that moment steering refuses, because every
 * GitLab read joins the live connection.
 *
 * Oxagen then registers a project webhook for merge request events, signed
 * with the webhook secret. Registering needs the Maintainer role; a token
 * without it still connects and `webhook.status` says `refused`.
 *
 * Self-managed GitLab is not supported: every call goes to gitlab.com until a
 * host setting and an outbound-network review exist.
 *
 * Roles: org Owner or Admin, checked by the handler (INV-29), so the caller is
 * a signed-in user and the surface is the API only.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * A gitlab.com project path: a namespace of one or more groups and the
 * project, `group/sub/project`. The handler validates each segment with
 * `parseGitLabProjectPath`; this is the outer bound.
 */
export const gitlabProjectPathSchema = z
  .string()
  .min(3)
  .max(1024)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/);

export const repositoryGitlabAttach = registerCapability({
  name: "attach_gitlab_project",
  domain: "repository",
  description:
    "Connect a gitlab.com project to the workspace with a project access token scoped to that project. The token is verified, encrypted and never returned; a project webhook for merge request events is registered when the token's role allows it. Connecting the same project again rotates the token.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
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
      /** `group/sub/project` on gitlab.com. */
      projectPath: gitlabProjectPathSchema,
      /** A project access token for that project. Stored encrypted. */
      token: z.string().min(20).max(255).regex(/^\S+$/),
    })
    .strict(),
  output: z
    .object({
      connectionId: z.string().regex(/^con_[0-9a-z]+$/),
      /** GitLab's numeric project id, as text. */
      projectId: z.string().regex(/^[1-9]\d{0,19}$/),
      /** `group/sub/project` as GitLab reports it. */
      fullName: z.string().min(1),
      /** The project's default branch, which a bind approves. */
      defaultRef: z.string().min(1),
      /** When GitLab expires the token, or null when it never does. */
      tokenExpiresAt: z.string().nullable(),
      /** True when this call replaced the token on an existing connection. */
      rotated: z.boolean(),
      webhook: z
        .object({
          /**
           * `registered`: GitLab delivers merge request events to Oxagen.
           * `refused`: the token's role cannot manage webhooks.
           * `unchanged`: a rotation kept the webhook already registered.
           */
          status: z.enum(["registered", "refused", "unchanged"]),
        })
        .strict(),
    })
    .strict(),
});

export type RepositoryGitlabAttachInput = z.output<
  typeof repositoryGitlabAttach.input
>;
export type RepositoryGitlabAttachOutput = z.output<
  typeof repositoryGitlabAttach.output
>;
