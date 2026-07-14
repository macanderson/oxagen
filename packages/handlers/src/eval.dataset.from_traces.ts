import type { CapabilityHandler } from "@oxagen/oxagen";
import { evalDatasetFromTraces } from "@oxagen/oxagen/contracts/eval.dataset.from_traces";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { chSelect } from "@oxagen/telemetry";
import { slugify } from "./lib/asset-filename";
import { logger } from "./logger";

/**
 * Read the set of metered turn ids for this workspace within the window. These
 * ground the dataset in what actually ran and got billed (the wedge). When a
 * capability is named we use tool_invocations (which carries capability_name);
 * otherwise we use token_usage.execution_step_id — the id of the turn that
 * incurred token spend. Both reads are tenant-scoped via chSelect (fail-closed
 * on org_id). A ClickHouse hiccup degrades to an empty set, not a failure.
 */
async function meteredTurnIds(
  sinceHours: number,
  capabilityName: string | undefined,
): Promise<string[]> {
  const NIL = "00000000-0000-0000-0000-000000000000";
  try {
    if (capabilityName) {
      const res = await chSelect<{ id: string }>({
        query: `
          SELECT DISTINCT message_id AS id
          FROM tool_invocations
          WHERE org_id = {orgId:UUID}
            AND workspace_id = {workspaceId:UUID}
            AND capability_name = {cap:String}
            AND created_at >= now() - INTERVAL {sinceHours:UInt32} HOUR
          LIMIT 2000
        `,
        params: { cap: capabilityName, sinceHours },
      });
      return res.data.map((r) => r.id).filter((id) => id && id !== NIL);
    }
    const res = await chSelect<{ id: string }>({
      query: `
        SELECT DISTINCT toString(execution_step_id) AS id
        FROM token_usage
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND created_at >= now() - INTERVAL {sinceHours:UInt32} HOUR
        LIMIT 2000
      `,
      params: { sinceHours },
    });
    return res.data.map((r) => r.id).filter((id) => id && id !== NIL);
  } catch (err) {
    logger.warn({ err }, "eval.dataset.from_traces: metered-trace read failed");
    return [];
  }
}

export const evalDatasetFromTracesHandler: CapabilityHandler<
  typeof evalDatasetFromTraces
> = async (input, ctx) => {
  const slug = input.slug ?? (slugify(input.name).slice(0, 60) || "traces");
  const turnIds = await meteredTurnIds(input.sinceHours, input.capabilityName);

  try {
    return await withTenantDb(async (tx) => {
      const [dataset] = await tx
        .insert(schema.evalDatasets)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          name: input.name,
          slug,
          description:
            input.description ??
            `Captured from ${turnIds.length} metered ${input.capabilityName ?? "run"} turn(s)`,
          source: "traces",
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning({
          id: schema.evalDatasets.id,
          publicId: schema.evalDatasets.publicId,
          slug: schema.evalDatasets.slug,
        });
      if (!dataset) throw new Error("eval_datasets insert failed");

      // Resolve the real user-message text behind the metered turns. The chat
      // path stamps the telemetry turn id as the conversation id, so match on
      // either conversation_id or the message id to cover every surface.
      const meteredFilter =
        turnIds.length > 0
          ? or(
              inArray(schema.messages.conversationId, turnIds),
              inArray(schema.messages.id, turnIds),
            )
          : undefined;

      const selectUserMessages = (withMeteredFilter: boolean) =>
        tx
          .select({
            id: schema.messages.publicId,
            conversationId: schema.messages.conversationId,
            content: schema.messages.content,
            createdAt: schema.messages.createdAt,
          })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.workspaceId, ctx.workspaceId),
              eq(schema.messages.role, "user"),
              withMeteredFilter ? meteredFilter : undefined,
            ),
          )
          .orderBy(desc(schema.messages.createdAt))
          .limit(input.limit);

      let rows = await selectUserMessages(turnIds.length > 0);
      // If the metered turns resolved to no messages (e.g. non-chat surfaces),
      // fall back to the workspace's recent user messages so the dataset is
      // never empty — still real production inputs, just not turn-linked.
      if (rows.length === 0 && turnIds.length > 0) {
        rows = await selectUserMessages(false);
      }

      if (rows.length > 0) {
        await tx.insert(schema.evalDatasetItems).values(
          rows.map((m) => ({
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            datasetId: dataset.id,
            input: m.content,
            expectedOutput: null,
            metadata: {
              source: "trace",
              messageId: m.id,
              conversationId: m.conversationId,
              capturedAt: m.createdAt.toISOString(),
            },
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          })),
        );
        await tx
          .update(schema.evalDatasets)
          .set({ itemCount: rows.length })
          .where(eq(schema.evalDatasets.id, dataset.id));
      }

      logger.info(
        {
          datasetId: dataset.publicId,
          itemCount: rows.length,
          meteredTurns: turnIds.length,
        },
        "create_trace_dataset",
      );

      return {
        datasetId: dataset.publicId,
        publicId: dataset.publicId,
        slug: dataset.slug,
        itemCount: rows.length,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HTTPException(409, {
        message: `an eval dataset with slug "${slug}" already exists in this workspace`,
      });
    }
    throw err;
  }
};
