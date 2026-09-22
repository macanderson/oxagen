/**
 * The workspace's policy for the sessions Oxagen does not run.
 *
 * A wrapped Claude Code or Codex routes its model calls through the daemon's
 * loopback proxy, and the proxy decides what to refuse from the signed policy
 * bundle. Until this module existed the bundle carried `budget.mode:
 * "observed"` as a literal, so the refusal branches in `model-proxy.ts` were
 * real code that nothing could reach — the gateway metered and never governed
 * (docs/audits/2026-09-21-model-gateway-arming.md §2).
 *
 * This is a different setting from `workspace_budget_policy`, which governs an
 * in-app assistant TURN. This one governs a wrapped harness SESSION on
 * somebody's laptop, and the two are read by different enforcers.
 */
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { tachoSessionPolicyTableReady } from "./tacho-gateway-columns";

export interface TachoSessionPolicy {
  mode: "observed" | "enforced";
  /** The per-session ceiling in USD; null when no ceiling is set. */
  sessionLimitUsd: number | null;
  /**
   * `null` = no allowlist, so every model is permitted; `[]` = an allowlist
   * that permits nothing. The two are different decisions.
   */
  modelAllow: string[] | null;
  modelDeny: string[];
}

/**
 * What a workspace with no row gets, and what every workspace had before this
 * table: metered, never refused.
 */
export const OBSERVED_ONLY: TachoSessionPolicy = {
  mode: "observed",
  sessionLimitUsd: null,
  modelAllow: null,
  modelDeny: [],
};

/** The row shape both readers below normalize. */
interface PolicyRow {
  mode: string;
  sessionLimitUsd: number | null;
  modelAllow: unknown;
  modelDeny: unknown;
}

/** A jsonb column read back as a list of model patterns, or `null`. */
function patterns(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalize(row: PolicyRow | undefined): TachoSessionPolicy {
  if (row === undefined) return OBSERVED_ONLY;
  const allow = patterns(row.modelAllow);
  const deny = patterns(row.modelDeny) ?? [];
  // A stored mode outside the two the check constraint allows can only be a
  // row written around the constraint. Read it as the safe one rather than
  // letting an unknown word arm a gateway.
  const mode = row.mode === "enforced" ? "enforced" : "observed";
  return {
    mode,
    sessionLimitUsd: row.sessionLimitUsd ?? null,
    modelAllow: allow,
    modelDeny: deny,
  };
}

const POLICY_COLUMNS = {
  mode: true,
  sessionLimitUsd: true,
  modelAllow: true,
  modelDeny: true,
} as const;

/** The narrow transaction shape the bundle path already holds. */
export interface SessionPolicyTx {
  query: {
    tachoSessionPolicy: { findFirst: (args: unknown) => Promise<unknown> };
  };
}

/**
 * Read the policy inside a transaction the caller already opened.
 *
 * The table is probed first. Production applies migrations by hand from the
 * app node while `deploy-node` ships on merge, so this code is live before the
 * table exists — and naming an absent table raises 42P01, which aborts the
 * transaction. This read sits on the bundle path, which ingest, control polls
 * and enrollment all walk, so the window would stop every host outright rather
 * than degrade one clause. Pending reads as observed-only, which is exactly
 * what every host had before the table.
 */
export async function readTachoSessionPolicyIn(
  tx: SessionPolicyTx,
  workspaceId: string,
): Promise<TachoSessionPolicy> {
  if (!(await tachoSessionPolicyTableReady(tx as never))) return OBSERVED_ONLY;
  const row = (await tx.query.tachoSessionPolicy.findFirst({
    where: eq(schema.tachoSessionPolicy.workspaceId, workspaceId),
    columns: POLICY_COLUMNS,
  })) as PolicyRow | undefined;
  return normalize(row);
}

/** Read the policy for a handler that has no transaction of its own. */
export async function readTachoSessionPolicy(
  workspaceId: string,
): Promise<TachoSessionPolicy> {
  return withTenantDb((tx) =>
    readTachoSessionPolicyIn(tx as unknown as SessionPolicyTx, workspaceId),
  );
}

/**
 * Whether a policy carries anything the proxy could refuse on.
 *
 * `enforced` with no ceiling and no model list is the defect this table exists
 * to fix, wearing a switch: a setting that says it governs and governs
 * nothing. The database rejects it too (`tacho_session_policy_enforced_check`);
 * this is the same rule where a person can be told why.
 */
export function hasEnforceableClause(policy: TachoSessionPolicy): boolean {
  return (
    policy.sessionLimitUsd !== null ||
    policy.modelAllow !== null ||
    policy.modelDeny.length > 0
  );
}
