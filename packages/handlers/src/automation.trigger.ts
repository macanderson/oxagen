import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationTrigger } from "@oxagen/oxagen/contracts/automation.trigger";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { eventClient } from "./event-client";
import { logger } from "./logger";

export const automationTriggerHandler: CapabilityHandler<
  typeof automationTrigger
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "automation.trigger: rejected — no authenticated user",
    );
    throw new Error("automation.trigger requires an authenticated user");
  }

  // Resolve the playbook trigger by publicId within this workspace.
  const trigger = await withTenantDb((tx) =>
    tx.query.playbookTriggers.findFirst({
      where: and(
        eq(schema.playbookTriggers.publicId, input.automation_id),
        eq(schema.playbookTriggers.orgId, ctx.orgId),
        eq(schema.playbookTriggers.workspaceId, ctx.workspaceId),
        eq(schema.playbookTriggers.isEnabled, true),
      ),
      columns: {
        id: true,
        publicId: true,
        playbookId: true,
        pinnedVersionId: true,
      },
    }),
  );

  if (!trigger) {
    throw new Error(
      `automation.trigger: trigger not found: ${input.automation_id}`,
    );
  }

  // Load the playbook's active version.
  const playbook = await withTenantDb((tx) =>
    tx.query.playbooks.findFirst({
      where: and(
        eq(schema.playbooks.id, trigger.playbookId),
        eq(schema.playbooks.orgId, ctx.orgId),
        isNull(schema.playbooks.deletedAt),
      ),
      columns: { id: true, activeVersionId: true },
    }),
  );

  if (!playbook?.activeVersionId) {
    throw new Error(
      `automation.trigger: playbook has no active version: ${trigger.playbookId}`,
    );
  }

  const versionId = trigger.pinnedVersionId ?? playbook.activeVersionId;

  const [run] = await withTenantDb((tx) =>
    tx
      .insert(schema.playbookRuns)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        playbookId: trigger.playbookId,
        playbookVersionId: versionId,
        triggerId: trigger.id,
        source: "api",
        status: "pending",
        input: input.payload ?? {},
        startedByUserId: ctx.userId!,
      })
      .returning({
        id: schema.playbookRuns.id,
        status: schema.playbookRuns.status,
      }),
  );

  if (!run) throw new Error("automation.trigger: run insert returned no row");

  // Dispatch the executor — run is now pending and ready to execute
  await eventClient.send({
    name: "playbook/run.execute",
    data: {
      runId: run.id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
  });

  logger.info(
    {
      runId: run.id,
      triggerId: trigger.id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "automation.trigger: dispatched playbook run",
  );

  return {
    execution_id: run.id,
    status: run.status,
  };
};
