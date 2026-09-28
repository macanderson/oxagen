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
  "publish_version",
  "bind_repository",
] as const;

export const steeringRepoStep = z.enum(STEERING_REPO_STEP_NAMES);

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
  status: steeringRepoProvisionStatus,
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
      "Why the step failed or stopped. The code steering_reauthorize asks an organization owner to authorize Oxagen Steering again.",
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
 * `provisioning` with every other field null and no differences, so every
 * page that shows the banner keeps rendering.
 */
export const steeringRepoGet = registerCapability({
  name: "get_steering_repo",
  domain: "repository",
  description:
    "Read the workspace's steering repo: its provisioning status and step, the repository, the published version, its settings health, and each setting that differs.",
  mode: "sync",
  surfaces: ["api", "mcp"],
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
  input: z.object({}).strict(),
  output: steeringRepoView,
});

export type SteeringRepoGetOutput = z.output<typeof steeringRepoGet.output>;
export type SteeringRepoDifference = z.output<typeof steeringRepoDifference>;
