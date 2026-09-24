// retention.ts — the workspace's fidelity setting (ADR-058 decision 2), read
// where more than one package grades a recording against it: tacho ingest at
// an `agent_stop` and the control plane's idle close (ADR-159). One query, so
// the two cannot grade the same workspace differently.
import { and, desc, eq } from "drizzle-orm";
import { retentionPolicyVersions } from "./schema/run-evidence-foundation";
import type { Tx } from "./tenant";

/** The one relational read this needs; narrow so a test can fake it. */
export interface RetentionPolicyTx {
  query: {
    retentionPolicyVersions: { findFirst: (args: unknown) => Promise<unknown> };
  };
}

/** The mode and content classes of a workspace's retention policy row. */
export interface RetentionPolicy {
  mode: string;
  retainedContentClasses: string[];
}

/**
 * The workspace's latest `evidence.retention_policy_versions` row; undefined
 * when it has pinned none, which retains bodies of every class. Names the
 * organization and workspace beside RLS.
 */
export async function readLatestRetentionPolicy(
  tx: Tx | RetentionPolicyTx,
  orgId: string,
  workspaceId: string,
): Promise<RetentionPolicy | undefined> {
  // A real transaction's typed `findFirst` does not assign to the narrow
  // shape a test fake satisfies, so both are accepted and read as the narrow
  // one: the call below is the same either way.
  const reader = tx as RetentionPolicyTx;
  return (await reader.query.retentionPolicyVersions.findFirst({
    where: and(
      eq(retentionPolicyVersions.orgId, orgId),
      eq(retentionPolicyVersions.workspaceId, workspaceId),
    ),
    orderBy: [desc(retentionPolicyVersions.version)],
    columns: { mode: true, retainedContentClasses: true },
  })) as RetentionPolicy | undefined;
}
