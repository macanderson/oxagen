import { tool, jsonSchema, type Tool, type ToolSet } from "@oxagen/ai";
import { type ZodTypeAny } from "zod";
import pino from "pino";
import {
  insertToolInvocation,
  type ToolInvocationRow,
} from "@oxagen/telemetry";
import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import type { CapabilityContext } from "../types";
import { invoke, authorizeExternalCapability } from "@oxagen/oxagen/kernel";
import {
  resolveAgentRunCapability,
  type AgentRunIAMResolution,
} from "@oxagen/oxagen/iam";
import { runInTenantScope } from "@oxagen/tenancy";
import { pluginForContract } from "@oxagen/oxagen/plugins";
import { capabilityMutates } from "@oxagen/oxagen/types";
import { listEntitledCapabilityPluginIds } from "@oxagen/plugins";
import { createApprovalRequest, waitForApproval } from "./approval";
import { checkConsent, recordConsent, DEFAULT_CONSENT_TTL_MS } from "./consent";
import {
  decideMcpToolEffect,
  effectiveMcpScopeForRun,
  emitMcpRuleAudit,
} from "./mcp-rbac";
import { mcpServerToolKey } from "@oxagen/oxagen/iam";
import { isSandboxAvailable } from "@oxagen/sandbox";
import { clipMiddle } from "@oxagen/agent-engine";
import {
  getPluginTypeContributors,
  type ContributedRawTool,
} from "./plugin-type";
import { getOxagenRegistry, type RegistryCapability } from "../registry-loader";
// Side-effect imports register the plugin-type contributors.
import "./plugin-types/mcp";
import "./plugin-types/file-mcp";
import "./plugin-types/placeholders";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.materialize-tools" },
});

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
    // The run this tool call belongs to (#2597). One of the seven producers
    // that wrote NULL here unconditionally; this factory is the one covering
    // every capability and external MCP call, so filling it in makes
    // `tool_invocations` joinable for those five call sites at once. NULL
    // stays the honest answer outside a run.
    execution_step_id: base.ctx.executionStepId ?? null,
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

// first-use consent for an external MCP tool. Emitted BEFORE the
// runtime blocks on waitForApproval so the stream route can render the consent
// card immediately (same pattern as ApprovalRequiredEvent).
export interface ConsentRequiredEvent {
  /** The approval row id the consent card resolves against. */
  approvalId: string;
  /** Synthetic capability id: `mcp.<serverId>.<tool>`. */
  capability: string;
  /** The external MCP server's internal id. */
  serverId: string;
  /** The external tool name. */
  toolName: string;
  /** The tool's input for this call (sample input shown on the card). */
  inputPreview: unknown;
  /** ISO string — when the consent request expires server-side. */
  expiresAt: string;
}

export interface MaterializeOptions {
  /**
   * Read-only because callers compose it — `withOntologyReads` hands back the
   * caller's own set unchanged when the run did not opt in, and a mutable
   * parameter type would make that pass-through a lie about ownership.
   */
  allowlist?: ReadonlySet<string>;
  /**
   * Capability names to withhold from the model for THIS turn. Used by the
   * chat route in code mode to drop `execute_code`/`edit_repo_file` when the
   * engine's repo-bound workspace toolset (read_file/edit_file/bash …) is
   * present — advertising two overlapping mutation paths makes the model edit
   * in the wrong sandbox. Tool-LIST filter only (UX layer); the kernel gate
   * stays the security enforcement boundary.
   */
  excludeCapabilities?: Set<string>;
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
  /**
   * called immediately after a first-use consent request is created
   * and BEFORE the runtime blocks waiting for the user's decision. Lets the
   * stream route emit a `consent-required` SSE event so the consent card
   * renders before execution pauses. Without it the stream hangs silently
   * until the consent TTL expires.
   */
  onConsentRequired?: (event: ConsentRequiredEvent) => void;
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
  // Model-safe aliases of every tool that must serialize rather than run
  // beside other calls in the same step (see isMutatingCapability). Passed
  // through to RunCodingAgentOptions.mutatingToolNames, which the Stella tool
  // mapping negates into each advertised schema's `read_only` bit.
  //
  // Includes external plugin/MCP tools, whose semantics this process cannot
  // know. They used to keep the shared concurrent lane on that same "unknown
  // semantics" reasoning, which had it the wrong way round (#2600).
  mutatingToolNames: string[];
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
  return capabilityName
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, MODEL_TOOL_NAME_MAX);
}

// The sandbox-execution capability family (verb-first snake_case, ADR-025):
// the one-shot code runner plus the durable sandbox session tools. All require
// SANDBOX_ENABLED + a configured driver, so they are gated together.
const SANDBOX_FAMILY = new Set<string>([
  "execute_code", // was agent.code.execute
  "start_sandbox", // was agent.sandbox.start
  "run_sandbox_command", // was agent.sandbox.exec
  "snapshot_sandbox", // was agent.sandbox.snapshot
  "stop_sandbox", // was agent.sandbox.stop
]);

// Sandbox SESSION + management capabilities are Workbench/human tools, not
// model tools. The engine's workspace toolset (read_file/edit_file/bash …,
// packages/agent-engine) is the ONLY sanctioned way for a model to touch a
// repository: it operates inside the conversation-bound sandbox that actually
// holds the repo clone. These capabilities instead target self-started
// sessions with NO repo in them — a model "editing files" through
// run_sandbox_command writes into an empty sandbox and burns a high-risk
// approval per call — so they are never materialized as LLM tools. Humans
// keep them through the Workbench Sandboxes UI
// (apps/app/src/lib/workbench/sandboxes.ts); api/mcp/cli surfaces are
// unaffected. The one model-facing survivor of the family is `execute_code`
// (one-shot ephemeral compute), which the code-mode route additionally
// excludes via `excludeCapabilities` when the workspace toolset is bound.
const WORKBENCH_ONLY_SANDBOX_CAPS = new Set<string>([
  "start_sandbox",
  "run_sandbox_command",
  "snapshot_sandbox",
  "stop_sandbox",
  "list_sandboxes",
  "rename_sandbox",
  "read_sandbox_file",
  "list_sandbox_files",
  "list_sandbox_logs",
]);

// Model-facing output caps for the sandbox-exec capabilities (P0 token flood).
// execute_code / run_sandbox_command return RAW stdout/stderr; a `cat bigfile`,
// verbose pytest, or `npm install` would otherwise stream megabytes straight
// into the model's context window. Mirrors the engine tools' 30k budget, with a
// tighter cap on the (usually noisier, less load-bearing) stderr stream.
const EXEC_STDOUT_MAX = 30_000; // chars
const EXEC_STDERR_MAX = 10_000; // chars

/**
 * Clip the stdout/stderr of a sandbox-exec tool result to their model-context
 * budgets, MIDDLE-OUT, BEFORE the envelope is returned to the AI SDK. No-op for
 * every non-sandbox capability and for results that carry no string
 * stdout/stderr (start/snapshot/stop return neither), so it's safe to gate on
 * the whole {@link SANDBOX_FAMILY}.
 *
 * CRITICAL — this lives at the tool-materialization seam, NOT in the handlers:
 * the same handlers are also driven programmatically by ModalSandboxWorkspace
 * (readFile base64-decodes stdout; getChangedFiles splits it into the commit
 * file list; diff returns it verbatim), which needs the EXACT, unclipped bytes.
 * Clipping in the handler would corrupt file reads and silently drop files from
 * commits. Returns a shallow copy so the original result — already measured by
 * byteSize() for the pre-clip telemetry row above — is never mutated. Pure.
 */
function clipExecOutput(capName: string, result: unknown): unknown {
  if (!SANDBOX_FAMILY.has(capName)) return result;
  if (result === null || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  const hasStdout = typeof r.stdout === "string";
  const hasStderr = typeof r.stderr === "string";
  if (!hasStdout && !hasStderr) return result;
  return {
    ...r,
    ...(hasStdout
      ? { stdout: clipMiddle(r.stdout as string, EXEC_STDOUT_MAX) }
      : {}),
    ...(hasStderr
      ? { stderr: clipMiddle(r.stderr as string, EXEC_STDERR_MAX) }
      : {}),
  };
}

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };

function passesRisk(
  cap: AnyCapability,
  ceiling?: MaterializeOptions["riskCeiling"],
): boolean {
  if (!ceiling) return true;
  const capRisk = cap.agent?.riskLevel ?? "low";
  return (RISK_ORDER[capRisk] ?? 0) <= (RISK_ORDER[ceiling] ?? 0);
}

/**
 * Concurrency class for the engine's dispatch: a capability classified
 * MUTATING serializes; everything else may run alongside other calls in the
 * same step. The Stella tool mapping negates this into each advertised
 * schema's `read_only` bit.
 *
 * Delegates to `@oxagen/oxagen`'s {@link capabilityMutates} rather than
 * deciding anything itself, so the contract type, this classifier and the
 * guard over the registry all read one definition.
 *
 * It used to answer the question from `sensitivity === "destructive"`, a high
 * `agent.riskLevel`, or `requiresApproval` — three fields that grade how
 * DANGEROUS a capability is, standing in for whether it writes. Those are
 * different questions, and 219 of 271 agent-surface capabilities were reaching
 * the engine marked concurrent-safe on the strength of it (#2600).
 */
export function isMutatingCapability(cap: AnyCapability): boolean {
  return capabilityMutates(cap);
}

// Build the Vercel AI SDK tool map for a workspace turn. Filters by
// allowlist + risk policy, never crosses tenant boundaries (the handler
// itself enforces scope from CapabilityContext).
// Default TTL must stay in sync with approval.ts DEFAULT_TTL_MS (5 min).
const APPROVAL_TTL_MS = 5 * 60 * 1000;
// HITL window the consent card is answerable in (same as the approval card).
const CONSENT_PROMPT_TTL_MS = 5 * 60 * 1000;

// Model-facing input schema for a contributed external tool. When the
// contributor supplied a pinned JSONSchema contract (descriptor pinning,
// mcp-snapshots.ts), the model is constrained by it; providers reject
// non-object tool parameter schemas, so anything else normalizes to the
// permissive object schema (semantically what z.record(unknown) was, but
// expressed as JSON Schema so all external tools flow through one path).
function toExternalToolInputSchema(
  pinned: Record<string, unknown> | undefined,
): ReturnType<typeof jsonSchema<Record<string, unknown>>> {
  const usable =
    pinned && typeof pinned === "object" && pinned.type === "object";
  return jsonSchema<Record<string, unknown>>(
    usable ? pinned : { type: "object", additionalProperties: true },
  );
}

// Parse a synthetic external-MCP capability id `mcp.<serverId>.<tool>` into its
// parts. serverId is a UUID (no dots); the tool name may itself contain dots,
// so split on the first two dots only.
function parseMcpSyntheticId(
  cap: string,
): { serverId: string; toolName: string } | null {
  if (!cap.startsWith("mcp.")) return null;
  const rest = cap.slice("mcp.".length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  return { serverId: rest.slice(0, dot), toolName: rest.slice(dot + 1) };
}

export async function materializeTools(
  ctx: CapabilityContext,
  opts: MaterializeOptions = {},
): Promise<MaterializedTools> {
  const { listCapabilities, getSurfaces } = await getOxagenRegistry();
  const all = listCapabilities();
  // agent.code.execute requires a configured sandbox driver. Gate
  // materialization on isSandboxAvailable() — the single source of truth that
  // checks SANDBOX_ENABLED=true AND that the configured driver has the required
  // credentials. The tool is only advertised to the model when it can actually
  // execute; a non-functional tool is never shown.
  const sandboxAvailable = isSandboxAvailable();
  const out: Record<string, Tool> = {};
  const nameMap: Record<string, string> = {};

  const mutatingToolNames: string[] = [];

  // Register a tool under a model-safe alias and record the reverse mapping.
  // Sanitizing collapses distinct chars to "_", so two real names could in
  // principle map to one alias; disambiguate deterministically with a numeric
  // suffix so every tool stays addressable and the reverse map is exact.
  // Returns the alias so callers can attach per-tool metadata (e.g. the
  // dispatch guard's mutating classification) keyed the way the model calls it.
  function register(realName: string, toolDef: Tool): string {
    let alias = toModelToolName(realName);
    if (nameMap[alias] !== undefined && nameMap[alias] !== realName) {
      let n = 2;
      const base = alias.slice(0, MODEL_TOOL_NAME_MAX - 3);
      while (nameMap[`${base}_${n}`] !== undefined) n += 1;
      alias = `${base}_${n}`;
    }
    out[alias] = toolDef;
    nameMap[alias] = realName;
    return alias;
  }
  // This is the tool-LIST filter only (UX layer). The kernel gate is the real
  // security enforcement boundary.
  let entitledPluginIds: Set<string> | null = null;
  let entitlementFetchFailed = false;

  // ── Agent RBAC tool filter (spec §3.5 — the second seam) ────────────────────
  // When this turn carries an agent-run IAM context, capabilities whose
  // delegation-ceiling resolution (agent ∩ invoking human, deny-wins) is DENY
  // are never materialized — the model never sees them. `pending_approval`
  // (require_approval) tools STAY visible: they route to the approval flow at
  // invoke time. This layer is UX only; the kernel invoke() gate is the real
  // enforcement (defense against prompt-injected direct capability names).
  //
  // CRITICAL — one resolution per run: this reads ctx.agentRun.resolution, the
  // SAME cached object the kernel's checkIAM reads/writes
  // (packages/iam/src/check-iam.ts resolutionForAgentRun), via the SAME pure
  // per-capability resolver (resolveAgentRunCapability, memoized on
  // resolution.byCapability). No second fetch, no second policy — whoever
  // attaches ctx.agentRun (the turn driver) populates `resolution` first.
  // If an agentRun context arrives WITHOUT its resolution, fail closed for
  // capability tools: an unattended automation must never see tools its
  // ceiling was never computed for. Scope: capability/function tools only —
  // MCP tools, skills, and subagent refs are governed at their own seams
  // (spec Phase 4), not here.
  const agentRun = ctx.agentRun;
  const agentRunResolution: AgentRunIAMResolution | null =
    agentRun?.principalKind === "agent" ? (agentRun.resolution ?? null) : null;
  const agentRunFailClosed =
    agentRun?.principalKind === "agent" && agentRunResolution === null;
  if (agentRunFailClosed) {
    logger.error(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        runId: agentRun?.runId,
      },
      "[agent-rbac] ctx.agentRun present without a populated resolution — " +
        "failing closed: no capability tools will be materialized for this " +
        "turn. The attacher must populate agentRun.resolution before " +
        "materializeTools (see turn-driver.ts).",
    );
  }
  // Run-constant resolver inputs (a run is pinned to one org+workspace; one
  // `now` per materialization mirrors checkIAM's one `now` per check).
  const agentRunScope = {
    kind: (ctx.workspaceId ? "workspace" : "org") as "org" | "workspace",
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  };
  const agentRunNow = new Date();

  for (const cap of all) {
    if (!getSurfaces(cap).includes("agent")) continue;
    if (WORKBENCH_ONLY_SANDBOX_CAPS.has(cap.name)) continue;
    if (opts.excludeCapabilities?.has(cap.name)) continue;
    if (opts.allowlist && !opts.allowlist.has(cap.name)) continue;
    if (!passesRisk(cap, opts.riskCeiling)) continue;
    // Agent RBAC (spec §3.5): resolve this capability against the run's cached
    // resolution and drop it on DENY. The memo written here
    // (resolution.byCapability) is the memo the kernel hits at invoke time —
    // the two layers provably share one decision per capability per run.
    if (agentRunFailClosed) continue;
    if (agentRunResolution !== null) {
      const perms = resolveAgentRunCapability(agentRun!, agentRunResolution, {
        capability: cap.name,
        scope: agentRunScope,
        // Same fallback as the kernel's IAM seam (kernel.ts): a capability
        // without an explicit defaultEffect defaults to "deny".
        defaultEffect: cap.defaultEffect ?? "deny",
        now: agentRunNow,
        clientIp: ctx.clientIp ?? null,
      });
      if (perms.outcome === "deny") continue;
    }
    // Gate the entire sandbox-execution family on a configured driver: both the
    // one-shot execute_code and the durable sandbox session tools require
    // SANDBOX_ENABLED + a driver. Advertising a tool the model cannot actually
    // run wastes billed steps on guaranteed failures (ADR-021 §3). (ADR-025:
    // capability names are verb-first snake_case; the former dotted
    // agent.code.execute / agent.sandbox.* set maps to these canonical names.)
    if (!sandboxAvailable && SANDBOX_FAMILY.has(cap.name)) continue;

    // Entitlement filter: if this capability is claimed by a plugin, verify the
    // org has that plugin installed and enabled. Lazily fetch the entitled set
    // on first plugin-claimed contract to avoid DB round-trips when no plugin
    // capabilities are present.
    const plugin = pluginForContract(cap.name);
    if (plugin) {
      if (!entitlementFetchFailed && entitledPluginIds === null) {
        try {
          entitledPluginIds = await listEntitledCapabilityPluginIds(
            ctx.orgId,
            ctx.workspaceId,
          );
        } catch (err) {
          logger.warn(
            { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
            "entitlement fetch failed — excluding all plugin-claimed capabilities (fail-closed)",
          );
          entitlementFetchFailed = true;
        }
      }
      // Fail-closed: if fetch threw, exclude all plugin-claimed tools.
      if (entitlementFetchFailed || !entitledPluginIds!.has(plugin.id))
        continue;
    }
    const riskLevel: "low" | "medium" | "high" = cap.agent?.riskLevel ?? "low";
    const requiresApproval = cap.agent?.requiresApproval === true;
    const alias = register(
      cap.name,
      tool({
        description: cap.description,
        inputSchema: cap.input as ZodTypeAny,
        execute: async (input: unknown) => {
          const invocationId = crypto.randomUUID();
          const startedAt = Date.now();
          const inputBytes = byteSize(input);
          try {
            // Approval gate. Only fires when the capability declares
            // `requiresApproval: true` AND we have a `messageId` to attach the
            // request to in the chat DAG. Direct API / MCP callers skip the
            // gate (their auth surface is responsible for authorization).
            if (requiresApproval && ctx.messageId) {
              const expiresAt = new Date(
                Date.now() + APPROVAL_TTL_MS,
              ).toISOString();
              // createApprovalRequest writes the approval row via withTenantDb,
              // which requires an active ALS tenant scope. This execute() closure
              // is invoked by the AI SDK mid-stream — OUTSIDE the route's
              // runInTenantScope (that scope only wrapped the materializeTools
              // call itself, not the deferred tool executions). Without re-entering
              // scope here, every requiresApproval capability (workspace.create,
              // etc.) fails fast with "No active tenant scope" before the approval
              // card can render. The handler call below (invoke) re-establishes
              // scope independently inside the kernel.
              const { approvalId } = await runInTenantScope(
                { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                () =>
                  createApprovalRequest({
                    orgId: ctx.orgId,
                    workspaceId: ctx.workspaceId,
                    messageId: ctx.messageId!,
                    capabilityName: cap.name,
                    inputPreview: input,
                    riskLevel,
                  }),
              );
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
                throw new Error(
                  `approval ${resolution.resolution} for ${cap.name}`,
                );
              }
            }
            const result = await invoke(cap.name, input, ctx, {
              surface: "agent",
            });
            // every tool invocation lands one row in ClickHouse
            // `tool_invocations` with surface + provider. Failure-isolated.
            try {
              await insertToolInvocation(
                buildInvocationPayload(
                  {
                    invocationId,
                    ctx,
                    capabilityName: cap.name,
                    riskLevel,
                    requiredApproval: requiresApproval ? 1 : 0,
                    inputBytes,
                  },
                  {
                    status: "completed",
                    outputBytes: byteSize(result),
                    latencyMs: Date.now() - startedAt,
                  },
                ),
              );
            } catch {
              /* telemetry must never fail the call */
            }
            // Cap the model-facing envelope AFTER byteSize() recorded the true
            // (pre-clip) output size above, so a sandbox-exec token flood can't
            // blow the context window. No-op for every other capability.
            return clipExecOutput(cap.name, result);
          } catch (err) {
            try {
              await insertToolInvocation(
                buildInvocationPayload(
                  {
                    invocationId,
                    ctx,
                    capabilityName: cap.name,
                    riskLevel,
                    requiredApproval: requiresApproval ? 1 : 0,
                    inputBytes,
                  },
                  {
                    status: "failed",
                    outputBytes: 0,
                    latencyMs: Date.now() - startedAt,
                    errorClass:
                      err instanceof Error ? err.name : "UnknownError",
                  },
                ),
              );
            } catch {
              /* swallow */
            }
            throw err;
          }
        },
      }),
    );
    if (isMutatingCapability(cap)) mutatingToolNames.push(alias);
  }
  // ── MCP tool integration ─────────────────────────────────────────
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
  //
  // ── Agent RBAC MCP rules — listing seam (Phase 4a, spec §3.7) ──────────────
  // When this turn carries an agent-run IAM context, the run's effective
  // resourceScope.mcp rules (agent ∩ human ceilings, first-match-wins per
  // rule set, most-restrictive across sets) are evaluated per contributed
  // tool: a DENY tool is never registered, so the model never sees it. "ask"
  // tools STAY visible — they route through the agent-subject consent flow at
  // call time (mirroring how pending_approval capability tools stay listed).
  // Computed AFTER the capability loop above so the run's byCapability memo is
  // already warm — effectiveMcpScopeForRun reads the SAME cached resolution
  // (one resolution per run, §3.5), never a second fetch. No agentRun / no
  // rules → undefined → this seam is inert (byte-identical listing).
  const agentRunMcpScope =
    agentRunResolution !== null
      ? effectiveMcpScopeForRun(
          agentRun!,
          agentRunResolution,
          agentRunScope,
          agentRunNow,
          ctx.clientIp ?? null,
        )
      : undefined;
  for (const contributor of getPluginTypeContributors()) {
    let contributed: ContributedRawTool[] = [];
    try {
      contributed = await contributor.contributeTools(ctx, {
        serverAllowlist: opts.serverAllowlist,
      });
    } catch (err) {
      logger.error(
        { pluginType: contributor.type, err },
        "plugin type contributor failed",
      );
    }
    for (const raw of contributed) {
      const capturedKey = raw.realName;
      const externalServerId = raw.externalServerId;
      const capturedExecute = raw.execute;
      // Agent-RBAC rule identity: rules address "serverName:toolName" (spec
      // §3.7). Contributors thread both; the fallbacks keep blanket rules
      // ("*") binding even for a contributor that predates the fields.
      const capturedServerName = raw.externalServerName ?? raw.externalServerId;
      const capturedToolName =
        raw.externalToolName ??
        parseMcpSyntheticId(capturedKey)?.toolName ??
        capturedKey;
      // Fail closed (mirrors the capability loop above): an agentRun without
      // its resolution must never expose external tools either.
      if (agentRunFailClosed) continue;
      // DENY tools are never registered — the model cannot see or call them.
      if (
        agentRunMcpScope !== undefined &&
        decideMcpToolEffect(
          agentRunMcpScope,
          capturedServerName,
          capturedToolName,
        ) === "deny"
      ) {
        logger.info(
          {
            capability: capturedKey,
            serverTool: mcpServerToolKey(capturedServerName, capturedToolName),
            runId: agentRun?.runId,
          },
          "[agent-rbac] MCP tool excluded from listing by resourceScope.mcp deny rule",
        );
        continue;
      }
      // Fail safe, the same rule a contract that declares nothing gets: an
      // external tool's semantics are unknown to this process, so it
      // serializes rather than joining the concurrent lane. It used to keep
      // the shared lane on exactly that "unknown semantics" reasoning, which
      // had the argument the wrong way round — unknown is the case that must
      // not run concurrently (#2600).
      const externalAlias = register(
        capturedKey,
        tool({
          description: raw.description,
          inputSchema: toExternalToolInputSchema(raw.inputSchema),
          execute: async (input: unknown) => {
            const invocationId = crypto.randomUUID();
            const startedAt = Date.now();

            // ── IAM gate (GAP-4) ────────────────────────────────────────────
            // capturedKey is the synthetic capability id, e.g.
            // `mcp.<serverId>.<toolName>`. Same IAM gate as invoke();
            // defaultEffect="allow" — the admin intentionally installed +
            // enabled this plugin, but an explicit deny/require_approval policy
            // against the synthetic id is honoured when IAM is enforced.
            // The IAM check's fetchAuthz reads tenant tables via withTenantDb,
            // which requires an active ALS tenant scope. Like the approval write
            // above, this MCP execute() closure runs mid-stream OUTSIDE the
            // route's runInTenantScope, so re-enter scope here. (In apps/app the
            // IAM checkFn is currently null and short-circuits to "allow" before
            // any DB call, but this keeps the gate correct if IAM enforcement is
            // ever enabled on the agent surface.)
            const iamResult = await runInTenantScope(
              { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
              () => authorizeExternalCapability(capturedKey, ctx, "allow"),
            );
            if (!iamResult.allowed) {
              try {
                await insertToolInvocation(
                  buildInvocationPayload(
                    {
                      invocationId,
                      ctx,
                      capabilityName: capturedKey,
                      externalServerId,
                      inputBytes: byteSize(input),
                    },
                    {
                      status: "failed",
                      outputBytes: 0,
                      latencyMs: Date.now() - startedAt,
                      errorClass: "IamDenied",
                    },
                  ),
                );
              } catch {
                /* telemetry must never fail the call */
              }
              const reason = iamResult.reason ?? iamResult.outcome;
              return `Tool blocked by workspace policy: ${reason}`;
            }
            // ── End IAM gate ────────────────────────────────────────────────

            // ── Agent RBAC MCP rule gate (Phase 4a, spec §3.7) ─────────────
            // Defense-in-depth twin of the listing filter above: even if this
            // tool was materialized before the run's rules bound (or reached
            // the model any other way), the call itself re-evaluates the
            // run's effective resourceScope.mcp rules from the SAME cached
            // resolution. deny → blocked + audited (principal_kind='agent',
            // server:tool dimension). ask → the EXISTING mcp_consents
            // first-use consent flow, with the AGENT PRINCIPAL as the consent
            // subject (subject_kind='agent'). allow → fall through to the
            // unchanged gates below. ctx.agentRun is read at CALL time — the
            // resolution slot is written by the run's first IAM check, which
            // may postdate materialization.
            let agentAskConsentHandled = false;
            const callAgentRun = ctx.agentRun;
            if (callAgentRun?.principalKind === "agent") {
              const serverTool = mcpServerToolKey(
                capturedServerName,
                capturedToolName,
              );
              const callResolution = callAgentRun.resolution ?? null;
              const meterRbacBlock = async (errorClass: string) => {
                try {
                  await insertToolInvocation(
                    buildInvocationPayload(
                      {
                        invocationId,
                        ctx,
                        capabilityName: capturedKey,
                        externalServerId,
                        inputBytes: byteSize(input),
                      },
                      {
                        status: "failed",
                        outputBytes: 0,
                        latencyMs: Date.now() - startedAt,
                        errorClass,
                      },
                    ),
                  );
                } catch {
                  /* telemetry must never fail the call */
                }
              };
              if (callResolution === null) {
                // Same fail-closed rule as the listing seams: a run context
                // without its resolution has no computed ceiling — block.
                logger.error(
                  { capability: capturedKey, runId: callAgentRun.runId },
                  "[agent-rbac] MCP tool call with agentRun but no resolution — failing closed",
                );
                await meterRbacBlock("McpRuleDenied");
                return `Tool blocked: agent run carries no IAM resolution for ${capturedKey}`;
              }
              const callScope = effectiveMcpScopeForRun(
                callAgentRun,
                callResolution,
                agentRunScope,
                new Date(),
                ctx.clientIp ?? null,
              );
              const effect = decideMcpToolEffect(
                callScope,
                capturedServerName,
                capturedToolName,
              );
              if (effect === "deny") {
                emitMcpRuleAudit({
                  ctx,
                  agentRun: callAgentRun,
                  capability: capturedKey,
                  serverTool,
                  effect: "deny",
                });
                await meterRbacBlock("McpRuleDenied");
                return `Tool blocked by agent role policy: mcp rule deny for ${serverTool}`;
              }
              if (effect === "ask") {
                const agentSubjectId = callAgentRun.agentPrincipal.id;
                const askParts = parseMcpSyntheticId(capturedKey);
                if (!askParts) {
                  // No durable consent identity (e.g. file-based server keys
                  // carry no mcp_servers uuid) — an "ask" that cannot be
                  // consented fails closed.
                  emitMcpRuleAudit({
                    ctx,
                    agentRun: callAgentRun,
                    capability: capturedKey,
                    serverTool,
                    effect: "ask",
                  });
                  await meterRbacBlock("ConsentRequired");
                  return `Tool blocked: agent consent required for ${serverTool}, but this server supports no durable consent`;
                }
                const agentDecision = await runInTenantScope(
                  { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                  () =>
                    checkConsent(
                      ctx,
                      agentSubjectId,
                      askParts.serverId,
                      askParts.toolName,
                      "agent",
                    ),
                );
                if (agentDecision?.status === "denied") {
                  await meterRbacBlock("ConsentDenied");
                  return `Tool blocked: agent consent denied for ${capturedKey}`;
                }
                if (agentDecision === null) {
                  // Ask-escalation: audit it, then solicit through the SAME
                  // HITL approval-card machinery the user consent flow uses.
                  emitMcpRuleAudit({
                    ctx,
                    agentRun: callAgentRun,
                    capability: capturedKey,
                    serverTool,
                    effect: "ask",
                  });
                  if (!ctx.messageId) {
                    // Unattended surface (durable runner turn): nothing can
                    // render a consent card — fail closed, no row written, so
                    // an interactive surface can grant it later.
                    await meterRbacBlock("ConsentRequired");
                    return `Tool blocked: agent consent required for ${serverTool} (no interactive surface to ask)`;
                  }
                  const askExpiresAt = new Date(
                    Date.now() + CONSENT_PROMPT_TTL_MS,
                  ).toISOString();
                  const { approvalId } = await runInTenantScope(
                    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                    () =>
                      createApprovalRequest({
                        orgId: ctx.orgId,
                        workspaceId: ctx.workspaceId,
                        messageId: ctx.messageId!,
                        capabilityName: capturedKey,
                        inputPreview: input,
                        riskLevel: "medium",
                        ttlMs: CONSENT_PROMPT_TTL_MS,
                      }),
                  );
                  opts.onConsentRequired?.({
                    approvalId,
                    capability: capturedKey,
                    serverId: askParts.serverId,
                    toolName: askParts.toolName,
                    inputPreview: input,
                    expiresAt: askExpiresAt,
                  });
                  const askResolution = await waitForApproval(
                    approvalId,
                    CONSENT_PROMPT_TTL_MS,
                  );
                  const askGranted = askResolution.resolution === "approved";
                  await runInTenantScope(
                    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                    () =>
                      recordConsent({
                        orgId: ctx.orgId,
                        workspaceId: ctx.workspaceId,
                        // AGENT principal as the consent subject, labeled
                        // distinctly via subject_kind (spec §3.7).
                        userId: agentSubjectId,
                        subjectKind: "agent",
                        serverId: askParts.serverId,
                        toolName: askParts.toolName,
                        status: askGranted ? "granted" : "denied",
                        ttlMs: DEFAULT_CONSENT_TTL_MS,
                      }),
                  ).catch(() => {
                    /* a failed grant write must not crash the turn — re-prompt next time */
                  });
                  if (!askGranted) {
                    await meterRbacBlock("ConsentDenied");
                    return `Tool blocked: agent consent ${askResolution.resolution} for ${capturedKey}`;
                  }
                }
                // An active or freshly-granted agent consent covers this
                // call — the user-scoped first-use gate below is skipped so
                // one human answer isn't solicited twice for the same call.
                agentAskConsentHandled = true;
              }
            }
            // ── End agent RBAC MCP rule gate ───────────────────────────────

            // ── First-use consent gate ────────────────────────────
            // The FIRST time this (workspace, user, server, tool) is invoked we
            // pause and render a consent card; the decision is durable so the
            // second call runs inline. Only fires on the chat surface (messageId
            // + userId present) — direct API/MCP callers are governed by their
            // own auth surface. A workspace pre-grant (tool_name='*') and any
            // unexpired prior grant short-circuit without prompting. Skipped
            // when the agent-RBAC "ask" flow above already secured an
            // agent-subject consent for this exact call (never for plain
            // user turns — agentAskConsentHandled stays false without an
            // agentRun, keeping this gate byte-identical).
            const mcpParts = parseMcpSyntheticId(capturedKey);
            if (
              mcpParts &&
              ctx.messageId &&
              ctx.userId &&
              !agentAskConsentHandled
            ) {
              const consentUserId = ctx.userId;
              const decision = await runInTenantScope(
                { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                () =>
                  checkConsent(
                    ctx,
                    consentUserId,
                    mcpParts.serverId,
                    mcpParts.toolName,
                  ),
              );
              if (decision?.status === "denied") {
                try {
                  await insertToolInvocation(
                    buildInvocationPayload(
                      {
                        invocationId,
                        ctx,
                        capabilityName: capturedKey,
                        externalServerId,
                        inputBytes: byteSize(input),
                      },
                      {
                        status: "failed",
                        outputBytes: 0,
                        latencyMs: Date.now() - startedAt,
                        errorClass: "ConsentDenied",
                      },
                    ),
                  );
                } catch {
                  /* telemetry must never fail the call */
                }
                return `Tool blocked: consent denied for ${capturedKey}`;
              }
              if (decision === null) {
                // No active grant — solicit consent via the HITL approval row,
                // emit the consent-required event, then block until resolved.
                const expiresAt = new Date(
                  Date.now() + CONSENT_PROMPT_TTL_MS,
                ).toISOString();
                const { approvalId } = await runInTenantScope(
                  { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                  () =>
                    createApprovalRequest({
                      orgId: ctx.orgId,
                      workspaceId: ctx.workspaceId,
                      messageId: ctx.messageId!,
                      capabilityName: capturedKey,
                      inputPreview: input,
                      riskLevel: "medium",
                      ttlMs: CONSENT_PROMPT_TTL_MS,
                    }),
                );
                opts.onConsentRequired?.({
                  approvalId,
                  capability: capturedKey,
                  serverId: mcpParts.serverId,
                  toolName: mcpParts.toolName,
                  inputPreview: input,
                  expiresAt,
                });
                const resolution = await waitForApproval(
                  approvalId,
                  CONSENT_PROMPT_TTL_MS,
                );
                const granted = resolution.resolution === "approved";
                // Persist the durable grant/denial so the next call is inline.
                await runInTenantScope(
                  { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                  () =>
                    recordConsent({
                      orgId: ctx.orgId,
                      workspaceId: ctx.workspaceId,
                      userId: consentUserId,
                      serverId: mcpParts.serverId,
                      toolName: mcpParts.toolName,
                      status: granted ? "granted" : "denied",
                      ttlMs: DEFAULT_CONSENT_TTL_MS,
                    }),
                ).catch(() => {
                  /* a failed grant write must not crash the turn — re-prompt next time */
                });
                if (!granted) {
                  try {
                    await insertToolInvocation(
                      buildInvocationPayload(
                        {
                          invocationId,
                          ctx,
                          capabilityName: capturedKey,
                          externalServerId,
                          inputBytes: byteSize(input),
                        },
                        {
                          status: "failed",
                          outputBytes: 0,
                          latencyMs: Date.now() - startedAt,
                          errorClass: "ConsentDenied",
                        },
                      ),
                    );
                  } catch {
                    /* telemetry must never fail the call */
                  }
                  return `Tool blocked: consent ${resolution.resolution} for ${capturedKey}`;
                }
              }
            }
            // ── End consent gate ────────────────────────────────────────────

            // ── OTEL span: covers external MCP tool call duration ──────────
            // Started inside any active kernel/stream span so the parent
            // context propagates automatically. Attributes are PII-safe:
            // tool name only, no input/output content.
            const _otelToolSpan = trace
              .getTracer("oxagen.agent.tools")
              .startSpan("tool.external", {
                kind: SpanKind.CLIENT,
                attributes: {
                  "tool.name": capturedKey,
                  "tool.risk_level": "low",
                },
              });
            try {
              const result = await capturedExecute(input, {
                toolCallId: invocationId,
                messages: [],
              });
              _otelToolSpan.setAttributes({
                "tool.status": "completed",
                "tool.latency_ms": Date.now() - startedAt,
                "tool.input_size_bytes": byteSize(input),
                "tool.output_size_bytes": byteSize(result),
              });
              _otelToolSpan.setStatus({ code: SpanStatusCode.OK });
              _otelToolSpan.end();
              try {
                await insertToolInvocation(
                  buildInvocationPayload(
                    {
                      invocationId,
                      ctx,
                      capabilityName: capturedKey,
                      externalServerId,
                      inputBytes: byteSize(input),
                    },
                    {
                      status: "completed",
                      outputBytes: byteSize(result),
                      latencyMs: Date.now() - startedAt,
                    },
                  ),
                );
              } catch {
                /* telemetry must never fail the call */
              }
              return result;
            } catch (err) {
              _otelToolSpan.setAttributes({ "tool.status": "failed" });
              _otelToolSpan.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err),
              });
              _otelToolSpan.end();
              try {
                await insertToolInvocation(
                  buildInvocationPayload(
                    {
                      invocationId,
                      ctx,
                      capabilityName: capturedKey,
                      externalServerId,
                      inputBytes: byteSize(input),
                    },
                    {
                      status: "failed",
                      outputBytes: 0,
                      latencyMs: Date.now() - startedAt,
                      errorClass:
                        err instanceof Error ? err.name : "UnknownError",
                    },
                  ),
                );
              } catch {
                /* swallow */
              }
              throw err;
            }
          },
        }),
      );
      mutatingToolNames.push(externalAlias);
    }
  }
  // ── End installable-plugin tools ────────────────────────────────────────────

  return { tools: out, nameMap, mutatingToolNames };
}
