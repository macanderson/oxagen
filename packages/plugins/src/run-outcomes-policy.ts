import { schema, withSystemDb, withTenantDb, type Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import type { RunOutcomesPolicy } from "@oxagen/oxagen/run-outcomes";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

export interface RunOutcomesScope {
  orgId: string;
  workspaceId: string;
}

const storedPolicy = z.object({
  customerEnabled: z.boolean().default(false),
  platformDisabled: z.boolean().default(false),
  platformDisabledReason: z.string().nullable().default(null),
});

/** Missing consent is off. Corrupt policy never grants access. */
export function parseRunOutcomesPolicy(settings: unknown): RunOutcomesPolicy {
  const bag = z.record(z.unknown()).safeParse(settings);
  const parsed = storedPolicy.safeParse(
    bag.success
      ? bag.data["runOutcomes"] === undefined
        ? {}
        : bag.data["runOutcomes"]
      : null,
  );
  if (!parsed.success) {
    throw new HandlerError({
      code: "conflict",
      reason: "run_outcomes_policy_invalid",
    });
  }
  const policy = parsed.data;
  return {
    ...policy,
    effectiveEnabled: policy.customerEnabled && !policy.platformDisabled,
  };
}

export async function readRunOutcomesPolicy(
  scope: RunOutcomesScope,
): Promise<RunOutcomesPolicy> {
  // withTenantDb also checks the active scope. The explicit org predicate
  // keeps this read bounded when a job supplies its verified event scope.
  const row = await withTenantDb((tx) =>
    tx.query.organizations.findFirst({
      where: eq(schema.organizations.id, scope.orgId),
      columns: { settings: true },
    }),
  );
  if (!row)
    throw new HandlerError({
      code: "not_found",
      reason: "organization_not_found",
    });
  return parseRunOutcomesPolicy(row.settings);
}

/** Call before each model or provider effect, including every resumed job step. */
export async function assertRunOutcomesAllowed(
  scope: RunOutcomesScope,
): Promise<void> {
  const policy = await readRunOutcomesPolicy(scope);
  if (policy.platformDisabled) {
    throw new HandlerError({
      code: "forbidden",
      reason: "run_outcomes_platform_disabled",
    });
  }
  if (!policy.customerEnabled) {
    throw new HandlerError({
      code: "forbidden",
      reason: "run_outcomes_not_enabled",
    });
  }
}

async function patchPolicy(
  tx: Tx,
  orgId: string,
  patch: Record<string, unknown>,
): Promise<RunOutcomesPolicy> {
  const rows = await tx
    .update(schema.organizations)
    .set({
      settings: sql`COALESCE(${schema.organizations.settings}, '{}'::jsonb)
      || jsonb_build_object('runOutcomes',
        COALESCE(${schema.organizations.settings} -> 'runOutcomes', '{}'::jsonb)
        || ${JSON.stringify(patch)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(schema.organizations.id, orgId))
    .returning({ settings: schema.organizations.settings });
  if (!rows[0])
    throw new HandlerError({
      code: "not_found",
      reason: "organization_not_found",
    });
  return parseRunOutcomesPolicy(rows[0].settings);
}

/** Owns customer fields only. It cannot clear platform suspension. */
export function setRunOutcomesConsent(
  scope: RunOutcomesScope,
  enabled: boolean,
  actorUserId: string,
): Promise<RunOutcomesPolicy> {
  return withTenantDb((tx) =>
    patchPolicy(tx, scope.orgId, {
      customerEnabled: enabled,
      customerUpdatedAt: new Date().toISOString(),
      customerUpdatedBy: actorUserId,
    }),
  );
}

/** Called only by the platformOnly capability, with a kernel-issued binding. */
export function setRunOutcomesPlatformAccess(input: {
  orgId: string;
  disabled: boolean;
  reason: string;
  requestId: string;
}): Promise<RunOutcomesPolicy> {
  // tenancy: platform-only operator write, filtered by the verified target orgId from the trusted operator invocation.
  return withSystemDb((tx) =>
    patchPolicy(tx, input.orgId, {
      platformDisabled: input.disabled,
      platformDisabledReason: input.disabled ? input.reason : null,
      platformUpdatedAt: new Date().toISOString(),
      platformRequestId: input.requestId,
      platformChangeReason: input.reason,
    }),
  );
}
