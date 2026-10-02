/**
 * The cache keep-alive's answer for one host (spend spec, detector 3; lane
 * F32; decision 6 of the spend plan).
 *
 * While a parent run waits on a subagent, the host's model proxy can resend
 * the parent's last request with `max_tokens: 0`, so the parent's cached
 * prompt does not expire and get written again at the write price. It does
 * so only for an agent whose idle cache finding shows the keep-alive costs
 * less than the rewrites it saves, and only while the owning team has not
 * turned it off. The host can read neither fact, so the control plane signs
 * the answer into the host's policy bundle as `cache_keep_alive`, naming the
 * finding. Absent means off.
 *
 * - **The finding.** `idle_cache_rewrites` at the agent level, whose subject
 *   is the host's agent key (`org_ns.ws_ns.slug`): every run the host
 *   records carries that key, and the findings job keys the agent's findings
 *   on it. The job writes the finding only when a keep-alive would have cost
 *   less than the rewrites it cites (`cache-expiry.ts` in `@oxagen/billing`),
 *   and the row's evidence is checked again here.
 * - **Its status.** An open finding counts, and so does one the team
 *   applied. A keep-alive that works ends the rewrites an open finding
 *   cites, and the job deletes an open finding it no longer proves, so an
 *   open finding alone would turn the keep-alive off once it worked. An
 *   applied finding stays. A dismissed one does not count: the team said the
 *   advice does not fit this agent.
 * - **The setting.** `agent.agents.cache_keep_alive` false turns it off for
 *   the agent. A host enrolled by an operator, with no agent row, has no
 *   setting to read, so the finding alone decides.
 *
 * A host that did not advertise `BUNDLE_FEATURE_CACHE_KEEP_ALIVE` is asked
 * nothing and costs no read: its bundle schema is strict, and the field
 * would make it reject the whole mandate.
 */
import type { FindingEvidence } from "@oxagen/billing";
import { schema } from "@oxagen/database";
import {
  BUNDLE_FEATURE_CACHE_KEEP_ALIVE,
  type PolicyBundle,
} from "@oxagen/recorder";
import { and, desc, eq, inArray } from "drizzle-orm";

/** The finding kind whose answer turns the keep-alive on. */
export const CACHE_KEEP_ALIVE_FINDING_KIND = "idle_cache_rewrites";

/** The statuses whose finding still turns the keep-alive on. */
const COUNTED_STATUSES = ["open", "applied"] as const;

/** The most findings read for one agent: open and applied rows, newest first. */
const ROWS_READ = 5;

/** The reads this module makes, kept narrow so tests can fake them. */
export interface CacheKeepAliveTx {
  query: {
    agents: { findFirst: (args: unknown) => Promise<unknown> };
    findings: { findMany: (args: unknown) => Promise<unknown> };
  };
}

/** The host facts the answer reads. */
export interface CacheKeepAliveHost {
  agentId: string | null;
  agentKey: string;
  bundleFeatures: unknown;
}

/** Whether a host named `cache_keep_alive` among the fields it can parse. */
export function parsesCacheKeepAlive(host: {
  bundleFeatures: unknown;
}): boolean {
  const advertised = host.bundleFeatures;
  return (
    Array.isArray(advertised) &&
    advertised.includes(BUNDLE_FEATURE_CACHE_KEEP_ALIVE)
  );
}

function micros(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  return BigInt(value);
}

/**
 * Whether a finding's evidence shows the keep-alive cost less than the
 * rewrites it would have saved: the measured rewrites above the priced
 * keep-alive. Evidence with no price for either side shows nothing.
 */
export function keepAliveSaves(evidence: unknown): boolean {
  if (typeof evidence !== "object" || evidence === null) return false;
  const e = evidence as Partial<FindingEvidence>;
  const measured = micros(e.measuredMicros);
  const counterfactual = micros(e.counterfactualMicros);
  if (measured === null || counterfactual === null) return false;
  return measured > 0n && counterfactual < measured;
}

/**
 * The `cache_keep_alive` clause for a host, or undefined when the keep-alive
 * is off for its agent or the host cannot parse the clause.
 */
export async function resolveCacheKeepAlive(
  tx: CacheKeepAliveTx,
  ctx: { orgId: string; workspaceId: string },
  host: CacheKeepAliveHost,
): Promise<PolicyBundle["cache_keep_alive"]> {
  if (!parsesCacheKeepAlive(host)) return undefined;
  if (host.agentId !== null) {
    const agent = (await tx.query.agents.findFirst({
      where: eq(schema.agents.id, host.agentId),
      columns: { cacheKeepAlive: true },
    })) as { cacheKeepAlive: boolean } | undefined;
    if (agent?.cacheKeepAlive === false) return undefined;
  }
  const rows = (await tx.query.findings.findMany({
    where: and(
      eq(schema.findings.orgId, ctx.orgId),
      eq(schema.findings.workspaceId, ctx.workspaceId),
      eq(schema.findings.kind, CACHE_KEEP_ALIVE_FINDING_KIND),
      eq(schema.findings.level, "agent"),
      eq(schema.findings.subject, host.agentKey),
      inArray(schema.findings.status, [...COUNTED_STATUSES]),
    ),
    columns: { publicId: true, citedFrames: true },
    orderBy: [desc(schema.findings.detectedAt)],
    limit: ROWS_READ,
  })) as Array<{ publicId: string; citedFrames: unknown }>;
  const saving = rows.find((row) => keepAliveSaves(row.citedFrames));
  return saving === undefined ? undefined : { finding_id: saving.publicId };
}
