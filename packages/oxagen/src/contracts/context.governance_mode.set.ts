/**
 * `set_governance_mode`: change the steering governance mode a workspace runs
 * under, from Organization › Workspaces › Edit workspace (ADR-061; Mission
 * Control spec §10.2, §10.3 step 3).
 *
 * The mode is not a column. ADR-061 decision 1 puts it in a file on the
 * production branch of the workspace's main repository, and rejects a
 * `workspace_settings.governance_mode` cache, so every reader reads the file
 * itself every time. Which file depends on the repository's layout:
 *
 * - A steering repository keeps it as the top-level `mode` key of
 *   `steering/governance.toml`, beside the other governance/v1 settings. A
 *   change rewrites that one key and keeps every other line.
 * - A legacy repository keeps it in `.oxagen/rules/governance.toml`, and
 *   `open_init_pr` puts the first copy there.
 *
 * The layout is read, not declared: `steering/governance.toml` on the
 * production branch marks a steering repository, as it does for the merge
 * queue.
 *
 * **The mode in force decides how it may be changed.** Loosening governance is
 * the one change a strict mode most needs to see coming, so the route is read
 * off the current file rather than off the caller's intent:
 *
 * - `solo` already lets one person publish steering alone, so a change from it
 *   lands at once. A review step here would guard nothing.
 * - `team` and `regulated` open a pull request against the production branch
 *   instead, and the change waits for review.
 *
 * In a legacy repository, landing at once is a commit to the production
 * branch, and the pull request is an ordinary one a person merges on GitHub:
 * Oxagen runs no checks on it and `merge_steering_pr` does not merge it.
 *
 * In a steering repository nothing commits to the production branch directly
 * (ADR-232). Both routes open a pull request from `steering/governance` that
 * changes `steering/governance.toml` alone, and Oxagen reports the required
 * `Oxagen steering` check on it. Landing at once hands that pull request to
 * the steering merge queue, which rechecks it, stamps the ledger, merges it,
 * and publishes the new version. A check that refuses the change refuses the
 * call, and nothing lands.
 *
 * A legacy `governance.toml` that exists but cannot be read takes the `team`
 * and `regulated` route. A file Oxagen cannot parse already refuses every
 * steering PR open and merge, and a mode nobody can establish must not be
 * treated as the permissive one. An unreadable `steering/governance.toml`
 * refuses the call (`governance_unreadable`), because the merge queue reads
 * the mode from that file and refuses every steering PR until it parses.
 *
 * **`applyImmediately` is the override, and it is a deliberate act.** An org
 * Owner or Admin, or an Owner or Admin of the workspace itself, may set it to
 * land the change at once although the mode in force asks for review. It is
 * not a privilege escalation. Every role that can reach this capability at all
 * already holds it, and any of them could commit the same file on GitHub by
 * hand, so the review route is the default this override skips, not a wall it
 * climbs. In a steering repository the override lands through the merge queue,
 * and the ledger line records `without_review: true`. What the override buys is a record: an override
 * emits a `steering.governance_overridden` security event naming the caller,
 * the mode it left and the mode it set, which a hand-made commit on GitHub
 * never would. Under `solo` the flag changes nothing, because that route
 * commits anyway.
 *
 * **A reviewed change in a steering repository is a governance proposal.**
 * Under `team` or `regulated`, the call opens the steering PR, records it as a
 * proposal of kind `governance`, and answers `proposed`. `merge_steering_pr`
 * lands it once a workspace member other than the author approves it, and
 * records the approver (#4795, ADR-232). A call sets aside the governance
 * proposal already open, because the reused PR now carries its change. Apply
 * now is never the way to land that PR. It is the override above, and it is
 * recorded as one. Only Apply now in `team` or `regulated` emits
 * `steering.governance_overridden`.
 *
 * Refusals: `not_found: workspace_not_found`, `conflict: workspace_archived`,
 * `conflict: github_not_connected`, `not_found: repository_not_installed`,
 * `conflict: production_branch_missing`, `conflict: github_refused` with
 * GitHub's own message. In a steering repository also
 * `conflict: governance_unreadable` for a `steering/governance.toml` Oxagen
 * cannot parse, `conflict: steering_check_failed` with the check's summary
 * when landing at once meets a failing check, and the merge queue's own
 * refusals (`repository_unhealthy`, `head_moved`, `checks_failed`). There is deliberately no refusal for `applyImmediately`
 * without the role: the roles that may override are exactly the roles that may
 * call this at all, so such a refusal would be unreachable, and an unreachable
 * refusal in a contract reads as a guarantee the code does not make.
 *
 * Roles: org Owner or Admin for any workspace of the organization; an Owner or
 * Admin of the workspace the call is scoped to for that workspace alone,
 * without `workspaceId`. That is the gate `update_workspace_settings` applies,
 * because this is edited from the same dialog.
 *
 * A settings write, never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  GOVERNANCE_TOML_PATH,
  LEGACY_GOVERNANCE_PATH,
} from "../steering-repo/paths";
import { governanceModeSchema } from "./context.steering.shared";
import { workspaceSettingsWrite } from "./workspace.settings.write";

/** The branch a proposed governance change is opened from in a legacy repository. */
export const GOVERNANCE_BRANCH = "oxagen/governance";

/** `.oxagen/rules/governance.toml`, the file this capability writes in a legacy repository. */
export const GOVERNANCE_FILE = LEGACY_GOVERNANCE_PATH;

/**
 * The branch a governance change is opened from in a steering repository. The
 * `steering/` prefix and the one file it changes are what the branch-scope
 * rule admits (`docs/specs/steering/README.md`, "Branch names").
 */
export const STEERING_GOVERNANCE_BRANCH = "steering/governance";

/** `steering/governance.toml`, the file this capability writes in a steering repository. */
export const STEERING_GOVERNANCE_FILE = GOVERNANCE_TOML_PATH;

export const contextGovernanceModeSet = registerCapability({
  name: "set_governance_mode",
  domain: "workspace",
  description:
    "Set the steering governance mode of a workspace by writing its governance file: the mode key of steering/governance.toml in a steering repository, or .oxagen/rules/governance.toml in a legacy one. Under solo the change lands at once; under team or regulated it opens a pull request for review, which an org Owner or Admin, or a workspace Owner or Admin, may skip with applyImmediately. In a steering repository the change always travels as a checked pull request, and landing at once merges it through the steering merge queue. A reviewed change there is recorded as a governance proposal, which merge_steering_pr lands for an approver. The active workspace unless workspaceId names another one in the organization.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  // The strongest single setting on a workspace: it decides whether a human
  // other than the proposer ever looks at what steers the agents.
  sensitivity: "high",
  agent: {
    // An agent that could quietly move its own workspace to `solo` could then
    // publish its own steering unreviewed.
    requiresApproval: true,
    riskLevel: "high",
    category: "workspace",
  },
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z
    .object({
      /**
       * Which workspace of the org to change; omitted, the one the call is
       * scoped to. Organization › Workspaces edits from an org scope, so the
       * target travels by public id, exactly as `update_workspace_settings`
       * takes it.
       */
      workspaceId: workspaceSettingsWrite.input.shape.workspaceId,
      /** The mode to run under from the moment the change lands. */
      mode: governanceModeSchema,
      /**
       * Commit to the production branch although the mode in force asks for a
       * pull request. Requires the role above; recorded as
       * `steering.governance_overridden`. Under `solo` it changes nothing.
       */
      applyImmediately: z.boolean().default(false),
    })
    .strict(),
  output: z
    .object({
      /**
       * What happened, which the caller cannot infer from the input: the same
       * call is a commit in one workspace and a pull request in the next.
       *
       * - `applied`: the change is on the production branch and `mode` is in
       *   force now. In a legacy repository that is a direct commit. In a
       *   steering repository it is the squash merge of the pull request the
       *   merge queue landed.
       * - `proposed`: the change is on its branch (`oxagen/governance`, or
       *   `steering/governance` in a steering repository) with a pull request
       *   open against the production branch. The mode in force is unchanged
       *   until that pull request merges. In a steering repository it is a
       *   governance proposal, which `merge_steering_pr` lands for an approver
       *   (ADR-232).
       * - `unchanged`: the file already declares `mode`; nothing was written.
       */
      outcome: z.enum(["applied", "proposed", "unchanged"]),
      /** The mode asked for, echoed so a `proposed` answer says what is waiting. */
      requestedMode: governanceModeSchema,
      /**
       * The mode `governance.toml` declared before this call, or null when the
       * file was absent or unreadable. Null is not `team`: the default a
       * missing file falls to is a read-time rule, and reporting it here would
       * claim the repository said something it never said.
       */
      previousMode: governanceModeSchema.nullable(),
      /**
       * The mode in force now: `requestedMode` when `applied` or `unchanged`,
       * and the unchanged current mode when `proposed`. Null only when the file
       * is unreadable and the change went to review, so nothing established it.
       */
      effectiveMode: governanceModeSchema.nullable(),
      /** `owner/name` of the main repository, as the binding recorded it. */
      fullName: z.string().min(1),
      /** The production branch the change landed on or is proposed against. */
      productionBranch: z.string().min(1),
      /**
       * The file the mode lives in for this repository's layout:
       * `steering/governance.toml` or `.oxagen/rules/governance.toml`. A
       * surface names this file rather than guessing the layout.
       */
      path: z.string().min(1),
      /**
       * The commit on the production branch, when `applied`: the direct commit
       * in a legacy repository, the squash merge in a steering one. Null when
       * `proposed` or `unchanged`.
       */
      commitSha: z.string().min(1).nullable(),
      /**
       * The pull request carrying the change: the open one when `proposed`,
       * and in a steering repository the merged one when `applied`. Null for a
       * legacy direct commit and for `unchanged`. A pull request already open
       * on the change's branch is reused and its branch updated, so `reused`
       * distinguishes a fresh proposal from an amended one.
       */
      pullRequest: z
        .object({
          number: z.number().int().positive(),
          htmlUrl: z.string().url(),
          reused: z.boolean(),
        })
        .strict()
        .nullable(),
      /**
       * True when the caller spent `applyImmediately`: the mode in force asked
       * for review and this call landed the change anyway. False under `solo`, whose
       * route commits with no override to spend.
       */
      overrodeReview: z.boolean(),
      /**
       * The governance proposal (`prp_…`) a reviewer lands with
       * `merge_steering_pr`, when `proposed` in a steering repository. Null in
       * every other case, including a legacy pull request, which nothing in
       * Oxagen lands.
       */
      proposalId: z.string().min(1).nullable(),
    })
    .strict(),
});

export type ContextGovernanceModeSetInput = z.output<
  typeof contextGovernanceModeSet.input
>;
export type ContextGovernanceModeSetOutput = z.output<
  typeof contextGovernanceModeSet.output
>;
