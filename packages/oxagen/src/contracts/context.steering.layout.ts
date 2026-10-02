/**
 * `get_steering_layout`: which of the two repository layouts the workspace's
 * bound repository uses, so a client can show the path and branch
 * `open_steering_pr` will actually write before that write happens (#4765).
 *
 * ## Why the app needs this at all
 *
 * `open_steering_pr` (`steering.pr.open.ts`) reads `steering/governance.toml`
 * off the bound repository's production branch on every open. A repository
 * that carries the file is a steering repo: a new record's file goes under
 * `steering/<kind folder>/` or, for a memory, `steering/memory/workspace/general/`,
 * and its branch is `steering/<lineage>` or `memory/<lineage>`. A repository
 * without it is legacy: the file is `.oxagen/rules/<lineage>.toml` and the
 * branch is always `steering/<lineage>`. Neither layout is knowable from
 * data the app already holds, so a preview shown before that read would be a
 * guess, and the two layouts guess differently.
 *
 * ## Why it is cheap and why a failure answers `null`
 *
 * One file read on the bound repository's default branch, the same call
 * `open_steering_pr` makes. A caller that cannot resolve a bound repository,
 * or whose read of `steering/governance.toml` fails, answers `layout: null`
 * rather than a guess: the wizard then shows the path and branch as set when
 * the pull request opens, instead of a value that may not match what
 * `open_steering_pr` writes.
 *
 * Read-only, and every role may call it: it answers with a fact anyone with
 * repository access could read off the repository directly.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const contextSteeringLayout = registerCapability({
  name: "get_steering_layout",
  domain: "context",
  description:
    "Which of the two repository layouts the workspace's bound repository uses: steering (steering/governance.toml on its production branch) or legacy (.oxagen/rules/). Null when no repository is bound or the read failed.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // A layout read on the path a creation wizard's preview step renders.
  // Metering it would bill a customer for a preview of a write they have not
  // made yet.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "context" },
  sensitivity: "low",
  mutates: false,
  // `allow`, for the same reason `get_steering_freshness` is: the tenant
  // scope the surface established already bounds the read to the workspace's
  // own bound repository, so allow grants nothing a caller could not read out
  // of the repository they have checked out. A deny default would refuse a
  // workspace Member with no IAM assignment their own creation wizard's
  // preview, the same silent-loss shape `get_steering_freshness`'s contract
  // documents.
  defaultEffect: "allow",
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
    layout: z
      .enum(["steering", "legacy"])
      .nullable()
      .describe(
        "steering when the bound repository carries steering/governance.toml on its production branch, legacy otherwise. Null while no repository is bound or the read failed.",
      ),
  }),
});

export type ContextSteeringLayoutOutput = z.output<
  typeof contextSteeringLayout.output
>;
