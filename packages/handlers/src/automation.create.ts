import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationCreate } from "@oxagen/oxagen/contracts/automation.create";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

function toStepKey(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 60) || "step_1"
  );
}

export const automationCreateHandler: CapabilityHandler<
  typeof automationCreate
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "automation.create: rejected — no authenticated user",
    );
    throw new Error("automation.create requires an authenticated user");
  }

  // Cross-field trigger validation.
  if (input.triggerType === "event") {
    if (!input.triggerConfig.entityType || !input.triggerConfig.eventType) {
      throw new Error(
        "automation.create: triggerType='event' requires triggerConfig.entityType and triggerConfig.eventType",
      );
    }
  }
  if (input.triggerType === "schedule") {
    if (!input.triggerConfig.cronExpression) {
      throw new Error(
        "automation.create: triggerType='schedule' requires triggerConfig.cronExpression",
      );
    }
  }

  // Human-origin: direct API/app call without an in-chat messageId.
  // MCP and runner surfaces are always AI-origin. In-chat agent calls carry a
  // messageId regardless of surface, so they are AI-origin too.
  const humanOrigin =
    (ctx.surface === "api" || ctx.surface === "app") && ctx.messageId == null;
  const isEnabled = humanOrigin && input.enabled;

  const userId = ctx.userId;

  const slug =
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "automation";

  // Default step when no steps are provided.
  const stepsToInsert =
    input.steps.length > 0
      ? input.steps
      : [
          {
            name: "Run Agent",
            stepType: "agent" as const,
            config: { agentSlug: "qa-chat" },
          },
        ];

  const result = await withTenantDb(async (tx) => {
    // 1. Insert the playbook shell. Status is "active" if trigger starts enabled.
    const [playbook] = await tx
      .insert(schema.playbooks)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        name: input.name,
        slug,
        description: input.description ?? null,
        status: isEnabled ? "active" : "draft",
        visibility: "workspace",
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({
        id: schema.playbooks.id,
        publicId: schema.playbooks.publicId,
      });

    if (!playbook)
      throw new Error("automation.create: playbook insert returned no row");

    // 2. Insert the initial playbook version (v1, published).
    const [version] = await tx
      .insert(schema.playbookVersions)
      .values({
        playbookId: playbook.id,
        version: 1,
        isPublished: true,
        publishedAt: new Date(),
        createdByUserId: userId,
      })
      .returning({ id: schema.playbookVersions.id });

    if (!version)
      throw new Error("automation.create: version insert returned no row");

    // 3. Insert steps for this version.
    for (const step of stepsToInsert) {
      await tx.insert(schema.playbookSteps).values({
        playbookVersionId: version.id,
        stepKey: toStepKey(step.name),
        name: step.name,
        stepType: step.stepType,
        isAsync: false,
        exitOnError: true,
        config: step.config,
      });
    }

    // 4. Set the playbook's active version.
    await tx
      .update(schema.playbooks)
      .set({ activeVersionId: version.id })
      .where(eq(schema.playbooks.id, playbook.id));

    // 5. Insert the playbook trigger.
    const [trigger] = await tx
      .insert(schema.playbookTriggers)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        playbookId: playbook.id,
        triggerType: input.triggerType,
        config: input.triggerConfig,
        isEnabled,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({
        publicId: schema.playbookTriggers.publicId,
        triggerType: schema.playbookTriggers.triggerType,
        isEnabled: schema.playbookTriggers.isEnabled,
      });

    if (!trigger)
      throw new Error("automation.create: trigger insert returned no row");

    return { playbook, trigger };
  });

  logger.info(
    {
      publicId: result.trigger.publicId,
      playbookId: result.playbook.id,
      playbookPublicId: result.playbook.publicId,
      triggerType: result.trigger.triggerType,
      isEnabled: result.trigger.isEnabled,
      humanOrigin,
      orgId: ctx.orgId,
    },
    "automation.create: created playbook trigger",
  );

  return {
    automation_id: result.trigger.publicId,
    playbook_id: result.playbook.publicId,
    name: input.name,
    status: result.trigger.isEnabled ? "active" : "inactive",
    triggerType: result.trigger.triggerType,
    enabled: result.trigger.isEnabled,
  };
};
