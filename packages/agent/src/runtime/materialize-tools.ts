import { tool, type Tool, type ToolSet } from "@oxagen/ai";
import { z, type ZodTypeAny } from "zod";
import pino from "pino";
import { insertToolInvocation, type ToolInvocationRow } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types";
import { invoke, authorizeExternalCapability } from "@oxagen/oxagen/kernel";
import { pluginForContract } from "@oxagen/oxagen/plugins";
import { listEntitledCapabilityPluginIds } from "@oxagen/plugins";
import { beforeTool, afterTool, onError } from "../hooks/runtime";
import { createApprovalRequest, waitForApproval } from "./approval";
import { isSandboxAvailable } from "@oxagen/sandbox";
import {
  getPluginTypeContributors,
  type ContributedRawTool,
} from "./plugin-type";
import { getOxagenRegistry, type RegistryCapability } from "../registry-loader";
// Side-effect imports register the plugin-type contributors.
import "./plugin-types/mcp";
import "./plugin-types/placeholders";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "agent.materialize-tools" } });

function byteSize(v: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(v ?? null)).length;
  } catch {
    return 0;
  }
}

// Central factory for tool invocation telemetry rows.
// Keeps the 15+ shared fields in one place and makes varying fields explicit,
// preventing silent desync across the five call sites in materializeTools.
function buildInvocationPayload(
  base: {
    invocationId: string;
    ctx: CapabilityContext;
    capabilityName: string;
    externalServerId?: string | null;
    riskLevel?: "low" | "medium" | "high";
    requiredApproval?: 0 | 1;
    inputBytes: number;
  },
  overrides: {
    status: ToolInvocationRow["status"];
    outputBytes: number;
    latencyMs: number;
    errorClass?: string | null;
  },
): ToolInvocationRow {
  return {
    invocation_id: base.invocationId,
    org_id: base.ctx.orgId,
    workspace_id: base.ctx.workspaceId,
    capability_name: base.capabilityName,
    message_id: base.ctx.messageId ?? "00000000-0000-0000-0000-000000000000",
    parent_message_id: null,
    execution_step_id: null,
    status: overrides.status,
    input_size_bytes: base.inputBytes,
    output_size_bytes: overrides.outputBytes,
    latency_ms: overrides.latencyMs,
    error_class: overrides.errorClass ?? null,
    external_provider: "",
    external_server_id: base.externalServerId ?? null,
    risk_level: base.riskLevel ?? "low",
    required_approval: base.requiredApproval ?? 0,
    surface: base.ctx.surface,
    provider: "",
    created_at: new Date().toISOString(),
  };
}

// AnyCapability is an alias for the shared RegistryCapability type from
// registry-loader — kept local so internal usages remain readable.
type AnyCapability = RegistryCapability;

export interface ApprovalRequiredEvent {
  approvalId: string;
  capability: string;
  inputPreview: unknown;
  riskLevel: "low" | "medium" | "high";
  /** ISO string — when the approval request expires server-side. */
  expiresAt: string;
}

export interface MaterializeOptions {
  allowlist?: Set<string>;
  // Workspace risk policy: when set to "low" or "medium", any capability
  // with a strictly-higher riskLevel is filtered out of the tool set.
  riskCeiling?: "low" | "medium" | "high";
  /** When provided, only MCP servers whose publicId is in this set are loaded for the turn. */
  serverAllowlist?: Set<string>;
  /**
   * Called immediately after an approval request is created and BEFORE
   * `waitForApproval` blocks. Lets the stream route emit an
   * `approval-required` SSE event so the client renders the approval card
   * before execution pauses. Without this callback the stream hangs silently
   * until the 5-minute TTL expires — the approval card never appears.
   */
  onApprovalRequired?: (event: ApprovalRequiredEvent) => void;
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
// Default TTL must stay in sync with approval.ts DEFAULT_TTL_MS (5 min).
const APPROVAL_TTL_MS = 5 * 60 * 1000;

export async function materializeTools(
  ctx: CapabilityContext,
  opts: MaterializeOptions = {},
): Promise<MaterializedTools> {
  const { listCapabilities, getSurfaces } = await getOxagenRegistry();
  const all = listCapabilities();
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
  // This is the tool-LIST filter only (UX layer). The kernel gate is the real
  // security enforcement boundary.
  let entitledPluginIds: Set<string> | null = null;
  let entitlementFetchFailed = false;

  for (const cap of all) {
    if (!getSurfaces(cap).includes("agent")) continue;
    if (opts.allowlist && !opts.allowlist.has(cap.name)) continue;
    if (!passesRisk(cap, opts.riskCeiling)) continue;
    if (cap.name === "agent.code.execute" && !sandboxAvailable) continue;

    // Entitlement filter: if this capability is claimed by a plugin, verify the
    // org has that plugin installed and enabled. Lazily fetch the entitled set
    // on first plugin-claimed contract to avoid DB round-trips when no plugin
    // capabilities are present.
    const plugin = pluginForContract(cap.name);
    if (plugin) {
      if (!entitlementFetchFailed && entitledPluginIds === null) {
        try {
          entitledPluginIds = await listEntitledCapabilityPluginIds(ctx.orgId);
        } catch (err) {
          logger.warn({ err, orgId: ctx.orgId }, "entitlement fetch failed — excluding all plugin-claimed capabilities (fail-closed)");
          entitlementFetchFailed = true;
        }
      }
      // Fail-closed: if fetch threw, exclude all plugin-claimed tools.
      if (entitlementFetchFailed || !entitledPluginIds!.has(plugin.id)) continue;
    }
    const riskLevel: "low" | "medium" | "high" = cap.agent?.riskLevel ?? "low";
    const requiresApproval = cap.agent?.requiresApproval === true;
    register(cap.name, tool({
      description: cap.description,
      inputSchema: cap.input as ZodTypeAny,
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
            const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
            const { approvalId } = await createApprovalRequest({
              orgId: ctx.orgId,
              workspaceId: ctx.workspaceId,
              messageId: ctx.messageId,
              capabilityName: cap.name,
              inputPreview: input,
              riskLevel,
            });
            // Emit approval-required event BEFORE blocking so the stream route
            // can forward it to the client immediately. Without this, the SSE
            // channel goes silent during the waitForApproval block and the
            // approval card never renders — the stream appears hung.
            opts.onApprovalRequired?.({
              approvalId,
              capability: cap.name,
              inputPreview: input,
              riskLevel,
              expiresAt,
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
            await insertToolInvocation(buildInvocationPayload(
              { invocationId, ctx, capabilityName: cap.name, riskLevel, requiredApproval: requiresApproval ? 1 : 0, inputBytes },
              { status: "completed", outputBytes: byteSize(result), latencyMs: Date.now() - startedAt },
            ));
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
            await insertToolInvocation(buildInvocationPayload(
              { invocationId, ctx, capabilityName: cap.name, riskLevel, requiredApproval: requiresApproval ? 1 : 0, inputBytes },
              { status: "failed", outputBytes: 0, latencyMs: Date.now() - startedAt, errorClass: err instanceof Error ? err.name : "UnknownError" },
            ));
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
  // The PluginType spine yields the per-tool work (governance query, connect,
  // credential decrypt, list); the wrapping below applies the IAM gate +
  // metering uniformly to every contributed tool, keyed by externalServerId.
  for (const contributor of getPluginTypeContributors()) {
    let contributed: ContributedRawTool[] = [];
    try {
      contributed = await contributor.contributeTools(ctx, { serverAllowlist: opts.serverAllowlist });
    } catch (err) {
      logger.error({ pluginType: contributor.type, err }, "plugin type contributor failed");
    }
    for (const raw of contributed) {
      const capturedKey = raw.realName;
      const externalServerId = raw.externalServerId;
      const capturedExecute = raw.execute;
      register(capturedKey, tool({
        description: raw.description,
        inputSchema: z.record(z.string(), z.unknown()),
        execute: async (input: unknown) => {
          const invocationId = crypto.randomUUID();
          const startedAt = Date.now();

          // ── IAM gate (GAP-4) ────────────────────────────────────────────
          // capturedKey is the synthetic capability id, e.g.
          // `mcp.<serverId>.<toolName>`. Same IAM gate as invoke();
          // defaultEffect="allow" — the admin intentionally installed +
          // enabled this plugin, but an explicit deny/require_approval policy
          // against the synthetic id is honoured when IAM is enforced.
          const iamResult = await authorizeExternalCapability(
            capturedKey,
            ctx,
            "allow",
          );
          if (!iamResult.allowed) {
            try {
              await insertToolInvocation(buildInvocationPayload(
                { invocationId, ctx, capabilityName: capturedKey, externalServerId, inputBytes: byteSize(input) },
                { status: "failed", outputBytes: 0, latencyMs: Date.now() - startedAt, errorClass: "IamDenied" },
              ));
            } catch {
              /* telemetry must never fail the call */
            }
            const reason = iamResult.reason ?? iamResult.outcome;
            return `Tool blocked by workspace policy: ${reason}`;
          }
          // ── End IAM gate ────────────────────────────────────────────────

          try {
            const result = await capturedExecute(input, {
              toolCallId: invocationId,
              messages: [],
            });
            try {
              await insertToolInvocation(buildInvocationPayload(
                { invocationId, ctx, capabilityName: capturedKey, externalServerId, inputBytes: byteSize(input) },
                { status: "completed", outputBytes: byteSize(result), latencyMs: Date.now() - startedAt },
              ));
            } catch {
              /* telemetry must never fail the call */
            }
            return result;
          } catch (err) {
            try {
              await insertToolInvocation(buildInvocationPayload(
                { invocationId, ctx, capabilityName: capturedKey, externalServerId, inputBytes: byteSize(input) },
                { status: "failed", outputBytes: 0, latencyMs: Date.now() - startedAt, errorClass: err instanceof Error ? err.name : "UnknownError" },
              ));
            } catch {
              /* swallow */
            }
            throw err;
          }
        },
      }));
    }
  }
  // ── End installable-plugin tools ────────────────────────────────────────────

  return { tools: out, nameMap };
}
