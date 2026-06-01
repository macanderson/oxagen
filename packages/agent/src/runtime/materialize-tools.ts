import { tool, type Tool, type ToolSet } from "ai";
import { z, type ZodTypeAny } from "zod";
import { insertToolInvocation } from "@oxagen/telemetry";
import { requireEnv } from "@oxagen/config/env";
import type { CapabilityContext } from "../types.js";
import { invoke } from "@oxagen/oxagen/kernel";
import { beforeTool, afterTool, onError } from "../hooks/runtime.js";
import { createApprovalRequest, waitForApproval } from "./approval.js";
import { connectMcp, materializeMcpTools } from "../dispatch/mcp-client.js";
import { db, schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";

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
  input: ZodTypeAny;
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
  // OXA-1348: agent.code.execute requires a sandbox driver. Until the
  // Vercel-compatible driver ships, gate materialization on SANDBOX_ENABLED.
  // Off by default in prod so the tool is not advertised to the model.
  const sandboxEnabled = requireEnv(["SANDBOX_ENABLED"] as const).SANDBOX_ENABLED === true;
  const out: Record<string, Tool> = {};
  for (const cap of all) {
    if (!surfacesFn(cap).includes("agent")) continue;
    if (opts.allowlist && !opts.allowlist.has(cap.name)) continue;
    if (!passesRisk(cap, opts.riskCeiling)) continue;
    if (cap.name === "agent.code.execute" && !sandboxEnabled) continue;
    const riskLevel: "low" | "medium" | "high" = cap.agent?.riskLevel ?? "low";
    const requiresApproval = cap.agent?.requiresApproval === true;
    out[cap.name] = tool({
      description: cap.description,
      parameters: cap.input,
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
              orgId: ctx.orgId,
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
          const result = await invoke(cap.name, input, ctx, { surface: "agent" });
          await afterTool({ capability: cap.name, ctx, output: result });
          // OXA-1351: every tool invocation lands one row in ClickHouse
          // `tool_invocations` with surface + provider. Failure-isolated.
          try {
            await insertToolInvocation({
              invocation_id: invocationId,
              org_id: ctx.orgId,
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
              org_id: ctx.orgId,
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
  // ── MCP tool integration (OXA-1498) ─────────────────────────────────────────
  // Load tools from healthy registered MCP servers for this workspace.
  // Each MCP tool execution is METERED via insertToolInvocation under a
  // synthetic capability name `mcp.<serverId>.<toolName>` (audit trail).
  //
  // NOTE: MCP tools are metered, NOT individually IAM-enforced. Unlike the
  // capability-backed tools above (which route through invoke() and therefore
  // the full IAM kernel), MCP tools call the server transport directly, so an
  // IAM `deny` policy against a synthetic `mcp.*` capability is NOT applied
  // here even when IAM_ENFORCEMENT_ENABLED=true. Per-tool MCP enforcement
  // (routing each call through an IAM check against the synthetic capability)
  // is tracked separately; wiring it requires registering MCP tools as
  // first-class capabilities. Failures per-server are isolated — a degraded
  // server never blocks the model from receiving other tools.
  if (ctx.workspaceId) {
    let mcpServerRows: (typeof schema.mcpServers.$inferSelect)[] = [];
    try {
      mcpServerRows = await db()
        .select()
        .from(schema.mcpServers)
        .where(
          and(
            eq(schema.mcpServers.orgId, ctx.orgId),
            eq(schema.mcpServers.workspaceId, ctx.workspaceId),
            eq(schema.mcpServers.healthStatus, "healthy"),
          ),
        );
    } catch (err) {
      // DB failure must never block the model from receiving built-in tools.
      console.error("[materialize-tools] Failed to load MCP server rows:", err);
    }

    for (const server of mcpServerRows) {
      try {
        const authConfig = (server.authConfig ?? {}) as Record<string, string>;
        const client = await connectMcp({
          endpointUrl: server.endpointUrl,
          authStrategy: server.authStrategy as "none" | "bearer" | "header",
          authConfig,
        });
        const mcpTools = await materializeMcpTools(client, `mcp.${server.id}`);
        for (const [rawKey, rawTool] of Object.entries(mcpTools)) {
          // Wrap each MCP tool so every execution is metered with insertToolInvocation.
          const capturedKey = rawKey;
          const capturedExecute = rawTool.execute;
          if (typeof capturedExecute !== "function") continue;
          out[capturedKey] = tool({
            description: rawTool.description,
            parameters: z.record(z.string(), z.unknown()),
            execute: async (input: unknown) => {
              const invocationId = crypto.randomUUID();
              const startedAt = Date.now();
              try {
                // capturedExecute is the AI SDK Tool execute fn (input: T, options) => Promise<R>.
                // The MCP wrapper in mcp-client.ts returns a Tool whose execute takes one arg;
                // cast to the compatible double-arg form so TypeScript is satisfied.
                const result = await (capturedExecute as (
                  i: unknown,
                  o: { toolCallId: string; messages: unknown[] },
                ) => Promise<unknown>)(input, { toolCallId: invocationId, messages: [] });
                try {
                  await insertToolInvocation({
                    invocation_id: invocationId,
                    org_id: ctx.orgId,
                    workspace_id: ctx.workspaceId,
                    capability_name: capturedKey,
                    message_id: ctx.messageId ?? "00000000-0000-0000-0000-000000000000",
                    parent_message_id: null,
                    execution_step_id: null,
                    status: "completed",
                    input_size_bytes: byteSize(input),
                    output_size_bytes: byteSize(result),
                    latency_ms: Date.now() - startedAt,
                    error_class: null,
                    external_provider: "",
                    external_server_id: server.id,
                    risk_level: "low",
                    required_approval: 0,
                    surface: ctx.surface,
                    provider: "",
                    created_at: new Date().toISOString(),
                  });
                } catch {
                  /* telemetry must never fail the call */
                }
                return result;
              } catch (err) {
                try {
                  await insertToolInvocation({
                    invocation_id: invocationId,
                    org_id: ctx.orgId,
                    workspace_id: ctx.workspaceId,
                    capability_name: capturedKey,
                    message_id: ctx.messageId ?? "00000000-0000-0000-0000-000000000000",
                    parent_message_id: null,
                    execution_step_id: null,
                    status: "failed",
                    input_size_bytes: byteSize(input),
                    output_size_bytes: 0,
                    latency_ms: Date.now() - startedAt,
                    error_class: err instanceof Error ? err.name : "UnknownError",
                    external_provider: "",
                    external_server_id: server.id,
                    risk_level: "low",
                    required_approval: 0,
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
        // Close the connection after materializing tools.
        await client.close();
      } catch (err) {
        // Per-server failure is isolated — log and continue.
        console.error(
          `[materialize-tools] Failed to load MCP tools from server ${server.id} (${server.name}):`,
          err,
        );
      }
    }
  }
  // ── End MCP tools ─────────────────────────────────────────────────────────

  return out;
}
