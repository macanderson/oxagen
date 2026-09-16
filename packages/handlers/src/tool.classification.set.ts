// tool.classification.set.ts — handler for the set_tool_classification
// capability (MC spec §6.9 part 1, ADR-068, #2958).
//
// Flow:
//   1. Role gate — org Owner or Admin (assertOrgRole, INV-29).
//   2. Resolve the `tlv_…` version in this workspace; not_found otherwise.
//   3. Write the classification, the classified risk grade, who set it, when
//      and why on the version row, in one statement. The declared risk_grade
//      and the checksum over it stay as published. A changed classification
//      bumps the deny generation in this statement's transaction (trigger
//      tool_versions_classification_deny_generation), so a kill-switch gate
//      already open reloads the tags before its next non-read-only call.
//   4. Emit tool.classification_changed: reclassifying changes which class
//      kill switches reach the version, and later which approval rules. The
//      row itself carries who, when, why and the classification; the event
//      carries the actor and the capability.
//
// Classification describes the tool and decides nothing by itself; the class
// kill-switch gate and list_tool_versions read the tags at call time. A new
// version of the tool starts with this classification (publishTool).

import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { toolClassificationSet } from "@oxagen/oxagen/contracts/tool.classification.set";
import type {
  ToolClassification,
  ToolRiskGrade,
} from "@oxagen/oxagen/contracts/tool.classification";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq, isNull } from "drizzle-orm";

export interface ToolClassificationDeps {
  findVersion(scope: {
    orgId: string;
    workspaceId: string;
    publicId: string;
  }): Promise<{ id: string; publicId: string } | null>;
  write(args: {
    versionId: string;
    riskGrade: ToolRiskGrade;
    classification: ToolClassification;
    reason: string;
    userId: string | null;
    at: Date;
  }): Promise<void>;
}

const postgresToolClassificationDeps: ToolClassificationDeps = {
  findVersion: async (scope) => {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.toolVersions.id,
          publicId: schema.toolVersions.publicId,
        })
        .from(schema.toolVersions)
        .innerJoin(
          schema.tools,
          eq(schema.tools.id, schema.toolVersions.toolId),
        )
        .where(
          and(
            eq(schema.toolVersions.orgId, scope.orgId),
            eq(schema.toolVersions.workspaceId, scope.workspaceId),
            eq(schema.toolVersions.publicId, scope.publicId),
            isNull(schema.tools.deletedAt),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  },
  write: async (args) => {
    await withTenantDb((tx) =>
      tx
        .update(schema.toolVersions)
        .set({
          classifiedRiskGrade: args.riskGrade,
          classification: args.classification,
          classifiedByUserId: args.userId,
          classifiedAt: args.at,
          classificationReason: args.reason,
          updatedAt: args.at,
          updatedByUserId: args.userId ?? undefined,
        })
        .where(eq(schema.toolVersions.id, args.versionId)),
    );
  },
};

export function createToolClassificationSetHandler(
  deps: ToolClassificationDeps,
  now: () => Date = () => new Date(),
): CapabilityHandler<typeof toolClassificationSet> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole({ ...ctx, userId: actingUserId }, { org: ["Owner", "Admin"] });

    const version = await deps.findVersion({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      publicId: input.toolVersionId,
    });
    if (!version) {
      throw new HandlerError({
        code: "not_found",
        reason: "tool_version_not_found",
        message: `No tool version ${input.toolVersionId} in this workspace`,
      });
    }

    const at = now();
    await deps.write({
      versionId: version.id,
      riskGrade: input.riskGrade,
      classification: input.classification,
      reason: input.reason,
      userId: actingUserId,
      at,
    });

    emitSecurityEvent({
      eventType: "tool.classification_changed",
      actorUserId: actingUserId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: toolClassificationSet.name,
      outcome: "success",
      ip: ctx.clientIp ?? null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });

    return {
      toolVersionId: version.publicId,
      riskGrade: input.riskGrade,
      classification: input.classification,
      classifiedAt: at.toISOString(),
    };
  };
}

export const toolClassificationSetHandler = createToolClassificationSetHandler(
  postgresToolClassificationDeps,
);
