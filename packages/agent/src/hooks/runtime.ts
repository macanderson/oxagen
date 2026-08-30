import { insertExecutionLogs } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.hooks" },
});

export interface HookContext {
  ctx: CapabilityContext;
  capability: string;
  input?: unknown;
  output?: unknown;
  error?: Error;
  executionId?: string;
  stepId?: string;
}

async function emit(
  level: "info" | "error",
  h: HookContext,
  message: string,
): Promise<void> {
  logger[level]({ capability: h.capability }, message);
  try {
    await insertExecutionLogs([
      {
        execution_id: h.executionId ?? h.ctx.requestId,
        // NULL, not "" — step_id is a Nullable(UUID) column and ClickHouse
        // cannot parse "" as a UUID (it over-reads into the next field and
        // fails the whole insert). undefined stepId means "no step".
        step_id: h.stepId ?? null,
        org_id: h.ctx.orgId,
        workspace_id: h.ctx.workspaceId,
        log_level: level === "error" ? "error" : "info",
        message,
        metadata: JSON.stringify({
          capability: h.capability,
          requestId: h.ctx.requestId,
          error: h.error?.message,
        }),
        created_at: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    // Telemetry must never fail the surrounding call.
    logger.warn({ err }, "execution_logs insert failed");
  }
}

export const beforeTool = (h: HookContext) =>
  emit("info", h, `tool.before ${h.capability}`);
export const afterTool = (h: HookContext) =>
  emit("info", h, `tool.after ${h.capability}`);
export const onError = (h: HookContext) =>
  emit(
    "error",
    h,
    `tool.error ${h.capability}: ${h.error?.message ?? "unknown"}`,
  );
