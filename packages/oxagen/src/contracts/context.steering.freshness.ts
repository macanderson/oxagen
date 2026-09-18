/**
 * `get_steering_freshness`: what the workspace says is in force, and the two
 * gates it wants a developer's machine to apply.
 *
 * ## Why the platform answers this at all
 *
 * A developer's checkout can tell, from git alone, whether a Context PR
 * merged onto the production branch that it does not have (ADR-061;
 * `docs/specs/steering/README.md`). Git is the primary signal and it is
 * usually enough. This read exists for the two things git on that machine
 * cannot know:
 *
 *   1. **What is actually in force.** A remote-tracking ref only knows what
 *      the last successful fetch brought back. A laptop that has been
 *      offline, or whose credential helper has quietly stopped working, will
 *      report a confident "current" against a ref that is weeks old.
 *      `headCommit` is the commit the newest promotion published at, and a
 *      checkout that cannot reach it is behind whatever its own refs say.
 *   2. **What the organisation decided.** `autoSync` and `blockStaleRuns`
 *      are a workspace policy, set once in Mission Control, and this is how
 *      they reach every machine. A local file may switch a gate ON and can
 *      never switch one OFF, so this read is the floor rather than a
 *      suggestion.
 *
 * ## Why it is cheap and why it is optional
 *
 * It runs in front of a developer's prompt, on every harness Oxagen wraps,
 * so it is one round trip, two indexed reads and no side effects. Every
 * caller treats failure as "no answer" and carries on with the git signal
 * alone: a governance control that stops all work when the control plane is
 * unreachable does not stay switched on, and a gate that is switched off
 * protects nothing.
 *
 * Read-only, and every role may call it. It tells a member nothing they
 * could not read out of the repository they already have checked out, and a
 * policy only a subset of the team could see would be a policy the rest of
 * the team hit as an unexplained refusal.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * The workspace's two gates, as they travel to a machine.
 *
 * Two plain booleans, not two optionals. A local settings file may switch a
 * gate ON and may never switch one OFF, so a workspace that has said nothing
 * and a workspace that has said `false` have exactly the same effect on
 * every machine. Modelling the difference would be a distinction no code
 * could act on, and a nullable policy every caller had to unwrap.
 */
export const steeringGatePolicy = z.object({
  autoSync: z
    .boolean()
    .describe(
      "Pull .oxagen/ forward from the production branch without being asked, when the checkout is behind it",
    ),
  blockStaleRuns: z
    .boolean()
    .describe(
      "Refuse to run a prompt while .oxagen/ is behind the production branch",
    ),
});

export type SteeringGatePolicy = z.infer<typeof steeringGatePolicy>;

/** The same two gates as a partial, for a write that sets one of them. */
export const steeringGatePolicyPatch = steeringGatePolicy.partial();

export const contextSteeringFreshness = registerCapability({
  name: "get_steering_freshness",
  domain: "context",
  description:
    "The workspace's steering version, the commit its newest record was published at, its production branch, and whether the workspace requires agents to auto-sync .oxagen/ or refuses prompts on stale steering.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // A freshness read on the path of every prompt. Metering it would bill a
  // customer for the privilege of being told their records are out of date.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "context" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  // Every role that exists, at both scopes. The workspace list is the one
  // `workspace_users_role_check` enforces (owner, admin, member, billing,
  // compliance, viewer), not the narrower SystemWorkspaceRole type.
  //
  // A denial here is not merely a failed panel. The CLI swallows every
  // platform error so a prompt is never blocked by the platform being
  // unreachable, so a denied caller's machine silently lost the workspace's
  // `autoSync` and `blockStaleRuns` and their agent ran ungated. A read-only
  // answer about what is published cannot be the thing that turns governance
  // off, so everyone who can see the workspace can ask it.
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Billing: "allow",
      Compliance: "allow",
      Viewer: "allow",
    },
  },
  input: z.object({}),
  output: z.object({
    /** The promotions ledger length: the workspace's steering version. */
    steeringVersion: z.number().int().nonnegative(),
    /**
     * The production-branch commit the newest record was published at, or
     * null when no Context PR has merged yet. A checkout that cannot reach
     * it is behind, whatever its own remote-tracking refs say.
     */
    headCommit: z.string().nullable(),
    /** When that record was published, for a banner that wants to say how long. */
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    /**
     * The repository whose default branch carries `.oxagen/`, as
     * `owner/repo`, and that branch. Null while no repository is bound:
     * steering is off for the workspace until one is.
     */
    repository: z.string().nullable(),
    defaultBranch: z.string().nullable(),
    /** The workspace's two gates. Both off unless the workspace turned one on. */
    policy: steeringGatePolicy,
  }),
});

export type ContextSteeringFreshnessOutput = z.output<
  typeof contextSteeringFreshness.output
>;
