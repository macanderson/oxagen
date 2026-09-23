/**
 * A GitHub App installation token for one governed repository, minted for an
 * enrolled Tacho daemon. Its Git proxy keeps the installation token and
 * gives git a local session lease instead (ADR-151). Machine-to-machine,
 * authenticated by the host's API key.
 *
 * The host names the repository by `owner/name` because that is all git hands
 * its credential helper. The handler answers only for a repository bound to
 * the host's workspace, and scopes the token to that repository's immutable
 * id, so a caller cannot widen it by naming another repository.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { hostEnrollmentIdSchema } from "../tacho/schemas";

/** GitHub's own limits: an owner is 1–39 of `[A-Za-z0-9-]`, a name 1–100. */
const githubOwnerSchema = z.string().regex(/^[A-Za-z0-9-]{1,39}$/);
const githubRepoNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/)
  .refine((name) => name !== "." && name !== "..");

export const tachoGithubTokenIssue = registerCapability({
  name: "issue_tacho_github_token",
  domain: "tacho",
  description:
    "Mint a GitHub App installation token scoped to one repository bound to an enrolled Tacho host's workspace.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      host_enrollment_id: hostEnrollmentIdSchema,
      owner: githubOwnerSchema,
      name: githubRepoNameSchema,
      /** The run token the host minted for this credential, for the audit trail. */
      run_token_id: z.string().regex(/^rt_[0-9a-f]{20}$/),
    })
    .strict(),
  output: z
    .object({
      token: z.string().min(1),
      /** GitHub's own expiry, ISO-8601. Always about an hour after the mint. */
      expires_at: z.string().datetime(),
      repository: z
        .object({
          owner: z.string().min(1),
          name: z.string().min(1),
          full_name: z.string().min(1),
          role: z.enum(["main", "linked"]),
        })
        .strict(),
    })
    .strict(),
});

export type TachoGithubTokenIssueInput = z.output<
  typeof tachoGithubTokenIssue.input
>;
export type TachoGithubTokenIssueOutput = z.output<
  typeof tachoGithubTokenIssue.output
>;
