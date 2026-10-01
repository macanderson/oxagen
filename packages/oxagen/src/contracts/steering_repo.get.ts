import { z } from "zod";
import { registerCapability } from "../registry";
import { REPO_HEALTH_STATES } from "../steering-repo/health";
import { steeringRepoProvisionStatus } from "./workspace.create";

/**
 * The provisioning steps, in the order the job runs them. A contract cannot
 * import a handler, so this copies `STEERING_REPO_STEPS` from
 * packages/handlers/src/steering_repo.provision.ts, and the handler's test
 * pins the two lists equal.
 */
export const STEERING_REPO_STEP_NAMES = [
  "pick_connection",
  "create_repository",
  "add_to_installation",
  "write_first_commit",
  "apply_settings",
  "register_webhook",
  "publish_version",
  "bind_repository",
] as const;

export const steeringRepoStep = z.enum(STEERING_REPO_STEP_NAMES);

/**
 * What the read answers for provisioning: the job's own states, plus
 * `not_started` for a workspace that never recorded one. `create_workspace`
 * answers the job's states alone, so this enum stays separate from
 * `steeringRepoProvisionStatus`.
 */
export const steeringRepoReadStatus = z.enum([
  "not_started",
  ...steeringRepoProvisionStatus.options,
]);

/**
 * A GitHub organization or a GitLab group the owner's tokens reach, which
 * setup could create steering repos in. `id` is the GitHub installation id or
 * the GitLab group id.
 */
export const steeringConnectionChoice = z.object({
  provider: z.enum(["github", "gitlab"]),
  id: z.number().int().positive(),
  name: z
    .string()
    .min(1)
    .describe("The GitHub organization's login or the GitLab group's path."),
});

/**
 * The connection a person picks when setup stopped with `choose_connection`.
 * It must be one of the choices `get_steering_repo` lists.
 */
export const steeringConnectionPick = z
  .object({
    provider: z.enum(["github", "gitlab"]),
    id: z.number().int().positive(),
  })
  .strict();

/** One prescribed setting that differs, with both values rendered as text. */
export const steeringRepoDifference = z.object({
  setting: z
    .string()
    .min(1)
    .describe("The setting's path in the baseline, such as rulesets.oxagen_merges."),
  expected: z.string().describe("The prescribed value, rendered as text."),
  actual: z.string().describe("The value the host reports, rendered as text."),
  changedBy: z
    .string()
    .nullable()
    .describe("The login the host names for the change, or null."),
  changedAt: z
    .string()
    .nullable()
    .describe("When the host says the change happened, as ISO 8601, or null."),
});

export const steeringRepoView = z.object({
  status: steeringRepoReadStatus,
  step: steeringRepoStep
    .nullable()
    .describe("The last provisioning step that finished, or null before the first."),
  failedStep: steeringRepoStep
    .nullable()
    .describe("The step that failed or stopped, or null."),
  error: z
    .object({ code: z.string(), message: z.string() })
    .nullable()
    .describe(
      "Why the step failed or stopped. The code steering_reauthorize asks an organization owner to authorize the Oxagen GitHub App again.",
    ),
  provider: z.enum(["github", "gitlab"]).nullable(),
  repository: z
    .object({ fullName: z.string(), url: z.string().url() })
    .nullable()
    .describe("The repository, or null until create_repository finishes."),
  publishedVersion: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("The published steering version, or null before publish_version finishes."),
  health: z
    .enum(REPO_HEALTH_STATES)
    .nullable()
    .describe("The settings health, or null before the first health read."),
  differences: z.array(steeringRepoDifference),
  legacySource: z
    .object({
      fullName: z.string(),
      url: z.string().url(),
      provider: z.enum(["github", "gitlab"]),
    })
    .nullable()
    .describe(
      "The code repository that still steers the workspace through its .oxagen/ tree, or null. import_workspace_steering moves it to a steering repo when it is on GitHub, and refuses one on GitLab.",
    ),
  connectionChoices: z
    .array(steeringConnectionChoice)
    .describe(
      "The GitHub organizations and GitLab groups to choose from when setup stopped with choose_connection. Empty otherwise.",
    ),
});

/**
 * get_steering_repo: the workspace's steering repo as the Repositories card,
 * the health banner, and onboarding show it (steering-repo-spec,
 * Provisioning and Settings drift; lane S2, #4560).
 *
 * The answer joins three records. Provisioning state comes from the
 * workspace's `steering_repo` setting. The published version comes from the
 * steering publication, or is version 1 once provisioning recorded it. Health
 * and the differing settings come from the last health read.
 *
 * A workspace whose provisioning has not recorded any state answers
 * `not_started` with every other provisioning field null and no differences,
 * so every page that shows the banner keeps rendering and no page draws a
 * step as running that no job runs. `legacySource` names the code repository
 * that still steers a workspace made before steering repos existed.
 */
export const steeringRepoGet = registerCapability({
  name: "get_steering_repo",
  domain: "repository",
  description:
    "Read the workspace's steering repo: its provisioning status and step, the repository, the published version, its settings health, and each setting that differs.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
      Compliance: "allow",
    },
  },
  agent: { requiresApproval: false, riskLevel: "low", category: "vcs" },
  input: z.object({}).strict(),
  output: steeringRepoView,
});

export type SteeringRepoGetOutput = z.output<typeof steeringRepoGet.output>;
export type SteeringRepoDifference = z.output<typeof steeringRepoDifference>;
