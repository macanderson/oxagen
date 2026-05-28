import { tool, type Tool, type ToolSet } from "ai";
import { insertToolInvocation } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types.js";
import { invokeCapability } from "../handlers/index.js";
import { beforeTool, afterTool, onError } from "../hooks/runtime.js";
import { createApprovalRequest, waitForApproval } from "./approval.js";

function byteSize(v: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(v ?? null)).length;
  } catch {
    return 0;
  }
}

// Imported dynamically to avoid a static package cycle:
// @oxagen/oxagen handlers depend on @oxagen/agent for helpers; if this
// file pulled oxagen at top-level we'd have a build-time cycle.
type AnyCapability = {
  name: string;
  description: string;
  agent?: { riskLevel?: "low" | "medium" | "high"; category?: string; requiresApproval?: boolean };
  input: unknown;
  surfaces?: readonly ("api" | "mcp" | "agent")[];
};

let _listCapabilities: (() => AnyCapability[]) | null = null;
let _getSurfaces: ((c: AnyCapability) => readonly string[]) | null = null;

async function ensureRegistry(): Promise<void> {
  if (_listCapabilities) return;
  const mod = (await import("@oxagen/oxagen")) as unknown as {
    listCapabilities: () => AnyCapability[];
    getSurfaces: (c: AnyCapability) => readonly string[];
  };
  _listCapabilities = mod.listCapabilities;
  _getSurfaces = mod.getSurfaces;
}

export interface MaterializeOptions {
  allowlist?: Set<string>;
  // Workspace risk policy: when set to "low" or "medium", any capability
  // with a strictly-higher riskLevel is filtered out of the tool set.
  riskCeiling?: "low" | "medium" | "high";
}

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };

function passesRisk(cap: AnyCapability, ceiling?: MaterializeOptions["riskCeiling"]): boolean {
  if (!ceiling) return true;
  const capRisk = cap.agent?.riskLevel ?? "low";
  return (RISK_ORDER[capRisk] ?? 0) <= (RISK_ORDER[ceiling] ?? 0);
}

// Build the Vercel AI SDK tool map for a workspace turn. Filters by
// allowlist + risk policy, never crosses tenant boundaries (the handler
// itself enforces scope from CapabilityContext).
export async function materializeTools(
  ctx: CapabilityContext,
  opts: MaterializeOptions = {},
): Promise<ToolSet> {
  await ensureRegistry();
  const listFn = _listCapabilities;
  const surfacesFn = _getSurfaces;
  if (!listFn || !surfacesFn) throw new Error("registry not initialized");
  const all = listFn();
  const out: Record<string, Tool> = {};
  for (const cap of all) {
    if (!surfacesFn(cap).includes("agent")) continue;
    if (opts.allowlist && !opts.allowlist.has(cap.name)) continue;
    if (!passesRisk(cap, opts.riskCeiling)) continue;
    const riskLevel: "low" | "medium" | "high" = cap.agent?.riskLevel ?? "low";
    const requiresApproval = cap.agent?.requiresApproval === true;
    out[cap.name] = tool({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cap.input is a zod schema; AI SDK accepts ZodTypeAny.
      description: cap.description,
      parameters: cap.input as any,
      execute: async (input: unknown) => {
        await beforeTool({ capability: cap.name, ctx, input });
        const invocationId = crypto.randomUUID();
        const startedAt = Date.now();
        const inputBytes = byteSize(input);
        try {
          // Approval gate. Only fires when the capability declares
          // `requiresApproval: true` AND we have a `messageId` to attach the
          // request to in the chat DAG. Direct API / MCP callers skip the
          // gate (their auth surface is responsible for authorization).
          if (requiresApproval && ctx.messageId) {
            const { approvalId } = await createApprovalRequest({
              tenantId: ctx.tenantId,
              workspaceId: ctx.workspaceId,
              messageId: ctx.messageId,
              capabilityName: cap.name,
              inputPreview: input,
              riskLevel,
            });
            const resolution = await waitForApproval(approvalId);
            if (resolution.resolution !== "approved") {
              throw new Error(`approval ${resolution.resolution} for ${cap.name}`);
            }
          }
          const result = await invokeCapability(cap.name, input, ctx);
          await afterTool({ capability: cap.name, ctx, output: result });
          // OXA-1351: every tool invocation lands one row in ClickHouse
          // `tool_invocations` with surface + provider. Failure-isolated.
          try {
            await insertToolInvocation({
              invocation_id: invocationId,
              tenant_id: ctx.tenantId,
              workspace_id: ctx.workspaceId,
              capability_name: cap.name,
              message_id: ctx.messageId ?? "00000000-0000-0000-0000-000000000000",
              parent_message_id: null,
              execution_step_id: null,
              status: "completed",
              input_size_bytes: inputBytes,
              output_size_bytes: byteSize(result),
              latency_ms: Date.now() - startedAt,
              error_class: null,
              external_provider: "",
              external_server_id: null,
              risk_level: riskLevel,
              required_approval: requiresApproval ? 1 : 0,
              surface: ctx.surface,
              provider: "",
              created_at: new Date().toISOString(),
            });
          } catch {
            /* telemetry must never fail the call */
          }
          return result;
        } catch (err) {
          await onError({
            capability: cap.name,
            ctx,
            error: err instanceof Error ? err : new Error(String(err)),
          });
          try {
            await insertToolInvocation({
              invocation_id: invocationId,
              tenant_id: ctx.tenantId,
              workspace_id: ctx.workspaceId,
              capability_name: cap.name,
              message_id: ctx.messageId ?? "00000000-0000-0000-0000-000000000000",
              parent_message_id: null,
              execution_step_id: null,
              status: "failed",
              input_size_bytes: inputBytes,
              output_size_bytes: 0,
              latency_ms: Date.now() - startedAt,
              error_class: err instanceof Error ? err.name : "UnknownError",
              external_provider: "",
              external_server_id: null,
              risk_level: riskLevel,
              required_approval: requiresApproval ? 1 : 0,
              surface: ctx.surface,
              provider: "",
              created_at: new Date().toISOString(),
            });
          } catch {
            /* swallow */
          }
          throw err;
        }
      },
    });
  }
  return out;
}
