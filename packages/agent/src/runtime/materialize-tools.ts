import { ApprovalPendingError } from "./approval-pending";
import { ApprovalResumeError } from "./approval-resume-payload";
import { tool, jsonSchema, type Tool, type ToolSet } from "@oxagen/ai";
import { type ZodTypeAny } from "zod";
import pino from "pino";
import {
  insertToolInvocation,
  type ToolInvocationRow,
} from "@oxagen/telemetry";
import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";
import type { CapabilityContext } from "../types";
import {
  invoke,
  authorizeExternalCapability,
  emitExternalCapabilityOutcome,
  type ExternalExecutionFailureCode,
  type ExternalRefusalCode,
  type KernelSecurityOutcome,
} from "@oxagen/oxagen/kernel";
import {
  type AgentRunIAMResolution,
  type EffectiveMcpScope,
} from "@oxagen/oxagen/iam";
import {
  assertGauAvailable,
  attributableWorkspaceId,
  governedActionEntry,
  ledgerKey,
  recordGovernedActions,
} from "@oxagen/billing";
import { withTenantDb } from "@oxagen/database";
import { readActiveEmergencyDenies } from "@oxagen/iam";
import { runInTenantScope } from "@oxagen/tenancy";
import { pluginForContract } from "@oxagen/oxagen/plugins";
import { capabilityMutates } from "@oxagen/oxagen/types";
import { listEntitledCapabilityPluginIds } from "@oxagen/plugins";
import { externalDecisionCheck } from "./external-tool-rules";
import { createApprovalRequest, waitForApproval } from "./approval";
import { checkConsent, recordConsent, DEFAULT_CONSENT_TTL_MS } from "./consent";
import {
  decideMcpToolEffect,
  effectiveMcpScopeForRun,
  emitMcpRuleAudit,
} from "./mcp-rbac";
import { mcpServerToolKey } from "@oxagen/oxagen/iam";
import { isAdmissibleToolIdentity } from "@oxagen/run-ledger";
import {
  getPluginTypeContributors,
  type ContributedRawTool,
} from "./plugin-type";
import { getOxagenRegistry, type RegistryCapability } from "../registry-loader";
import {
  createKillSwitchGate,
  KillSwitchDeniedError,
  type ActingAgent,
  type KillSwitchGate,
} from "./kill-switch-gate";
import { decideCapabilityForBelt, decideMcpToolForBelt } from "./toolbelt";
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

/**
 * How a call that threw ends in `tool_invocations`. A call parked for a
 * person's approval is `parked` with no error class: it did not fail, and it
 * used to land as `failed` / `ApprovalPendingError`, which counted every
 * parked write as a tool failure. Anything else is `failed` with its class.
 */
function thrownOutcome(
  err: unknown,
  fallbackClass: string,
): Pick<ToolInvocationRow, "status" | "error_class"> {
  if (err instanceof ApprovalPendingError)
    return { status: "parked", error_class: null };
  return {
    status: "failed",
    error_class: err instanceof Error ? err.name : fallbackClass,
  };
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
  /** The row uuid, which waiters and NOTIFY are keyed by. */
  approvalId: string;
  /**
   * The public id (`apr_…`) that list reads, Fleet and the assistant's parked
   * card show. Absent where the writer did not return one.
   */
  approvalPublicId?: string;
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
   * Capability names to withhold from the model for THIS turn. A surface uses
   * it to narrow the advertised set below the run's allowlist without changing
   * the run's governance. Tool-LIST filter only (UX layer); the kernel gate
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
  /**
   * What a tool does after it has created its approval request. `wait`
   * blocks inside `execute` until the person decides or the TTL passes,
   * which is what the chat surfaces have always done. `park` refuses the
   * call at once with `ApprovalPendingError`, naming the request: the in-app
   * agent on `stella-serve` runs this way (MC spec §4.4; the engine has no
   * approval gate of its own), so the turn completes with the write parked
   * as a card and the person's decision starts the next turn.
   */
  approvalMode?: "wait" | "park";
  /** Seam for tests; defaults to the Postgres-backed gate. */
  killSwitchGate?: KillSwitchGate;
  /**
   * The managed agent a person's turn runs as: the in-app assistant passes
   * its `qa-chat` agent. A kill switch on that agent, or a deny naming its
   * principal, then leaves the tool off the belt and refuses the call. Tools
   * still run as the person. Every other caller omits it, so a switch on the
   * assistant never reaches a person's own calls.
   */
  actingAgent?: ActingAgent;
  /**
   * A mutable box the caller fills in AFTER materialization, once the run
   * this turn opened is known. `runPreparedTurn` calls `materializeTools`
   * before `openAssistantRun` (the belt has to exist to build the run's
   * `toolAllowlist`), and its context never carries `ctx.agentRun` at all:
   * the assistant acts as the person who asked, before the run opens and
   * after it. A value read from `ctx.agentRun` here would be permanently
   * null. Every tool's `execute` reads `runIdRef.current` at CALL time
   * instead — by then the caller has set it to the opened run's public id —
   * so a parked approval attaches to the run whose Policy tab a person is
   * actually looking at (finding 9, macanderson/oxagen#3370). A caller with
   * no such run (a direct API/MCP call, or an automation whose run was
   * already open when it materialized tools) omits this, and the read falls
   * back to `ctx.agentRun.runId` as before.
   */
  runIdRef?: { current: string | null };
}

// Re-exported from its own module, which the engine port reads without
// pulling this one in (see approval-pending.ts).
export { ApprovalPendingError } from "./approval-pending";

// Result of materializeTools: the Vercel AI SDK tool map keyed by *model-safe*
// names, plus a reverse map from each model-safe name back to the real
// capability name. See toModelToolName for why the keys must be sanitized.
export interface MaterializedTools {
  tools: ToolSet;
  // model-safe tool name → real capability name (e.g.
  // "mcp_1f2e_search" → "mcp.1f2e….search"). The route translates
  // tool-call stream events back to the real name for the UI.
  nameMap: Record<string, string>;
  // Model-safe aliases of every tool that must serialize rather than run
  // beside other calls in the same step (see isMutatingCapability). A turn
  // loop reads this to decide which advertised tools may be dispatched
  // concurrently and which must run one at a time.
  //
  // Includes external plugin/MCP tools, whose semantics this process cannot
  // know. They used to keep the shared concurrent lane on that same "unknown
  // semantics" reasoning, which had it the wrong way round (#2600).
  mutatingToolNames: string[];
  /**
   * Per-alias governance facts an external engine needs to declare each tool
   * honestly (ADR-053 §1): the capability's risk level, whether it pauses for
   * approval, and whether it only reads. The `execute` closures above carry
   * the gates themselves; this is the declaration the engine's own policy
   * reads before it dispatches a call, so a tool sent without it would be
   * treated as untrusted and high risk.
   */
  governance: Record<string, ToolGovernance>;
}

export interface ToolGovernance {
  riskLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
  /** True when the capability does not mutate and may run beside other calls. */
  readOnly: boolean;
}

// Provider tool-name constraint enforced by the Vercel AI Gateway (and the
// OpenAI / Anthropic / Bedrock backends it routes to): a function/tool name
// must match ^[a-zA-Z0-9_-]{1,128}$. Some Oxagen capability names are dotted
// (e.g. "agent.memory.recall"), and MCP synthetic keys embed dots too
// ("mcp.<serverId>.<tool>"), so passing them verbatim makes the
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

/**
 * Concurrency class for the turn loop's dispatch: a capability classified
 * MUTATING serializes; everything else may run alongside other calls in the
 * same step.
 *
 * Delegates to `@oxagen/oxagen`'s {@link capabilityMutates} rather than
 * deciding anything itself, so the contract type, this classifier and the
 * guard over the registry all read one definition.
 *
 * It used to answer the question from `sensitivity === "destructive"`, a high
 * `agent.riskLevel`, or `requiresApproval` — three fields that grade how
 * DANGEROUS a capability is, standing in for whether it writes. Those are
 * different questions, and 219 of 271 agent-surface capabilities were reaching
 * dispatch marked concurrent-safe on the strength of it (#2600).
 */
/**
 * The value the decision path will digest for this call.
 *
 * invoke() validates with `cap.input.safeParse` and hands `inputResult.data`
 * to the rules gate, which digests THAT and looks the standing approval
 * window up by it. An approval row digested from the raw tool arguments
 * therefore keys on a different value for any schema that supplies a
 * default, coerces a type, or transforms a field — and the window silently
 * never matches.
 *
 * A parse failure returns the raw value: invoke() refuses that input, so
 * nothing ever looks up a window for the digest it produces.
 */
export function digestInputFor(cap: AnyCapability, input: unknown): unknown {
  const parsed = (cap.input as ZodTypeAny).safeParse(input);
  return parsed.success ? parsed.data : input;
}

export function isMutatingCapability(cap: AnyCapability): boolean {
  return capabilityMutates(cap);
}

// Build the Vercel AI SDK tool map for a workspace turn. Filters by
// allowlist + risk policy, never crosses tenant boundaries (the handler
// itself enforces scope from CapabilityContext).
// Default TTL must stay in sync with approval.ts DEFAULT_TTL_MS (5 min).
const APPROVAL_TTL_MS = 5 * 60 * 1000;
/** The entitled set for a contract no plugin claims: the gate never consults it. */
const NO_PLUGINS: ReadonlySet<string> = new Set();
/**
 * A refusal an external tool gate returned to the model as text. Not thrown:
 * the model reads the message and carries on. It exists so the boundary's one
 * audit row (`emitExternalCapabilityOutcome`) records which gate said no,
 * instead of every text refusal collapsing to `authz_denied`.
 */
class ExternalToolRefusal {
  constructor(
    readonly code: ExternalRefusalCode | "authz_denied",
    readonly message: string,
  ) {}
}

/**
 * The audit cause for a call that passed every gate and then failed in the
 * remote tool or on the way to it. An MCP `isError` result arrives as an
 * error carrying `mcp_tool_execution_failed` (`McpToolExecutionError`);
 * anything else thrown there is a transport failure. Only the code is kept,
 * so the remote payload and any credential in an error message never reach
 * the audit row.
 */
function externalExecutionFailure(err: unknown): {
  code: ExternalExecutionFailureCode;
} {
  const code =
    err && typeof err === "object" && "code" in err ? err.code : undefined;
  return {
    code:
      code === "mcp_tool_execution_failed"
        ? "mcp_tool_execution_failed"
        : "mcp_transport_failed",
  };
}

/**
 * The code an IAM refusal is audited under. `authorizeExternalCapability`
 * makes two denials of its own with no policy verdict behind them, and each
 * keeps its code; everything else is the policy's deny.
 */
function iamRefusalCode(
  reason: string | null,
): ExternalRefusalCode | "authz_denied" {
  if (reason === "iam_check_error") return "authz_check_error";
  if (reason === "decision_not_persisted")
    return "authz_decision_not_persisted";
  return "authz_denied";
}

/**
 * The part of a tool's per-call options these closures read. The engine
 * (`executeToolRequest`, engine/tools.ts) and the AI SDK both pass the
 * model's tool-call id here. Named apart from the SDK's own options type,
 * which carries more than this file uses.
 */
interface ExecuteCallOptions {
  toolCallId?: string;
}

/** The model's tool-call id for this call, or null when the caller sent none. */
function modelToolCallId(
  options: ExecuteCallOptions | undefined,
): string | null {
  const id = options?.toolCallId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Record one governed action unit for an external MCP tool call that
 * completed (ADR-165, source `external_tool`).
 *
 * The call is keyed by the model's tool-call id within the run (or the turn,
 * when there is no run), because a provider's id is unique within a
 * conversation and promised nothing beyond it. A retried call therefore
 * bills once. With no tool-call id, or nothing to scope one to, the key is
 * this invocation's own random id: nothing is deduplicated, which is the safe
 * direction, since a shared key would silently drop a second, distinct call.
 *
 * Never throws. The call already happened and its result is on its way to
 * the model, so a failure here costs a charge, not the call. That is the
 * kernel's rule for its own recorder, and like the kernel this logs loudly,
 * because a silent miss is a revenue leak.
 *
 * Runs in the tenant scope it opens: the recorder writes through
 * `withTenantDb`, and this closure executes mid-stream, outside the scope the
 * route opened around `materializeTools`.
 */
async function recordExternalToolCall(
  ctx: CapabilityContext,
  call: {
    invocationId: string;
    toolCallId: string | null;
    toolName: string;
    mcpServer: string | null;
    runId: string | null;
    principalId: string | null;
    principalKind: string | null;
  },
): Promise<void> {
  const scope = call.runId ?? ctx.executionStepId ?? ctx.messageId ?? null;
  const idempotencyKey =
    call.toolCallId !== null && scope !== null
      ? ledgerKey("external_tool", scope, call.toolCallId)
      : ledgerKey("external_tool", scope ?? "-", `inv:${call.invocationId}`);
  const entry = governedActionEntry({
    idempotencyKey,
    source: "external_tool",
    units: 1,
    occurredAt: new Date(),
    toolName: call.toolName,
    mcpServer: call.mcpServer,
    surface: "agent",
    workspaceId: attributableWorkspaceId(ctx.workspaceId),
    agentId:
      ctx.agentRun?.agentId ?? ctx.deployedAgentInvocation?.agentId ?? null,
    principalId: call.principalId,
    principalKind: call.principalKind,
    operatorUserId:
      ctx.agentRun?.humanPrincipal?.id ??
      ctx.deployedAgentInvocation?.initiatingPrincipal.id ??
      ctx.userId ??
      null,
    runId: call.runId,
    toolCallId: call.toolCallId,
    requestId: ctx.requestId ?? null,
  });
  try {
    await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () =>
        recordGovernedActions({
          orgId: ctx.orgId,
          entries: [entry],
          label: call.toolName,
        }),
    );
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        capability: call.toolName,
        idempotencyKey,
        alert: "external_tool_billing_failed",
      },
      "external tool call completed and its governed action was not recorded",
    );
  }
}

// HITL window the consent card is answerable in (same as the approval card).
const CONSENT_PROMPT_TTL_MS = 5 * 60 * 1000;

/**
 * The one risk level an external MCP tool carries: in the governance map the
 * engine reads, and on the consent card a person answers.
 *
 * High, because Oxagen holds no contract for the tool. Nothing states what it
 * reads or writes, so it gets the grade the engine gives any tool it has no
 * declaration for (`toToolContracts` in ./engine/tools.ts), and the grade a
 * decision rule's approval for the same tool records (./external-tool-rules.ts,
 * ./external-approval.ts). The consent card used to record medium while the
 * engine was told high, so the person deciding saw a lower grade than the
 * engine enforced. Lowering the engine to medium instead would relax its
 * policy for a tool no one has vouched for.
 */
const EXTERNAL_TOOL_RISK_LEVEL: ToolGovernance["riskLevel"] = "high";

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
  const out: Record<string, Tool> = {};
  const nameMap: Record<string, string> = {};

  const mutatingToolNames: string[] = [];
  const governance: Record<string, ToolGovernance> = {};

  // Kill switches (spec §6.11): one gate per materialization, consulted in
  // every execute closure below. A non-read-only call re-reads the deny
  // generation before it runs and reloads the switches when it moved, so a
  // flip takes effect at the next call boundary for every tool on the belt.
  const killSwitches: KillSwitchGate =
    opts.killSwitchGate ??
    createKillSwitchGate(ctx, undefined, opts.actingAgent ?? null);

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
  // MCP tools are governed at their own seam (the resourceScope.mcp rules
  // below), not here.
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
        "turn. The caller must populate agentRun.resolution before " +
        "calling materializeTools.",
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

  // The active emergency denies, read once per materialization for every
  // caller: a kill switch cuts the tool from the belt the model receives, the
  // same rows `get_agent_toolbelt` reports under `kill_switch`. The kernel
  // enforces them again at invoke for an agent run, and the kill-switch gate
  // in each tool's `execute` checks every caller's call. A person's turn
  // reads them too (R4, #3370 finding 9). The in-app assistant lists its
  // tools as the person and never carries an agent run, so a read gated on
  // one left a switched tool on its belt. Only a fail-closed run skips the
  // read, because it lists no capability tools at all. This runs inside the
  // caller's tenant scope (every caller wraps materializeTools in
  // runInTenantScope).
  const emergencyDenies = agentRunFailClosed
    ? []
    : await withTenantDb((tx) =>
        readActiveEmergencyDenies(tx, {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId || null,
        }),
      );

  // Entitlement filter: if a capability is claimed by a plugin, the org must
  // have that plugin installed and enabled. Lazily fetch the entitled set on
  // the first plugin-claimed contract to avoid DB round-trips when no plugin
  // capabilities are present; a failed fetch excludes every plugin-claimed
  // tool (fail-closed).
  const entitledPluginIdsFor = async (
    cap: AnyCapability,
  ): Promise<ReadonlySet<string> | "unavailable"> => {
    if (!pluginForContract(cap.name)) return NO_PLUGINS;
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
    return entitlementFetchFailed || entitledPluginIds === null
      ? "unavailable"
      : entitledPluginIds;
  };

  for (const cap of all) {
    // One decision per tool, shared with `get_agent_toolbelt` (toolbelt.ts):
    // surface, exclusion, allowlist, risk ceiling, the run's cached
    // delegation-ceiling resolution (spec §3.5 — the memo written on
    // resolution.byCapability is the memo the kernel hits at invoke time),
    // the active emergency denies, then entitlement.
    const decision = decideCapabilityForBelt(cap, {
      surfaces: getSurfaces(cap),
      excluded: opts.excludeCapabilities,
      allowlist: opts.allowlist,
      riskCeiling: opts.riskCeiling,
      agentRun: agentRun?.principalKind === "agent" ? agentRun : null,
      resolution: agentRunResolution,
      scope: agentRunScope,
      now: agentRunNow,
      clientIp: ctx.clientIp ?? null,
      emergencyDenies,
      actingAgent: opts.actingAgent ?? null,
      entitledPluginIds: await entitledPluginIdsFor(cap),
    });
    if (decision.outcome === "deny") continue;
    const riskLevel = decision.riskLevel;
    // The approval gate in `execute` below is the contract's own flag; a
    // resolver `pending_approval` is the kernel's to hold at invoke time.
    const requiresApproval = cap.agent?.requiresApproval === true;
    const alias = register(
      cap.name,
      tool({
        description: cap.description,
        inputSchema: cap.input as ZodTypeAny,
        execute: async (input: unknown, options?: ExecuteCallOptions) => {
          const invocationId = crypto.randomUUID();
          const startedAt = Date.now();
          const inputBytes = byteSize(input);
          try {
            // Kill switch (spec §6.11): a switch on this version, the agent,
            // the operator, the workspace, the organisation or a class this
            // version carries stops the call at this boundary. Checked before
            // an approval card opens and again once it is approved, so a
            // switch flipped during the wait stops the call (§7.4).
            //
            // `readOnly` decides whether the gate re-reads the deny generation
            // first. A read-only capability is checked against the turn's
            // snapshot, which is what §7.4's guarantee column grants
            // ("guaranteed for non-read-only tools"): a switch flipped
            // mid-turn stops every mutation immediately and stops reads from
            // the next turn. That is the intent, not an oversight.
            const refuseIfKilled = async () => {
              const killed = await killSwitches.check({
                capabilityId: cap.name,
                readOnly: !isMutatingCapability(cap),
              });
              if (killed !== null) throw new KillSwitchDeniedError(killed);
            };
            await refuseIfKilled();
            // Approval gate. Only fires when the capability declares
            // `requiresApproval: true` AND we have a `messageId` to attach the
            // request to in the chat DAG. Direct API / MCP callers skip the
            // gate (their auth surface is responsible for authorization).
            if (requiresApproval && ctx.messageId) {
              let expiresAt = new Date(
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
              if (
                opts.approvalMode === "park" &&
                (!ctx.userId || ctx.apiKeyId || ctx.agentRun)
              ) {
                throw new ApprovalResumeError("unsupported_requester_context");
              }
              if (
                opts.approvalMode === "park" &&
                !(cap.input as ZodTypeAny).safeParse(input).success
              ) {
                throw new ApprovalResumeError("input_invalid");
              }
              const approval = await runInTenantScope(
                { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                () =>
                  createApprovalRequest({
                    orgId: ctx.orgId,
                    workspaceId: ctx.workspaceId,
                    messageId: ctx.messageId!,
                    // The run the call was parked in (#3286), so the Run
                    // page's Policy tab can list its own approvals. Read at
                    // call time, not from the `agentRun` captured when these
                    // closures were built: for the in-app assistant that
                    // happens before `openAssistantRun` opens the run, so
                    // `ctx.agentRun` is still unset then (finding 9,
                    // macanderson/oxagen#3370).
                    runId: opts.runIdRef?.current ?? agentRun?.runId ?? null,
                    capabilityName: cap.name,
                    inputPreview: input,
                    // Digest the VALIDATED input, because that is what the
                    // decision path digests. invoke() runs cap.input.safeParse
                    // and hands inputResult.data to the rules gate
                    // (packages/oxagen/src/kernel.ts), which digests it and
                    // looks the standing window up by that value. Handing the
                    // raw AI SDK arguments here was a mismatch for every
                    // capability whose schema supplies a default, coerces, or
                    // transforms: the approval row stored one digest, the
                    // ensuing invocation looked up another, standingWindowMs
                    // matched nothing, and a second person was asked to approve
                    // a call that had just been approved. Passing the same
                    // object to both is not the same as passing the same value,
                    // because the kernel parses in between.
                    //
                    // A parse failure falls back to the raw value: invoke()
                    // below refuses that input anyway, so no window is ever
                    // read for this digest.
                    digestInput: digestInputFor(cap, input),
                    riskLevel,
                    ...(opts.approvalMode === "park"
                      ? { resumeRequesterUserId: ctx.userId! }
                      : {}),
                  }),
              );
              const { approvalId } = approval;
              expiresAt = approval.expiresAt?.toISOString() ?? expiresAt;
              if (opts.approvalMode === "park" && approval.resolution) {
                return {
                  approvalId,
                  resolution: approval.resolution,
                  execution: approval.resumeStatus,
                };
              }
              // Emit approval-required event BEFORE blocking so the stream route
              // can forward it to the client immediately. Without this, the SSE
              // channel goes silent during the waitForApproval block and the
              // approval card never renders — the stream appears hung.
              opts.onApprovalRequired?.({
                approvalId,
                ...(approval.publicId === undefined
                  ? {}
                  : { approvalPublicId: approval.publicId }),
                capability: cap.name,
                inputPreview: input,
                riskLevel,
                expiresAt,
              });
              if (opts.approvalMode === "park") {
                throw new ApprovalPendingError(
                  cap.name,
                  approvalId,
                  expiresAt,
                  approval.publicId,
                );
              }
              const resolution = await waitForApproval(approvalId);
              if (resolution.resolution !== "approved") {
                throw new Error(
                  `approval ${resolution.resolution} for ${cap.name}`,
                );
              }
              await refuseIfKilled();
            }
            // The model's tool-call id rides on the context so the kernel keys
            // this call's ledger row by it (ADR-165): a retried tool call bills
            // once. Without an id the context goes through unchanged.
            const toolCallId = modelToolCallId(options);
            const result = await invoke(
              cap.name,
              input,
              toolCallId === null ? ctx : { ...ctx, toolCallId },
              {
                surface: "agent",
                // Read fresh at call time, same reasoning as the manual-approval
                // runId above: the in-app assistant opens its run only after
                // materializing tools, so ctx.agentRun is unset when these
                // closures are built (finding 9, #3370). Without this, an
                // auto-approved call's receipt (#3153) attaches to no run.
                runId: opts.runIdRef?.current ?? agentRun?.runId ?? null,
              },
            );
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
            return result;
          } catch (err) {
            // The approval gate above throws its park inside this try, so a
            // parked call ends here too, and is recorded as parked.
            const ended = thrownOutcome(err, "UnknownError");
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
                    status: ended.status,
                    outputBytes: 0,
                    latencyMs: Date.now() - startedAt,
                    errorClass: ended.error_class,
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
    governance[alias] = {
      riskLevel,
      requiresApproval,
      readOnly: !isMutatingCapability(cap),
    };
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
  //   3. BILLED as one governed action unit when it completes (ADR-165):
  //      admitted by `assertGauAvailable` after IAM, recorded on the ledger
  //      by `recordExternalToolCall` after the server answers. A refused or
  //      failed call bills nothing.
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
  const listingConsentFor = async (
    mcpScope: EffectiveMcpScope,
    syntheticId: string,
    serverName: string,
    toolName: string,
  ): Promise<{ status: "granted" | "denied" } | null> => {
    if (decideMcpToolEffect(mcpScope, serverName, toolName) !== "ask")
      return null;
    const parts = parseMcpSyntheticId(syntheticId);
    if (!parts || agentRun?.principalKind !== "agent") return null;
    const recorded = await checkConsent(
      ctx,
      agentRun.agentPrincipal.id,
      parts.serverId,
      parts.toolName,
      "agent",
    );
    return recorded === null
      ? null
      : { status: recorded.status === "granted" ? "granted" : "denied" };
  };
  for (const contributor of getPluginTypeContributors()) {
    let contributed: ContributedRawTool[] = [];
    try {
      contributed = await contributor.contributeTools(ctx, {
        serverAllowlist: opts.serverAllowlist,
        killSwitches,
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
      // An identity a run spec cannot carry is dropped here rather than
      // taken into the turn. `openAssistantRun` pins EVERY materialized tool
      // into `tool_policy.allowlist`, so a single inadmissible identity does
      // not fail that tool — it fails spec admission, and with it every
      // assistant turn in the workspace, including the ones that would never
      // have called it. The contributors' names are third parties' (an MCP
      // server's `tools/list`, a `.oxagen/settings.json` server name), and a
      // registry may still hold rows from before the import guard bounded
      // them, so this is the point where the turn stops trusting the length.
      //
      // Dropped, not truncated: a truncated identity is a DIFFERENT tool as
      // far as governance is concerned, and two long names could truncate to
      // one. Losing a tool from the belt is recoverable and loud; two tools
      // sharing a governed identity is not.
      if (!isAdmissibleToolIdentity(capturedKey)) {
        logger.error(
          {
            capability: capturedKey,
            length: capturedKey.length,
            pluginType: contributor.type,
            serverTool: mcpServerToolKey(capturedServerName, capturedToolName),
          },
          "external tool left out of the turn: its governed identity is not one a run spec can carry",
        );
        continue;
      }
      // DENY tools are never registered — the model cannot see or call them.
      // The same decision `get_agent_toolbelt` prints (toolbelt.ts): a deny
      // rule, or an ask rule the agent principal's standing consent has
      // denied. The consent read happens only for an ask rule, the one case
      // where it changes the decision; the call below reads it again.
      if (
        agentRunMcpScope !== undefined &&
        decideMcpToolForBelt(capturedServerName, capturedToolName, {
          mcpScope: agentRunMcpScope,
          consent: await listingConsentFor(
            agentRunMcpScope,
            capturedKey,
            capturedServerName,
            capturedToolName,
          ),
          decide: (server, tool) =>
            decideMcpToolEffect(agentRunMcpScope, server, tool),
        }).outcome === "deny"
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
          execute: async (input: unknown, options?: ExecuteCallOptions) => {
            const invocationId = crypto.randomUUID();
            const startedAt = Date.now();

            let outcome: KernelSecurityOutcome = "deny";
            let auditError: unknown;
            // Set only when the remote call itself failed, after every gate
            // allowed it, so the audit row names an execution failure rather
            // than a refusal.
            let executionFailure:
              | { code: ExternalExecutionFailureCode }
              | undefined;
            let parked = false;
            // A gate that answers the model with text instead of a throw still
            // owes the audit boundary its code.
            const refuse = (
              code: ExternalRefusalCode | "authz_denied",
              message: string,
            ): string => {
              auditError = new ExternalToolRefusal(code, message);
              return message;
            };
            try {
              // ── Kill switch (spec §6.11) ────────────────────────────────────
              // A switch on this version, its server, the connection it was
              // reached with, a class its version carries, the agent, the
              // operator, the workspace or the organisation stops the call. An
              // external tool's semantics are unknown, so every call re-reads
              // the deny generation (§7.4: non-read-only). Checked again before
              // the transport when the call waited on a person (an agent-consent
              // or first-use consent card), so a switch flipped during the wait
              // stops the call.
              const refuseIfKilled = async (): Promise<string | null> => {
                const killed = await killSwitches.check({
                  capabilityId: capturedKey,
                  serverId: externalServerId,
                  connectionId: raw.externalConnectionId ?? null,
                  readOnly: false,
                });
                if (killed === null) return null;
                // The capability path throws and the generic catch records
                // `err.name`. This path returns a message to the model instead
                // of throwing, so it records the same class off the same object
                // — one `error_class` counts every kill-switch refusal.
                const denied = new KillSwitchDeniedError(killed);
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
                        errorClass: denied.name,
                      },
                    ),
                  );
                } catch {
                  /* telemetry must never fail the call */
                }
                return refuse("kill_switch_denied", denied.message);
              };
              const killedBeforeGates = await refuseIfKilled();
              if (killedBeforeGates !== null) return killedBeforeGates;
              let waitedOnPerson = false;

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
              const recordIamDenial = async () => {
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
              };
              const iamResult = await runInTenantScope(
                { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                () =>
                  authorizeExternalCapability(capturedKey, ctx, "allow", {
                    audit: false,
                  }),
              );
              if (!iamResult.allowed) {
                await recordIamDenial();
                const reason = iamResult.reason ?? iamResult.outcome;
                return refuse(
                  iamRefusalCode(iamResult.reason),
                  `Tool blocked by workspace policy: ${reason}`,
                );
              }
              // ── End IAM gate ────────────────────────────────────────────────

              // ── Governed action admission (ADR-055, ADR-165) ────────────────
              // An external call Oxagen authorises bills one governed action
              // unit, so it is admitted by the same gate the kernel runs after
              // IAM for a capability (`assertGauAvailable`, installed there by
              // bootstrapBillingRuntime). A prepaid organisation with no units
              // left and no top-up is refused, as is one dunning suspended.
              //
              // Thrown, the way the kernel throws it for a capability tool, so
              // the model reads the refusal as the tool's error and the turn
              // carries on. Checked before the decision rules and the consent
              // gates, so nobody is asked to approve a call that would then be
              // refused for want of units. Read-only: the gate charges nothing.
              try {
                await runInTenantScope(
                  { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                  () => assertGauAvailable(ctx.orgId),
                );
              } catch (error) {
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
                          error instanceof Error
                            ? error.name
                            : "GovernedActionRefused",
                      },
                    ),
                  );
                } catch {
                  /* telemetry must never fail the call */
                }
                throw error;
              }
              // ── End governed action admission ───────────────────────────────

              const admitExternalDecision = externalDecisionCheck({
                approvalMode: opts.approvalMode,
                name: capturedKey,
                input,
                ctx,
                principal: iamResult.principal,
                runId: opts.runIdRef?.current ?? ctx.agentRun?.runId ?? null,
                onApprovalRequired: opts.onApprovalRequired
                  ? (event) => {
                      opts.onApprovalRequired?.(event);
                      if (opts.approvalMode === "park")
                        throw new ApprovalPendingError(
                          event.capability,
                          event.approvalId,
                          event.expiresAt,
                          event.approvalPublicId,
                        );
                    }
                  : undefined,
              });
              const checkDecisionRules: typeof admitExternalDecision = async (
                options,
              ) => {
                try {
                  await admitExternalDecision(options);
                } catch (error) {
                  // A rule's approval parks here under `approvalMode: "park"`.
                  const ended = thrownOutcome(error, "ExternalDecisionRefused");
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
                          status: ended.status,
                          outputBytes: 0,
                          latencyMs: Date.now() - startedAt,
                          errorClass: ended.error_class,
                        },
                      ),
                    );
                  } catch {
                    /* telemetry must never fail the call */
                  }
                  throw error;
                }
              };
              await checkDecisionRules();

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
                  return refuse(
                    "agent_rule_denied",
                    `Tool blocked: agent run carries no IAM resolution for ${capturedKey}`,
                  );
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
                  return refuse(
                    "agent_rule_denied",
                    `Tool blocked by agent role policy: mcp rule deny for ${serverTool}`,
                  );
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
                    return refuse(
                      "consent_unavailable",
                      `Tool blocked: agent consent required for ${serverTool}, but this server supports no durable consent`,
                    );
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
                    return refuse(
                      "consent_denied",
                      `Tool blocked: agent consent denied for ${capturedKey}`,
                    );
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
                      return refuse(
                        "consent_unavailable",
                        `Tool blocked: agent consent required for ${serverTool} (no interactive surface to ask)`,
                      );
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
                          runId: callAgentRun?.runId ?? null,
                          capabilityName: capturedKey,
                          inputPreview: input,
                          riskLevel: EXTERNAL_TOOL_RISK_LEVEL,
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
                    waitedOnPerson = true;
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
                      return refuse(
                        "consent_denied",
                        `Tool blocked: agent consent ${askResolution.resolution} for ${capturedKey}`,
                      );
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
                  return refuse(
                    "consent_denied",
                    `Tool blocked: consent denied for ${capturedKey}`,
                  );
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
                        riskLevel: EXTERNAL_TOOL_RISK_LEVEL,
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
                  waitedOnPerson = true;
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
                    return refuse(
                      "consent_denied",
                      `Tool blocked: consent ${resolution.resolution} for ${capturedKey}`,
                    );
                  }
                }
              }
              // ── End consent gate ────────────────────────────────────────────

              if (waitedOnPerson) {
                const killedDuringWait = await refuseIfKilled();
                if (killedDuringWait !== null) return killedDuringWait;
              }

              // Consent may have waited while rules or kill switches changed.
              await checkDecisionRules();
              const freshIam = await runInTenantScope(
                { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
                () =>
                  authorizeExternalCapability(capturedKey, ctx, "allow", {
                    audit: false,
                  }),
              );
              if (!freshIam.allowed) {
                await recordIamDenial();
                return refuse(
                  iamRefusalCode(freshIam.reason),
                  `Tool blocked by workspace policy: ${freshIam.reason ?? freshIam.outcome}`,
                );
              }
              // No interactive wait follows the final IAM check.
              await checkDecisionRules({
                principal: freshIam.principal,
                interactive: false,
              });
              const killedBeforeTransport = await refuseIfKilled();
              if (killedBeforeTransport !== null) return killedBeforeTransport;

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
                outcome = "allow";
                let result: unknown;
                try {
                  result = await capturedExecute(input, {
                    toolCallId: invocationId,
                    messages: [],
                  });
                } catch (err) {
                  executionFailure = externalExecutionFailure(err);
                  throw err;
                }
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
                // One governed action unit, for a call that completed. A call
                // refused by any gate above returned or threw before this
                // line, and a call the server failed threw out of
                // `capturedExecute` (an MCP `isError` result throws there
                // too), so neither bills.
                await recordExternalToolCall(ctx, {
                  invocationId,
                  toolCallId: modelToolCallId(options),
                  toolName: capturedKey,
                  mcpServer: capturedServerName,
                  // The kernel's order for its own ledger rows, so one run's
                  // capability calls and external calls group together.
                  runId:
                    opts.runIdRef?.current ??
                    ctx.agentRun?.runId ??
                    ctx.runId ??
                    ctx.executionStepId ??
                    null,
                  principalId: freshIam.principal?.id ?? null,
                  principalKind: freshIam.principal?.kind ?? null,
                });
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
            } catch (error) {
              parked = error instanceof ApprovalPendingError;
              auditError = executionFailure ?? error;
              const code =
                error && typeof error === "object" && "code" in error
                  ? error.code
                  : undefined;
              outcome =
                code === "decision_rule_denied" ||
                code === "decision_rule_approval_required" ||
                code === "external_tool_authority_unavailable"
                  ? "deny"
                  : "error";
              throw error;
            } finally {
              // A parked approval has no final invocation outcome yet.
              if (!parked)
                emitExternalCapabilityOutcome(
                  capturedKey,
                  ctx,
                  outcome,
                  Date.now() - startedAt,
                  auditError,
                );
            }
          },
        }),
      );
      mutatingToolNames.push(externalAlias);
      // An external tool's semantics are unknown here, so it is declared the
      // way the engine would treat an undeclared one: high risk, mutating.
      // Its consent card records the same level.
      governance[externalAlias] = {
        riskLevel: EXTERNAL_TOOL_RISK_LEVEL,
        requiresApproval: false,
        readOnly: false,
      };
    }
  }
  // ── End installable-plugin tools ────────────────────────────────────────────

  return { tools: out, nameMap, mutatingToolNames, governance };
}
