import { tool, type Tool, type ToolSet } from "ai";
import { z, type ZodTypeAny } from "zod";
import { insertToolInvocation } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types";
import { invoke, authorizeExternalCapability } from "@oxagen/oxagen/kernel";
import { beforeTool, afterTool, onError } from "../hooks/runtime";
import { createApprovalRequest, waitForApproval } from "./approval";
import { connectMcp, materializeMcpTools } from "../dispatch/mcp-client";
import { isSandboxAvailable } from "@oxagen/sandbox";
import { withTenantDb, schema } from "@oxagen/database";
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

// Result of materializeTools: the Vercel AI SDK tool map keyed by *model-safe*
// names, plus a reverse map from each model-safe name back to the real
// capability name. See toModelToolName for why the keys must be sanitized.
export interface MaterializedTools {
  tools: ToolSet;
  // model-safe tool name → real capability name (e.g.
  // "agent_code_execute" → "agent.code.execute"). The route translates
  // tool-call stream events back to the real name for the UI.
  nameMap: Record<string, string>;
}

// Provider tool-name constraint enforced by the Vercel AI Gateway (and the
// OpenAI / Anthropic / Bedrock backends it routes to): a function/tool name
// must match ^[a-zA-Z0-9_-]{1,128}$. Oxagen capability names are dotted
// (e.g. "agent.code.execute", "form.fill"), and MCP synthetic keys embed
// dots too ("mcp.<serverId>.<tool>"), so passing them verbatim makes the
// gateway reject EVERY tool-bearing turn with a 400
// ("tools.0.custom.name: String should match pattern ..."). Present the model
// a sanitized alias instead; the tool's execute() closure still invokes the
// real dotted capability, so behaviour is unchanged.
const MODEL_TOOL_NAME_MAX = 128;

export function toModelToolName(capabilityName: string): string {
  return capabilityName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MODEL_TOOL_NAME_MAX);
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
): Promise<MaterializedTools> {
  await ensureRegistry();
  const listFn = _listCapabilities;
  const surfacesFn = _getSurfaces;
  if (!listFn || !surfacesFn) throw new Error("registry not initialized");
  const all = listFn();
  // OXA-1348: agent.code.execute requires a configured sandbox driver. Gate
  // materialization on isSandboxAvailable() — the single source of truth that
  // checks SANDBOX_ENABLED=true AND that the configured driver has the required
  // credentials. The tool is only advertised to the model when it can actually
  // execute; a non-functional tool is never shown.
  const sandboxAvailable = isSandboxAvailable();
  const out: Record<string, Tool> = {};
  const nameMap: Record<string, string> = {};

  // Register a tool under a model-safe alias and record the reverse mapping.
  // Sanitizing collapses distinct chars to "_", so two real names could in
  // principle map to one alias; disambiguate deterministically with a numeric
  // suffix so every tool stays addressable and the reverse map is exact.
  function register(realName: string, toolDef: Tool): void {
    let alias = toModelToolName(realName);
    if (nameMap[alias] !== undefined && nameMap[alias] !== realName) {
      let n = 2;
      const base = alias.slice(0, MODEL_TOOL_NAME_MAX - 3);
      while (nameMap[`${base}_${n}`] !== undefined) n += 1;
      alias = `${base}_${n}`;
    }
    out[alias] = toolDef;
    nameMap[alias] = realName;
  }
  for (const cap of all) {
    if (!surfacesFn(cap).includes("agent")) continue;
    if (opts.allowlist && !opts.allowlist.has(cap.name)) continue;
    if (!passesRisk(cap, opts.riskCeiling)) continue;
    if (cap.name === "agent.code.execute" && !sandboxAvailable) continue;
    const riskLevel: "low" | "medium" | "high" = cap.agent?.riskLevel ?? "low";
    const requiresApproval = cap.agent?.requiresApproval === true;
    register(cap.name, tool({
      description: cap.description,
      inputSchema: cap.input,
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
    }));
  }
  // ── MCP tool integration (OXA-1498) ─────────────────────────────────────────
  // Load tools from healthy registered MCP servers for this workspace.
  // Each MCP tool execution is:
  //   1. IAM-checked via authorizeExternalCapability() against the synthetic
  //      capability id `mcp.<serverId>.<toolName>`. defaultEffect is "allow"
  //      because the user intentionally registered the server; an explicit
  //      deny/require_approval policy against the synthetic id overrides this.
  //   2. METERED via insertToolInvocation — whether the call was allowed,
  //      blocked by IAM, or failed. The full invocation trail is preserved
  //      ([[instrument-everything]]).
  // Failures per-server are isolated — a degraded server never blocks the
  // model from receiving other tools.
  if (ctx.workspaceId) {
    let mcpServerRows: (typeof schema.mcpServers.$inferSelect)[] = [];
    try {
      mcpServerRows = await withTenantDb((tx) =>
        tx
          .select()
          .from(schema.mcpServers)
          .where(
            and(
              eq(schema.mcpServers.orgId, ctx.orgId),
              eq(schema.mcpServers.workspaceId, ctx.workspaceId),
              eq(schema.mcpServers.healthStatus, "healthy"),
            ),
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
          register(capturedKey, tool({
            description: rawTool.description,
            inputSchema: z.record(z.string(), z.unknown()),
            execute: async (input: unknown) => {
              const invocationId = crypto.randomUUID();
              const startedAt = Date.now();

              // ── IAM gate (GAP-4) ────────────────────────────────────────────
              // capturedKey is the synthetic capability id for this tool:
              // `mcp.<serverId>.<toolName>`. Run the same IAM gate as invoke()
              // so an explicit deny/require_approval policy against the
              // synthetic id is honoured when IAM_ENFORCEMENT_ENABLED=true.
              // defaultEffect="allow" — the user intentionally registered this
              // server; absent any explicit policy the call is permitted.
              const iamResult = await authorizeExternalCapability(
                capturedKey,
                ctx,
                "allow",
              );
              if (!iamResult.allowed) {
                // Record the blocked invocation in the audit trail.
                try {
                  await insertToolInvocation({
                    invocation_id: invocationId,
                    org_id: ctx.orgId,
                    workspace_id: ctx.workspaceId,
                    capability_name: capturedKey,
                    message_id: ctx.messageId ?? "00000000-0000-0000-0000-000000000000",
                    parent_message_id: null,
                    execution_step_id: null,
                    // ToolInvocationRow has no "denied" status; encode IAM
                    // denial as "failed" + error_class="IamDenied" — the same
                    // information, queryable in ClickHouse the same way.
                    status: "failed",
                    input_size_bytes: byteSize(input),
                    output_size_bytes: 0,
                    latency_ms: Date.now() - startedAt,
                    error_class: "IamDenied",
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
                // Return a structured error the model can read and surface to
                // the user. Do NOT throw — a thrown error would cause the AI SDK
                // to mark the turn as failed; a returned string lets the model
                // reason about the denial and stop gracefully.
                const reason = iamResult.reason ?? iamResult.outcome;
                return `Tool blocked by workspace policy: ${reason}`;
              }
              // ── End IAM gate ────────────────────────────────────────────────

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
          }));
        }
        // Do NOT close the connection here. Every materialized tool's
        // `execute` closure (via materializeMcpTools) calls `client.callTool`
        // on THIS client, and those calls happen later, while the model
        // streams. Closing now would terminate the transport before any MCP
        // tool runs, so every MCP tool call would throw. The StreamableHTTP
        // connection is request-scoped and is torn down when the streaming
        // request/runtime context ends; keeping it open also preserves any
        // MCP session state across multiple tool calls within the turn.
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

  return { tools: out, nameMap };
}
