import "server-only";
/**
 * data.ts — the three read capabilities behind the governed-action meter page.
 *
 * Why this is not `actions.ts`: the `actions.ts` convention in this repo is one
 * file per route segment holding that segment's Server *Actions* — the mutation
 * endpoints the client may call. These three are page-render reads with no
 * client caller; exporting them from a `"use server"` module would mint three
 * public RPC endpoints nothing needs. The one genuine client→server call on
 * this page (the cost calculator) lives in `actions.ts` where it belongs.
 *
 * Authorization: `apps/app` does not bootstrap kernel IAM, so `invoke()` from
 * here skips the role check the API and MCP surfaces get for free. Every read
 * is therefore gated explicitly at the call site by
 * {@link resolveBillingViewer} before the invoke.
 *
 * Failure policy: each read is independently wrapped. One store being down
 * costs its own panel and nothing else — the page's job is to explain a bill,
 * and two thirds of that explanation beats an error page. A failure is a
 * distinct rendered state (see `PanelUnavailable`), never a silent zero: a
 * fabricated zero on a billing page is the exact defect ADR-052 exists to kill.
 */

import { invoke } from "@oxagen/oxagen";
// Side-effect import binds every handler into the kernel — without it invoke()
// throws "No handler registered". Mirrors the other app-side invoke call sites.
import "@oxagen/handlers/register";
import { billingActionRateCard } from "@oxagen/oxagen/contracts/billing.action_rate_card";
import { billingActionUsage } from "@oxagen/oxagen/contracts/billing.action_usage";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import type { BillingActionRateCardOutput } from "@oxagen/oxagen/contracts/billing.action_rate_card";
import type { BillingActionUsageOutput } from "@oxagen/oxagen/contracts/billing.action_usage";
import type { BillingEvidenceRetentionOutput } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import {
  resolveOrg,
  assertOrgMember,
  assertBillingManager,
} from "@/lib/resolve-org";
import { getSession } from "@/lib/session";

/**
 * Sentinel workspaceId for org-only routes. Billing tables use an org_only RLS
 * policy class — the workspace GUC is set but never evaluated.
 */
export const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export interface BillingViewer {
  orgId: string;
  orgSlug: string;
  viewerUserId: string;
}

/** A panel's data, or the honest statement that it could not be read. */
export type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Resolve the org and assert the caller may read its billing.
 *
 * Membership alone is not enough: `get_action_usage` and
 * `get_evidence_retention` both declare `defaultRoles.org = {Owner, Admin,
 * Billing}`, and this page shows what the organisation has been charged. A
 * non-manager gets `notFound()` — the same treatment as a non-member, matching
 * `billing/usage/page.tsx`, so org membership is not leaked by the difference
 * between a 403 and a 404.
 */
export async function resolveBillingViewer(
  orgSlug: string,
): Promise<BillingViewer> {
  const [org, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);
  const viewerUserId = session?.user?.id ?? "";
  if (viewerUserId) {
    await assertOrgMember(org.id, viewerUserId);
    await assertBillingManager(org.id, viewerUserId);
  }
  return { orgId: org.id, orgSlug, viewerUserId };
}

function capabilityContext(viewer: BillingViewer) {
  return {
    orgId: viewer.orgId,
    workspaceId: ORG_ONLY_WS,
    userId: viewer.viewerUserId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

/**
 * Invoke one read capability inside the org's tenant scope, degrading to a
 * rendered "unavailable" state rather than throwing the whole page away.
 *
 * `surface: "agent"` because these contracts declare `surfaces: ["api", "mcp",
 * "agent"]` and the app is not one of them — the same override the existing
 * billing usage dashboard uses.
 */
async function readCapability<T>(
  viewer: BillingViewer,
  name: string,
  input: unknown,
): Promise<Loaded<T>> {
  try {
    const result = await runInTenantScope(
      { orgId: viewer.orgId, workspaceId: ORG_ONLY_WS },
      () =>
        invoke(name, input, capabilityContext(viewer), { surface: "agent" }),
    );
    return { ok: true, data: result as T };
  } catch (err) {
    logger.error(
      { err, orgId: viewer.orgId, capability: name },
      "billing/governed-actions: capability read failed",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Read failed",
    };
  }
}

/** The published rate card, plus the caller's own tier (`get_rate_card`). */
export function loadRateCard(
  viewer: BillingViewer,
): Promise<Loaded<BillingActionRateCardOutput>> {
  return readCapability<BillingActionRateCardOutput>(
    viewer,
    billingActionRateCard.name,
    {},
  );
}

/**
 * This entitlement year's governed-action usage (`get_action_usage`).
 *
 * `includeBreakdown` is passed through so the page can offer the
 * per-capability view without a second capability — it is off by default
 * because it is a ClickHouse-scale scan where the headline numbers are one
 * indexed Postgres row.
 */
export function loadActionUsage(
  viewer: BillingViewer,
  options: { includeBreakdown?: boolean } = {},
): Promise<Loaded<BillingActionUsageOutput>> {
  return readCapability<BillingActionUsageOutput>(
    viewer,
    billingActionUsage.name,
    { includeBreakdown: options.includeBreakdown === true },
  );
}

/** Retention posture and its price (`get_evidence_retention`). */
export function loadEvidenceRetention(
  viewer: BillingViewer,
): Promise<Loaded<BillingEvidenceRetentionOutput>> {
  return readCapability<BillingEvidenceRetentionOutput>(
    viewer,
    billingEvidenceRetention.name,
    {},
  );
}
