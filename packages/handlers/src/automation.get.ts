import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationGet } from "@oxagen/oxagen/contracts/automation.get";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const automationGetHandler: CapabilityHandler<
  typeof automationGet
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "automation.get: rejected — no authenticated user",
    );
    throw new Error("automation.get requires an authenticated user");
  }

  const result = await withTenantDb(async (tx) => {
    // 1. Find the trigger by publicId, scoped to org + workspace.
    const [trigger] = await tx
      .select({
        publicId: schema.playbookTriggers.publicId,
        playbookId: schema.playbookTriggers.playbookId,
        triggerType: schema.playbookTriggers.triggerType,
        config: schema.playbookTriggers.config,
        isEnabled: schema.playbookTriggers.isEnabled,
      })
      .from(schema.playbookTriggers)
      .where(
        and(
          eq(schema.playbookTriggers.publicId, input.automation_id),
          eq(schema.playbookTriggers.orgId, ctx.orgId),
          eq(schema.playbookTriggers.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1);

    if (!trigger) {
      throw new Error("automation.get: automation not found");
    }

    // 2. Find the parent playbook.
    const [playbook] = await tx
      .select({
        publicId: schema.playbooks.publicId,
        name: schema.playbooks.name,
        description: schema.playbooks.description,
        status: schema.playbooks.status,
        activeVersionId: schema.playbooks.activeVersionId,
      })
      .from(schema.playbooks)
      .where(
        and(
          eq(schema.playbooks.id, trigger.playbookId),
          isNull(schema.playbooks.deletedAt),
        ),
      )
      .limit(1);

    if (!playbook) {
      throw new Error("automation.get: automation not found");
    }

    // 3. Steps for the active version (empty when there is no active version).
    const steps = playbook.activeVersionId
      ? await tx
          .select({
            stepKey: schema.playbookSteps.stepKey,
            name: schema.playbookSteps.name,
            stepType: schema.playbookSteps.stepType,
            config: schema.playbookSteps.config,
          })
          .from(schema.playbookSteps)
          .where(
            eq(
              schema.playbookSteps.playbookVersionId,
              playbook.activeVersionId,
            ),
          )
          .orderBy(schema.playbookSteps.createdAt)
      : [];

    // 4. Recent run history, newest first.
    const runs = await tx
      .select({
        id: schema.playbookRuns.id,
        status: schema.playbookRuns.status,
        source: schema.playbookRuns.source,
        startedAt: schema.playbookRuns.startedAt,
        completedAt: schema.playbookRuns.completedAt,
        createdAt: schema.playbookRuns.createdAt,
      })
      .from(schema.playbookRuns)
      .where(eq(schema.playbookRuns.playbookId, trigger.playbookId))
      .orderBy(desc(schema.playbookRuns.createdAt))
      .limit(20);

    return { trigger, playbook, steps, runs };
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      automationId: result.trigger.publicId,
    },
    "automation.get: returned automation detail",
  );

  return {
    automation_id: result.trigger.publicId,
    playbook_id: result.playbook.publicId,
    name: result.playbook.name,
    description: result.playbook.description,
    status: result.playbook.status,
    triggerType: result.trigger.triggerType as "event" | "schedule" | "api",
    enabled: result.trigger.isEnabled,
    triggerConfig: result.trigger.config as Record<string, unknown>,
    steps: result.steps.map((step) => ({
      stepKey: step.stepKey,
      name: step.name,
      stepType: step.stepType,
      config: step.config as Record<string, unknown>,
    })),
    runs: result.runs.map((run) => ({
      id: run.id,
      status: run.status,
      source: run.source,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
      createdAt: run.createdAt.toISOString(),
    })),
  };
};
