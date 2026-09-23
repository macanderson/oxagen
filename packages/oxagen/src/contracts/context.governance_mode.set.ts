/**
 * `set_governance_mode`: change the steering governance mode a workspace runs
 * under, from Organization › Workspaces › Edit workspace (ADR-061; Mission
 * Control spec §10.2, §10.3 step 3).
 *
 * The mode is not a column. ADR-061 decision 1 puts it in
 * `.oxagen/rules/governance.toml` on the production branch of the workspace's
 * main repository, and rejects a `workspace_settings.governance_mode` cache, so
 * `open_context_pr` and `merge_context_pr` read the file itself every time. A
 * write here is therefore a commit to that file, and nothing else in the
 * product writes it: `open_init_pr` puts the first copy there and then refuses
 * once `.oxagen/` exists. Until this capability there was no way to change the
 * mode from Oxagen at all — only a hand-made pull request on GitHub.
 *
 * **The mode in force decides how it may be changed.** Loosening governance is
 * the one change a strict mode most needs to see coming, so the route is read
 * off the current file rather than off the caller's intent:
 *
 * - `solo` already lets one person publish steering alone, so a change from it
 *   commits straight to the production branch. A review step here would guard
 *   nothing.
 * - `team` and `regulated` open a pull request against the production branch
 *   instead, and a person merges it on GitHub. It is an ordinary pull request,
 *   not a Context PR: Oxagen runs no checks on it and `merge_context_pr` does
 *   not merge it.
 * - A `governance.toml` that exists but cannot be read takes the `team` and
 *   `regulated` route. A file Oxagen cannot parse already refuses every Context
 *   PR open and merge, and a mode nobody can establish must not be treated as
 *   the permissive one.
 *
 * **`applyImmediately` is the override, and it is a deliberate act.** An org
 * Owner or Admin, or an Owner or Admin of the workspace itself, may set it to
 * commit straight to the production branch although the mode in force asks for
 * review. It is not a privilege escalation — every role that can reach this
 * capability at all already holds it, and any of them could commit the same
 * file on GitHub by hand — so the review route is the default this override
 * skips, not a wall it climbs. What the override buys is a record: an override
 * emits a `steering.governance_overridden` security event naming the caller,
 * the mode it left and the mode it set, which a hand-made commit on GitHub
 * never would. Under `solo` the flag changes nothing, because that route
 * commits anyway.
 *
 * Refusals: `not_found: workspace_not_found`, `conflict: workspace_archived`,
 * `conflict: github_not_connected`, `not_found: repository_not_installed`,
 * `conflict: production_branch_missing`, `conflict: github_refused` with
 * GitHub's own message. There is deliberately no refusal for `applyImmediately`
 * without the role: the roles that may override are exactly the roles that may
 * call this at all, so such a refusal would be unreachable, and an unreachable
 * refusal in a contract reads as a guarantee the code does not make.
 *
 * Roles: org Owner or Admin for any workspace of the organization; an Owner or
 * Admin of the workspace the call is scoped to for that workspace alone,
 * without `workspaceId` — the same gate `update_workspace_settings` applies,
 * because this is edited from the same dialog.
 *
 * A settings write, never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { governanceModeSchema } from "./context.steering.shared";
import { workspaceSettingsWrite } from "./workspace.settings.write";

/** The branch a proposed governance change is opened from. */
export const GOVERNANCE_BRANCH = "oxagen/governance";

/** `.oxagen/rules/governance.toml`, the file this capability writes. */
export const GOVERNANCE_FILE = ".oxagen/rules/governance.toml";

export const contextGovernanceModeSet = registerCapability({
  name: "set_governance_mode",
  domain: "workspace",
  description:
    "Set the steering governance mode of a workspace by writing .oxagen/rules/governance.toml on its main repository. Under solo the change is committed to the production branch; under team or regulated it opens a pull request for review, which an org Owner or Admin, or a workspace Owner or Admin, may skip with applyImmediately. The active workspace unless workspaceId names another one in the organization.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
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
       * - `applied` — `governance.toml` is committed to the production branch
       *   and `mode` is in force now.
       * - `proposed` — the change is on `oxagen/governance` with a pull request
       *   open against the production branch. The mode in force is unchanged
       *   until a person merges it on GitHub.
       * - `unchanged` — the file already declares `mode`; nothing was written.
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
       * The mode in force now — `requestedMode` when `applied` or `unchanged`,
       * and the unchanged current mode when `proposed`. Null only when the file
       * is unreadable and the change went to review, so nothing established it.
       */
      effectiveMode: governanceModeSchema.nullable(),
      /** `owner/name` of the main repository, as the binding recorded it. */
      fullName: z.string().min(1),
      /** The production branch the change landed on or is proposed against. */
      productionBranch: z.string().min(1),
      /** The commit, when `applied`; null when `proposed` or `unchanged`. */
      commitSha: z.string().min(1).nullable(),
      /**
       * The pull request carrying the change, when `proposed`. A pull request
       * already open on `oxagen/governance` is reused and its branch updated,
       * so `reused` distinguishes a fresh proposal from an amended one.
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
       * True when the caller spent `applyImmediately` — the mode in force asked
       * for review and this call committed anyway. False under `solo`, whose
       * route commits with no override to spend.
       */
      overrodeReview: z.boolean(),
    })
    .strict(),
});

export type ContextGovernanceModeSetInput = z.output<
  typeof contextGovernanceModeSet.input
>;
export type ContextGovernanceModeSetOutput = z.output<
  typeof contextGovernanceModeSet.output
>;
