"use server";

/**
 * Server actions for the Capability & Contract catalog drawer.
 *
 * apps/app does not bootstrap kernel IAM — every action gates explicitly
 * (authenticated session + org membership) before invoke(). Reads only.
 */

import { z } from "zod";
import type { CapabilityRegistryGetOutput } from "@oxagen/oxagen/contracts/capability.registry.get";
import type {
  AuditLogQueryOutput,
  AuditEvent,
} from "@oxagen/oxagen/contracts/audit.log.query";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import { logger } from "@oxagen/handlers/logger";
import { getSession } from "@/lib/session";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { invokeOrgCapability } from "../_lib/invoke-org";

const DAY_MS = 24 * 60 * 60 * 1000;

const inputSchema = z.object({
  orgSlug: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9_.]+$/, "capability names are snake_case"),
});

export interface CapabilityUsageSlice {
  costMicros: number;
  executions: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CapabilityInsights {
  detail: NonNullable<CapabilityRegistryGetOutput["capability"]> | null;
  /** 30-day metering slice for this capability; null when analytics failed. */
  usage: CapabilityUsageSlice | null;
  /** Last audit events naming this capability; null when the read failed. */
  audit: AuditEvent[] | null;
  error?: string;
}

/**
 * One round-trip for the drawer: contract detail + 30d usage slice + recent
 * audit events. Usage/audit degrade to null independently (the drawer shows
 * "unavailable" for that sub-section only); a missing contract is a clean
 * `detail: null`.
 */
export async function fetchCapabilityInsights(
  rawOrgSlug: string,
  rawName: string,
): Promise<CapabilityInsights> {
  const parsed = inputSchema.safeParse({ orgSlug: rawOrgSlug, name: rawName });
  if (!parsed.success) {
    return {
      detail: null,
      usage: null,
      audit: null,
      error: "Invalid request.",
    };
  }
  const { orgSlug, name } = parsed.data;

  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      detail: null,
      usage: null,
      audit: null,
      error: "Not authenticated.",
    };
  }
  const tenant = await resolveOrg(orgSlug);
  try {
    await assertOrgMember(tenant.id, userId);
  } catch {
    return { detail: null, usage: null, audit: null, error: "Not authorized." };
  }

  const now = Date.now();
  const start = new Date(now - 30 * DAY_MS).toISOString();
  const end = new Date(now).toISOString();

  const [detailRes, usageRes, auditRes] = await Promise.allSettled([
    invokeOrgCapability<CapabilityRegistryGetOutput>(
      tenant.id,
      userId,
      "get_capability_registry",
      { name },
    ),
    invokeOrgCapability<BillingUsageBreakdownOutput>(
      tenant.id,
      userId,
      "get_usage_breakdown",
      { start, end },
    ),
    invokeOrgCapability<AuditLogQueryOutput>(
      tenant.id,
      userId,
      "query_audit_log",
      {
        source: "security",
        capability: name,
        limit: 10,
        offset: 0,
      },
    ),
  ]);

  if (detailRes.status === "rejected") {
    logger.error(
      { err: detailRes.reason, orgId: tenant.id, name },
      "governance/capabilities: detail read failed",
    );
    return {
      detail: null,
      usage: null,
      audit: null,
      error: "Unable to load the contract detail.",
    };
  }

  let usage: CapabilityUsageSlice | null = null;
  if (usageRes.status === "fulfilled") {
    const row = usageRes.value.byCapability.find((r) => r.key === name);
    usage = row
      ? {
          costMicros: row.costMicros,
          executions: row.executions,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
        }
      : { costMicros: 0, executions: 0, inputTokens: 0, outputTokens: 0 };
  } else {
    logger.warn(
      { err: usageRes.reason, orgId: tenant.id, name },
      "governance/capabilities: usage slice failed",
    );
  }

  let audit: AuditEvent[] | null = null;
  if (auditRes.status === "fulfilled") {
    audit = auditRes.value.events;
  } else {
    logger.warn(
      { err: auditRes.reason, orgId: tenant.id, name },
      "governance/capabilities: audit slice failed",
    );
  }

  return { detail: detailRes.value.capability, usage, audit };
}
