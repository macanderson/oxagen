// evidence.disclosure_grain.set.ts — handler for set_disclosure_grain (ADR-064).
//
// How much a worker is told when a witness it cannot see fails (spec §8.5
// invariant 3). A person decides it:
//   1. Session gate — `requireSessionUser` refuses every API-key caller, since
//      a worker holds API keys.
//   2. Role gate — `assertOrgRole`: org Owner or Admin (INV-29).
//   3. Write — the workspace's `evidence.disclosure_policies` row. Asking for
//      the grain in force writes nothing and emits nothing.
//   4. Audit — `evidence.disclosure_grain_changed` for every change.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { evidenceDisclosureGrainSet } from "@oxagen/oxagen/contracts/evidence.disclosure_grain.set";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireSessionUser, writeDisclosureGrain } from "./lib/proof";
import { logger } from "./logger";

export type DisclosureGrainWriter = typeof writeDisclosureGrain;

export function createDisclosureGrainSetHandler(
  write: DisclosureGrainWriter,
): CapabilityHandler<typeof evidenceDisclosureGrainSet> {
  return async (input, ctx) => {
    const userId = requireSessionUser(ctx);
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: ["Owner", "Admin"] },
    );

    const change = await write(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      input.grain,
      userId,
    );

    if (change.changed) {
      // SOC 2 CC6.1: raising the grain hands workers detail about oracles they
      // must not see; lowering it is the same decision in reverse.
      emitSecurityEvent({
        eventType: "evidence.disclosure_grain_changed",
        actorUserId: userId,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        capability: evidenceDisclosureGrainSet.name,
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId: ctx.requestId ?? null,
      });
      logger.info(
        {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          actorUserId: userId,
          previousGrain: change.previous,
          grain: change.grain,
        },
        "evidence.disclosure_grain.set: grain changed",
      );
    }

    return {
      grain: change.grain,
      previousGrain: change.previous,
      changedAt: change.changedAt?.toISOString() ?? null,
    };
  };
}

export const disclosureGrainSetHandler =
  createDisclosureGrainSetHandler(writeDisclosureGrain);
