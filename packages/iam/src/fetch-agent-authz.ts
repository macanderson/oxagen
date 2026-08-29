// fetch-agent-authz.ts — read the CURRENT authz rows for an agent run's two
// ceiling principals (Agent RBAC docs/specs/agent-rbac/spec.md §3.4/§3.5;
// run-evidence 02-run-attempt-foundation-plan.md Task 5).
//
// A run carries a PINNED ceiling resolved at admission
// (authorization-snapshot.ts) and re-reads LIVE authority on every operation
// (live-agent-run-authorization.ts). This module is the LIVE read.
//
// It is deliberately a thin adapter over `readLiveAuthority` rather than a
// second query implementation: the
// ceiling and the live check must project the same columns, or the
// intersection between them would compare two different pictures of the same
// rows. `readLiveAuthority` preserves assignment ids, role ids, conditions,
// resource scopes, and per-binding expiries — exactly what the ceiling pins and
// what the live re-evaluation needs — and `liveResolverInputs` flattens them
// for the pure resolver only at the last moment.
//
// FAIL-CLOSED ON MISSING MIGRATION: if the IAM tables are absent (Postgres
// 42P01) this THROWS after logging loudly. The kernel's IAM seam treats a
// check-fn throw as an evaluation failure and fails closed unconditionally
// (authz_denied, independent of IAM_ENFORCEMENT_ENABLED) — an agent run
// without IAM tables can execute nothing, which is the correct posture for
// an unattended automation. fetch-authz.ts instead synthesizes a
// per-capability deny policy, which cannot express "deny everything" for an
// all-capability read — hence the throw here.

import { withTenantDb } from "@oxagen/database";
import { withRepeatableReadTenantDb } from "@oxagen/database/tenant";
import type { AgentAuthzSnapshot } from "@oxagen/oxagen/iam";
import {
  readLiveAuthority,
  type LiveAuthorityState,
} from "./authorization-snapshot";
import { liveResolverInputs } from "./live-agent-run-authorization";
import { logger } from "./logger";

/**
 * Postgres error code for "relation does not exist" — IAM migration not
 * applied. Mirrors fetch-authz.ts.
 */
const PG_UNDEFINED_TABLE = "42P01";

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<string, unknown>)["code"] === PG_UNDEFINED_TABLE
  );
}

export interface FetchAgentRunAuthzArgs {
  orgId: string;
  workspaceId: string;
  /** The agent's own delegated principal id (iam.principals, kind='agent'). */
  agentPrincipalId: string;
  /**
   * The initiating human's principal id, or null when the run carries no
   * resolvable delegator (the resolver then uses the unprivileged sentinel —
   * see SENTINEL_PRINCIPAL_ID in @oxagen/oxagen/iam).
   */
  humanPrincipalId: string | null;
  /** Injectable for deterministic tests; defaults to now. */
  now?: Date;
}

function principalIdsOf(args: FetchAgentRunAuthzArgs): string[] {
  return [
    args.agentPrincipalId,
    ...(args.humanPrincipalId !== null ? [args.humanPrincipalId] : []),
  ];
}

async function withUndefinedTableAlert<T>(
  args: FetchAgentRunAuthzArgs,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUndefinedTable(err)) {
      logger.error(
        { err, orgId: args.orgId, agentPrincipalId: args.agentPrincipalId },
        "[iam] SECURITY ALERT: IAM tables not found (Postgres 42P01) while " +
          "resolving an AGENT run's live authority — failing closed (the " +
          "kernel denies every capability for this run). Run `pnpm db:migrate` " +
          "to apply the IAM foundation migration and clear this alert.",
      );
    }
    // Propagate — the kernel's IAM seam fails closed on a check-fn throw
    // (unconditional authz_denied).
    throw err;
  }
}

/**
 * Read the CURRENT authority for both ceiling principals, preserving every
 * column the pinned ceiling also records (assignment ids, expiries, role-grant
 * conditions) plus the deny-generation vector.
 *
 * REPEATABLE READ, because the generation vector and the rows it describes must
 * come from one MVCC snapshot: a generation read in a different statement than
 * the grants tells you nothing about those grants.
 */
export async function fetchAgentRunLiveAuthority(
  args: FetchAgentRunAuthzArgs,
): Promise<LiveAuthorityState> {
  return withUndefinedTableAlert(args, () =>
    withRepeatableReadTenantDb((tx) =>
      readLiveAuthority(tx, {
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        principalIds: principalIdsOf(args),
      }),
    ),
  );
}

/**
 * Read the current authority and flatten it into pure-resolver inputs.
 *
 * The flattened form is lossy on purpose — it is what the resolver consumes,
 * not what a ceiling is pinned from. Anything that needs expiries or assignment
 * identity must use `fetchAgentRunLiveAuthority` instead.
 */
export async function fetchAgentRunAuthz(
  args: FetchAgentRunAuthzArgs,
): Promise<AgentAuthzSnapshot> {
  const now = args.now ?? new Date();
  return withUndefinedTableAlert(args, async () => {
    const authority = await withTenantDb((tx) =>
      readLiveAuthority(tx, {
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        principalIds: principalIdsOf(args),
      }),
    );
    return liveResolverInputs(authority, now);
  });
}
