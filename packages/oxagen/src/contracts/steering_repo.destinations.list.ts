import { z } from "zod";
import { registerCapability } from "../registry";
import { workspaceSlug } from "../workspace-slug";
import { steeringConnectionChoice } from "./steering_repo.shared";

/**
 * list_steering_repo_destinations: where a new workspace's steering repo can
 * go, for the create forms to offer before `create_workspace` runs.
 *
 * The handler lists the same places the provisioning job's `pick_connection`
 * step lists: every installation of the Oxagen GitHub App on an organization,
 * or on the owner's own personal account, that the stored owner token reaches,
 * and every GitLab group with a stored group token. It reads each provider's
 * API, so it costs a few host calls.
 *
 * `default` is the organization's stored GitHub organization or GitLab group,
 * where a workspace created without a choice goes. It is null before one is
 * stored. A stored place the tokens no longer reach is still named, so the
 * form can say so. `defaultName` is the name a workspace with `slug` gets
 * when nobody changes it, or null when the call names no slug.
 *
 * Org Owners and Admins, and a workspace Owner calling from a workspace: the
 * people `create_workspace` admits.
 */
export const steeringRepoDestinationsList = registerCapability({
  name: "list_steering_repo_destinations",
  domain: "repository",
  description:
    "List the GitHub organizations, personal GitHub accounts, and GitLab groups where Oxagen can create a new workspace's steering repo. Also names the organization's default and the repository name a workspace slug gets by default. Pass a destination and a name to create_workspace's steeringRepo.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  orgLevel: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  input: z
    .object({
      slug: workspaceSlug
        .describe("The new workspace's slug, to name its default repository.")
        .optional(),
    })
    .strict(),
  output: z.object({
    destinations: z
      .array(steeringConnectionChoice)
      .describe(
        "Every place the organization's stored tokens reach, GitHub first. Empty when nothing is connected yet.",
      ),
    default: steeringConnectionChoice
      .nullable()
      .describe(
        "The organization's stored GitHub organization or GitLab group, or null before one is stored.",
      ),
    defaultName: z
      .string()
      .nullable()
      .describe("The default repository name for slug, or null with no slug."),
    reauthorize: z
      .array(z.enum(["github", "gitlab"]))
      .describe(
        "Hosts that refused the stored token, so their places are missing from destinations. An organization owner must authorize Oxagen on that host again.",
      ),
  }),
});

export type SteeringRepoDestinationsListOutput = z.output<
  typeof steeringRepoDestinationsList.output
>;
