/**
 * Curated mechanism diagrams.
 *
 * These cannot be derived from a manifest — they describe *order*: which gate
 * runs before which, what a request writes at each hop. To keep them from
 * rotting, every flow cites the files and symbols it depicts in `refs`, and
 * the generator refuses to build when a cited file or symbol is gone
 * (`verifyRefs`). A hop that no longer exists in the tree therefore fails the
 * gate instead of surviving as a stale picture.
 *
 * A ref is `path` or `path#symbol`; the symbol must occur verbatim in the file.
 */
import type {
  ChainStep,
  DagEdge,
  DagNode,
  GridEdge,
  GridGroup,
  GridNode,
  SeqLane,
  SeqStep,
} from "./svg";

export type Flow =
  | {
      kind: "sequence";
      id: string;
      title: string;
      claim: string;
      lanes: SeqLane[];
      steps: SeqStep[];
      refs: string[];
      notes: string[];
      section: string;
    }
  | {
      kind: "chain";
      id: string;
      title: string;
      claim: string;
      steps: ChainStep[];
      perRow?: number;
      refs: string[];
      notes: string[];
      section: string;
    }
  | {
      kind: "grid";
      id: string;
      title: string;
      claim: string;
      nodes: GridNode[];
      edges: GridEdge[];
      groups: GridGroup[];
      refs: string[];
      notes: string[];
      section: string;
      cellW?: number;
      cellH?: number;
    }
  | {
      kind: "dag";
      id: string;
      title: string;
      claim: string;
      nodes: DagNode[];
      edges: DagEdge[];
      direction?: "down" | "right";
      refs: string[];
      notes: string[];
      section: string;
    };

const PG: SeqLane = {
  id: "pg",
  label: "Postgres",
  sub: "Aurora / local :5433",
  kind: "store",
};
const NEO: SeqLane = {
  id: "neo4j",
  label: "Neo4j",
  sub: "knowledge graph",
  kind: "store",
};
const CH: SeqLane = {
  id: "ch",
  label: "ClickHouse",
  sub: "telemetry",
  kind: "store",
};

export const flows: Flow[] = [
  // ───────────────────────────── Request path ─────────────────────────────
  {
    kind: "sequence",
    id: "request-path",
    section: "request",
    title: "One org-scoped API request",
    claim:
      "Every org+workspace route passes auth, org and workspace resolution before a handler runs, and every tenant read happens inside a transaction that has set the RLS GUCs.",
    lanes: [
      {
        id: "client",
        label: "Client",
        sub: "CLI · SDK · HTTP clients",
        kind: "actor",
      },
      { id: "mw", label: "apps/api", sub: "Hono middleware chain" },
      { id: "auth", label: "@oxagen/auth", sub: "resolvers" },
      { id: "kernel", label: "kernel.invoke", sub: "@oxagen/oxagen" },
      { id: "tenant", label: "withTenantDb", sub: "@oxagen/database" },
      PG,
    ],
    steps: [
      {
        from: "client",
        to: "mw",
        label: "HTTPS request",
        detail: "/v1/:org_slug/:workspace_slug/…",
      },
      {
        from: "mw",
        to: "auth",
        label: "Authorization: Bearer … ?",
        detail:
          "resolveApiKey (ox_ prefix) → orgId + workspaceId pre-bound from the key; a bad key is a 401, never a cookie fallback",
      },
      {
        from: "mw",
        to: "auth",
        label: "else session cookie",
        detail: "parseSessionCookie → resolveSession (Better Auth)",
      },
      {
        from: "mw",
        to: "auth",
        label: "orgMiddleware · workspaceMiddleware",
        detail:
          "resolveOrgScope / resolveWorkspaceScope by slug (skipped when the key pre-bound them)",
      },
      {
        from: "mw",
        to: "kernel",
        label:
          "capabilityContext(c) → invoke(name, input, ctx, { surface: 'api' })",
        detail: "apps/api/src/lib/context.ts",
      },
      {
        from: "kernel",
        to: "kernel",
        label: "gates run in order",
        detail: "see “Gate order inside invoke()” below",
      },
      {
        from: "kernel",
        to: "tenant",
        label:
          "IAM, billing, rules and the handler run inside runInTenantScope",
        detail: "@oxagen/tenancy AsyncLocalStorage",
      },
      {
        from: "tenant",
        to: "pg",
        label: "resolveDataPlane, then BEGIN; select set_config(…, true) ×4",
        detail:
          "app.current_org_id · app.current_workspace_id · app.org_wide = 'off' · app.rls_bypass",
        style: { accent: true },
      },
      {
        from: "tenant",
        to: "pg",
        label: "handler queries",
        detail: "tenant_isolation policy filters every FORCE RLS table",
      },
      {
        from: "pg",
        to: "client",
        label: "response",
        detail: "output validated against the contract",
      },
    ],
    refs: [
      "apps/api/src/middleware/auth.ts#authMiddleware",
      "apps/api/src/middleware/org.ts#orgMiddleware",
      "apps/api/src/middleware/workspace.ts#workspaceMiddleware",
      "apps/api/src/lib/context.ts#capabilityContext",
      "packages/auth/src/resolvers/api-key.ts#resolveApiKey",
      "packages/auth/src/resolvers/session.ts#resolveSession",
      "packages/tenancy/src/scope.ts#runInTenantScope",
      "packages/database/src/tenant.ts#withTenantDb",
      "packages/database/src/tenant.ts#withOrgPlaneSystemDb",
      "packages/database/src/unscoped-meter.ts#recordIfUnscoped",
      "packages/database/atlas/migrations/20260917120000_org_wide_read_mode.sql",
    ],
    notes: [
      "A Bearer header wins outright: the session cookie is never consulted, and the key's immutable org and workspace scope is copied onto the request. The slug middlewares return early, and the slugs in the URL are not checked against the key.",
      "The browser app and the MCP server do not pass through this chain. <code>apps/app</code> and <code>apps/mcp</code> each bootstrap the kernel and call <code>invoke()</code> in their own process.",
      "The four GUCs are set with <code>set_config(name, value, true)</code>, which is transaction-local. <code>app.rls_bypass</code> is always written explicitly so a policy never evaluates a missing setting. <code>app.org_wide</code> is <code>'off'</code> here and <code>'on'</code> only in <code>withOrgDb</code>, which unlocks the SELECT-only <code>tenant_org_wide_read</code> policies.",
      "<code>withSystemDb</code> is the audited bypass: it sets only <code>app.rls_bypass = 'on'</code> and always runs on the shared plane. <code>withOrgPlaneSystemDb</code> is the plane-aware variant for system writes to tenant-plane tables. A call made with no active tenant scope increments an in-process counter, written to a debug log line as <code>db.query.unscoped</code>.",
    ],
  },
  {
    kind: "chain",
    id: "invoke-gates",
    section: "kernel",
    title: "Gate order inside invoke()",
    claim:
      "A refused call never reaches a handler, and every refusal except the lifecycle and replay-input checks leaves a security event. Only a top-level, billable invoke() accrues a governed action.",
    perRow: 4,
    steps: [
      {
        label: "Lookup",
        sub: "getCapability(name)",
        exit: "unknown_capability",
      },
      {
        label: "Forged binding?",
        sub: "caller-supplied authz",
        exit: "authz_denied",
      },
      {
        label: "Platform only?",
        sub: "cap.platformOnly",
        exit: "authz_denied",
      },
      {
        label: "Lifecycle context?",
        sub: "opts.execution",
        exit: "lifecycle_*",
      },
      {
        label: "Surface allowed?",
        sub: "cap.surfaces",
        exit: "surface_denied",
      },
      {
        label: "Input valid?",
        sub: "cap.input.safeParse",
        exit: "invalid_input",
      },
      {
        label: "Enter tenant scope",
        sub: "runInTenantScope",
      },
      {
        label: "IAM",
        sub: "key scope → checkIAM",
        accent: true,
        exit: "authz_denied · pending_approval",
      },
      {
        label: "Billing admission",
        sub: "assertGauAvailable",
        exit: "gau_exhausted · suspended",
      },
      {
        label: "Budget admission",
        sub: "assertWithinSpendBudget",
        exit: "budget_exceeded",
      },
      {
        label: "Entitlement",
        sub: "plugin-claimed contracts only",
        exit: "capability_not_installed",
      },
      {
        label: "Decision rules",
        sub: "_decisionRulesGate",
        exit: "decision_rule_*",
      },
      {
        label: "Handler",
        sub: "runWithPrincipal",
        exit: "no_handler",
      },
      {
        label: "Output valid?",
        sub: "cap.output.safeParse",
        exit: "invalid_output",
      },
      {
        label: "Settle and audit",
        sub: "emitSecurityEvent",
      },
      {
        label: "Accrue action",
        sub: "usageRecorder",
        accent: true,
      },
    ],
    refs: [
      "packages/oxagen/src/kernel.ts#_invokeCoreInner",
      "packages/oxagen/src/kernel.ts#setBillingAdmissionGate",
      "packages/oxagen/src/kernel.ts#setUsageRecorder",
      "packages/oxagen/src/kernel.ts#cap.platformOnly",
      "packages/oxagen/src/kernel.ts#assertValidatedInput",
      "packages/iam/src/bootstrap.ts#machineKeyDenial",
      "packages/iam/src/check-iam.ts#checkIAM",
      "packages/billing/src/gau-bucket.ts#assertGauAvailable",
      "packages/billing/src/spend-budget-gate.ts#assertWithinSpendBudget",
      "packages/billing/src/bootstrap.ts#bootstrapBillingRuntime",
      "packages/rules/src/gate.ts#decision_rule_denied",
    ],
    notes: [
      "The surface check runs only when the caller passes <code>opts.surface</code>. The kernel enters the tenant scope when the contract is scoped or both tenant ids are uuids. A machine key whose scope does not cover the capability is refused before <code>checkIAM</code>. A <code>pending_approval</code> result also creates an <code>access_requests</code> row. The decision-rules gate may reserve a settlement, which the audit step settles and the catch block releases.",
      "The billing, budget and usage slots are empty until <code>bootstrapBillingRuntime()</code> fills them, once per process. A surface that does not bootstrap runs those gates open. <code>apps/api</code> and <code>apps/mcp</code> also bootstrap IAM, decision rules and entitlement at startup.",
      "IAM enforcement is always on: <code>bootstrapIAMRuntime</code> registers the check with enforcement set to <code>true</code>, and no code reads <code>IAM_ENFORCEMENT_ENABLED</code> any more. An IAM throw fails closed. An agent-run invocation also fails closed when its IAM check returns no persisted authorization decision.",
      "Every failure exits before the accrual step. Lookup, binding, surface and input refusals throw before the tenant scope opens. IAM, billing, budget, entitlement, rules and handler failures leave through the catch block, which releases any reserved settlement. An invalid output throws after that. This is how ADR-052's rule that denials are free is enforced by structure, not by policy.",
    ],
  },
  {
    kind: "chain",
    id: "iam-order",
    section: "kernel",
    title: "checkIAM decision order",
    claim:
      "Agent principals are checked against their pinned ceiling at every plan tier. The tier fast-path applies to non-agent principals only, and when the tier cannot be established the full resolver runs instead.",
    perRow: 4,
    steps: [
      {
        label: "Machine key scope",
        sub: "machineKeyDenial",
        exit: "deny, no audit row",
      },
      { label: "Principal kind", sub: "arg → ctx.agentRun → 'human'" },
      {
        label: "Agent branch",
        sub: "pinned ceiling ∩ live authority, deny-wins",
        accent: true,
        exit: "iam.authorization_decisions row",
      },
      {
        label: "Tier fast-path",
        sub: "established && !canAccessACL(tier)",
        exit: "audit rule: tier_gate",
      },
      {
        label: "fetchAuthz",
        sub: "role grants (withOrgDb)",
      },
      { label: "resolve()", sub: "pure evaluator, @oxagen/oxagen/iam" },
      { label: "emitAudit", sub: "ClickHouse audit_events, hash-chained" },
    ],
    refs: [
      "packages/iam/src/bootstrap.ts#machineKeyDenial",
      "packages/iam/src/check-iam.ts#checkIAM",
      "packages/iam/src/fetch-authz.ts#withOrgDb",
      "packages/iam/src/emit-audit.ts#AuditEventRow",
      "packages/oxagen/src/iam/index.ts",
      "packages/run-evidence/src/digest.ts#digestJcs",
    ],
    notes: [
      "The audit row stores <code>payload_hash</code>, a sha256 of the serialised validated input, never the input itself. <code>chain_hash = sha256(prev | event_id | capability)</code> per (org, capability) chain. Verification is at range level, because two concurrent writes can read the same predecessor.",
      "The audit write is fire-and-forget and makes up to three attempts. A failed emission is captured to the <code>error_events</code> table.",
      "A machine key whose scope does not cover the capability is refused before <code>checkIAM</code> runs, so that refusal writes no <code>audit_events</code> row and no decision.",
    ],
  },
  {
    kind: "grid",
    id: "data-planes",
    section: "request",
    title: "Tenant data planes (ADR-042)",
    claim:
      "Every store switches at the organisation. A request resolves the org's binding per store kind and is routed to the shared pool or a dedicated one. Degraded and disabled bindings, and a dedicated binding with no config, fail closed.",
    cellW: 160,
    nodes: [
      {
        id: "req",
        label: "tenant scope",
        sub: "orgId · workspaceId",
        col: 0,
        row: 1,
        kind: "actor",
      },
      {
        id: "resolver",
        label: "resolveDataPlane",
        sub: "cached 5 s per (org, kind)",
        col: 1,
        row: 1,
        accent: true,
      },
      {
        id: "table",
        label: "org.data_planes",
        sub: "kind · mode · status · KMS envelope",
        col: 1,
        row: 2,
        kind: "store",
      },
      {
        id: "sharedpg",
        label: "shared Postgres",
        sub: "process singleton",
        col: 2,
        row: 0,
        kind: "store",
      },
      {
        id: "dedpg",
        label: "dedicated Postgres",
        sub: "pool per (org, digest), LRU cap 16",
        col: 3,
        row: 0,
        kind: "store",
      },
      {
        id: "sharedneo",
        label: "shared Neo4j",
        sub: "pooled db or org-<ns> db (ADR-098)",
        col: 2,
        row: 1,
        kind: "store",
      },
      {
        id: "dedneo",
        label: "dedicated Neo4j",
        sub: "driver per (org, digest), LRU cap 16",
        col: 3,
        row: 1,
        kind: "store",
      },
      {
        id: "sharedch",
        label: "shared ClickHouse",
        sub: "",
        col: 2,
        row: 2,
        kind: "store",
      },
      {
        id: "dedch",
        label: "dedicated ClickHouse",
        sub: "client per (org, digest), LRU cap 16",
        col: 3,
        row: 2,
        kind: "store",
      },
    ],
    edges: [
      { from: "req", to: "resolver", label: "resolve(orgId, kind)" },
      { from: "resolver", to: "table", label: "read binding", route: "v" },
      { from: "resolver", to: "sharedpg", label: "mode=shared" },
      { from: "resolver", to: "sharedneo", label: "mode=shared" },
      { from: "resolver", to: "sharedch", label: "mode=shared" },
      {
        from: "sharedpg",
        to: "dedpg",
        label: "mode=dedicated",
        style: { dashed: true },
      },
      {
        from: "sharedneo",
        to: "dedneo",
        label: "mode=dedicated",
        style: { dashed: true },
      },
      {
        from: "sharedch",
        to: "dedch",
        label: "mode=dedicated",
        style: { dashed: true },
      },
    ],
    groups: [
      {
        label:
          "one binding per (org, kind) · status: active | degraded | disabled",
        col: 2,
        row: 0,
        colspan: 2,
        rowspan: 3,
      },
    ],
    refs: [
      "packages/tenancy/src/data-plane.ts#resolveDataPlane",
      "packages/database/src/data-plane-resolver.ts#DATA_PLANE_CACHE_TTL_MS",
      "packages/database/src/data-plane-pool.ts#MAX_DEDICATED_POOLS",
      "packages/ontology/src/data-plane-driver.ts#MAX_DEDICATED_DRIVERS",
      "packages/telemetry/src/data-plane-client.ts#MAX_DEDICATED_CLICKHOUSE_CLIENTS",
    ],
    notes: [
      "The decrypted plane config never leaves the resolver except inside a binding handed to a store client; it is never logged, serialised into an error, or returned by a read capability.",
      "The resolver reads <code>org.data_planes</code> through <code>withSystemDb</code> on the shared plane, so <code>withSystemDb</code> itself cannot be plane-aware without a cycle. <code>withOrgPlaneSystemDb</code> resolves the plane first, for system writes to tenant-plane tables.",
    ],
  },

  // ───────────────────────────── Governed turn ─────────────────────────────
  {
    kind: "sequence",
    id: "governed-turn",
    section: "agent",
    title: "The governed turn (in-app assistant)",
    claim:
      "Funding is decided before the credit gate, the turn is a ledger run before the engine is asked, the loop runs on stella-serve over loopback with no fallback, and every completion and tool call comes back to Oxagen to answer.",
    lanes: [
      { id: "client", label: "Client", sub: "SSE consumer", kind: "actor" },
      { id: "route", label: "chat.stream", sub: "apps/api SSE adapter" },
      { id: "kernel", label: "kernel.invoke" },
      {
        id: "turn",
        label: "ask_assistant",
        sub: "assistant-turn.ts · @oxagen/agent",
      },
      { id: "agent", label: "runGovernedTurn", sub: "@oxagen/agent" },
      {
        id: "engine",
        label: "stella-serve",
        sub: "loopback :4300",
        kind: "external",
      },
      { id: "ai", label: "@oxagen/ai", sub: "provider port" },
      PG,
      NEO,
      CH,
    ],
    steps: [
      { from: "client", to: "route", label: "POST /v1/:org/:ws/chat/stream" },
      {
        from: "route",
        to: "kernel",
        label:
          "invoke('ask_assistant', { conversationId, content, pageContext })",
        detail: "surface 'api' · IAM, audit and rules gates · noBillingGate",
      },
      {
        from: "kernel",
        to: "turn",
        label: "prepareAssistantTurn",
        detail:
          "resolveActingUserId → assertOrgRole; an API key asks as its creator",
      },
      {
        from: "turn",
        to: "ai",
        label: "resolveModelFundingSource(orgId)",
        detail: "BYOK credential or platform key, decided first (ADR-053 §2)",
      },
      {
        from: "turn",
        to: "turn",
        label: "evaluateTurnCreditGate({ fundedBy })",
        detail:
          "402 before the stream opens: insufficient_credits · billing_suspended · assistant_spend_cap",
      },
      {
        from: "turn",
        to: "pg",
        label:
          "open conversation · read last 50 messages · insert user message",
      },
      {
        from: "turn",
        to: "kernel",
        label: "invoke('get_user_budget') · invoke('get_budget_policy')",
        detail: "each fails open",
      },
      {
        from: "turn",
        to: "kernel",
        label: "recallWorkspaceMemoryMessage → invoke('recall_memory')",
        detail: "limit 6 · 2.5 s timeout · fails open",
      },
      {
        from: "kernel",
        to: "neo4j",
        label: "vector recall",
        detail: "memory_embedding_index over :AgentMemory",
      },
      {
        from: "turn",
        to: "pg",
        label: "openAssistantRun",
        detail:
          "the evidence-ledger run is admitted before the engine is asked; 503 assistant_run_not_recorded otherwise",
      },
      {
        from: "turn",
        to: "agent",
        label: "materializeTools (park) → createToolBelt → runGovernedTurn",
        style: { accent: true },
      },
      {
        from: "agent",
        to: "engine",
        label: "assertToolListFitsProvider → assertEngineReady → driveTurn",
        detail: "EngineUnavailableError, no fallback (ADR-053 §4)",
      },
      {
        from: "engine",
        to: "ai",
        label: "onProviderRequest → streamAgentReply (1 step)",
        detail: "budget guard may abort: 'turn budget exhausted'",
      },
      {
        from: "ai",
        to: "pg",
        label: "token usage + charge staged in usage_outbox",
        detail: "priced in full, charged only when platform-funded",
      },
      {
        from: "pg",
        to: "ch",
        label: "billing.usage-delivery → token_usage",
        detail: "Inngest cron, every minute",
        style: { dashed: true },
      },
      {
        from: "engine",
        to: "kernel",
        label:
          "onToolRequest → tool.execute → invoke(capability, …, { surface: 'agent' })",
        detail:
          "external MCP tools use the MCP transport · approvals park as cards · mutating tools serialised",
      },
      {
        from: "agent",
        to: "ch",
        label: "tool_invocations row",
        detail: "one per tool call, failure-isolated",
      },
      {
        from: "route",
        to: "client",
        label:
          "SSE: run · parts · approval-required · budget-notice · usage · done",
        detail: "createApiStreamTranslator owns the part shapes",
      },
      {
        from: "turn",
        to: "pg",
        label: "insert assistant message · set conversation leaf",
        detail: "skipped when the stream errored",
      },
      {
        from: "turn",
        to: "kernel",
        label:
          "invoke('get_message_execution', { status: 'completed', steps })",
        detail:
          "the SOC 2 execution record, built from the ledger receipts; best effort",
      },
    ],
    refs: [
      "apps/api/src/routes/v1/chat.stream.ts#chatStreamRoute",
      "apps/api/src/routes/v1/chat-stream-translator.ts#createApiStreamTranslator",
      "packages/agent/src/handlers/assistant.ask.ts#assistantAskHandler",
      "packages/agent/src/runtime/assistant-stream.ts#streamAssistantTurn",
      "packages/agent/src/runtime/assistant-turn.ts#prepareAssistantTurn",
      "packages/agent/src/runtime/assistant-turn.ts#HISTORY_LIMIT = 50",
      "packages/agent/src/runtime/assistant-turn.ts#recordTurnExecution",
      "packages/agent/src/runtime/assistant-run.ts#openAssistantRun",
      "packages/agent/src/runtime/assistant-recall.ts#recallWorkspaceMemoryMessage",
      "packages/agent/src/memory/neo4j.ts#memory_embedding_index",
      "packages/ai/src/funding-source.ts#resolveModelFundingSource",
      "packages/ai/src/record-token-usage.ts#finalizeUsage",
      "packages/billing/src/turn-credit-gate.ts#evaluateTurnCreditGate",
      "packages/agent/src/runtime/governed-turn.ts#runGovernedTurn",
      "packages/agent/src/runtime/materialize-tools.ts#materializeTools",
      "packages/agent/src/runtime/tool-budget.ts#assertToolListFitsProvider",
      "packages/agent/src/runtime/engine/provider.ts#createProviderPort",
      "packages/agent/src/runtime/engine/tools.ts#executeToolRequest",
      "packages/ai/src/stream.ts#streamAgentReply",
      "packages/inngest-functions/src/functions/billing.usage-delivery.ts#billing.usage-delivery",
    ],
    notes: [
      "The same turn runs behind four adapters: the SSE route drawn here, <code>POST /assistant/ask</code>, the MCP tool, and the app's shell flyout, which invokes <code>ask_assistant</code> from a Server Action and receives the whole reply rather than a stream.",
      "stella-serve holds no key and runs no tool. Every completion comes back as a provider request answered through <code>streamAgentReply</code>, and every tool call comes back as a tool request. Each request is written ahead as a ledger receipt, and the run is sealed when the engine reports its outcome.",
      "A write that needs approval is parked as a card in the reply, not awaited. The waits that remain are first-use MCP consent and the budget prompt, each up to 5 minutes.",
      "There is no Inngest hop for messages: <code>assistant-turn.ts</code> writes them inline inside <code>withTenantDb</code>. Token usage alone goes through the usage outbox. The <code>chat.persist-stream</code> function named in older codemaps has no sender and no file.",
      "Role routing inside the provider port: verdict and judge calls run on a tier other than the worker's (<code>precise</code>, or <code>balanced</code> when the worker is <code>precise</code>). Summarisation, reflection and domain inference use <code>fast</code>. Everything else runs on the turn's worker model.",
      "Context records (ADR-051, superseded by ADR-043) do not enter this turn. ADR-091 re-lands their delivery for external agents through the policy bundle. The volatile user messages here are the page context and recalled workspace memory. Checked workspace instructions ride in the system prompt.",
    ],
  },

  // ───────────────────────────── Evidence ─────────────────────────────
  {
    kind: "grid",
    id: "ledger-hierarchy",
    section: "evidence",
    title: "The evidence ledger's record chain",
    claim:
      "A run owns immutable attempts, and each attempt owns a dense, digest-chained event log. A seal closes the attempt and, in the same transaction, sets the run's status and mints exactly one finalization grant and one obligation.",
    cellW: 270,
    nodes: [
      {
        id: "run",
        label: "agent_runs",
        sub: "arun_… · RunSpecV2 · status",
        col: 0,
        row: 1,
        kind: "store",
      },
      {
        id: "attempt",
        label: "agent_run_attempts",
        sub: "arat_… · engine pinned · immutable",
        col: 1,
        row: 1,
        kind: "store",
      },
      {
        id: "events",
        label: "agent_run_events",
        sub: "attempt_seq dense from 1 · event_digest",
        col: 2,
        row: 1,
        kind: "store",
      },
      {
        id: "frames",
        label: "ingest_run_frames",
        sub: "POST /v1/run-ingest · run-token scoped",
        col: 2,
        row: 0,
      },
      {
        id: "seal",
        label: "agent_run_attempt_seals",
        sub: "event_stream_digest · one per attempt",
        col: 2,
        row: 2,
        kind: "store",
        accent: true,
      },
      {
        id: "grant",
        label: "agent_run_finalization_grants",
        sub: "afg_… = submission_id · one shot",
        col: 1,
        row: 2,
        kind: "store",
      },
      {
        id: "obl",
        label: "agent_run_finalization_obligations",
        sub: "durable outbox · one per grant",
        col: 0,
        row: 2,
        kind: "store",
      },
      {
        id: "ingest",
        label: "ingest_run_evidence (planned)",
        sub: "RunEvidenceEnvelopeV1 · JCS ≤ 1 MiB · not built",
        col: 1,
        row: 3,
      },
    ],
    edges: [
      { from: "run", to: "attempt", label: "1 : n" },
      { from: "attempt", to: "events", label: "1 : n, append-only" },
      { from: "frames", to: "events", label: "appendAttemptBatch", route: "v" },
      { from: "events", to: "seal", label: "fold → seal", route: "v" },
      { from: "seal", to: "grant", label: "same tx" },
      { from: "grant", to: "obl", label: "same tx" },
      {
        from: "obl",
        to: "run",
        label: "same tx: runStatusForTerminal",
        route: "v",
      },
      {
        from: "grant",
        to: "ingest",
        label: "to be consumed once",
        route: "v",
        style: { dashed: true },
      },
    ],
    groups: [
      {
        label: "@oxagen/run-ledger is the only writer of these tables",
        col: 0,
        row: 1,
        colspan: 3,
        rowspan: 2,
      },
    ],
    refs: [
      "packages/run-ledger/src/run-store.ts#ATTEMPT_TERMINAL_STATUSES",
      "packages/run-ledger/src/run-store.ts#runStatusForTerminal",
      "packages/run-ledger/src/finalization-grant.ts#FINALIZATION_GRANT_CAPABILITY",
      "packages/run-ledger/src/event-payload-registry.ts#EVIDENCE_STAGES",
      "packages/database/src/schema/agent.ts#agent_run_finalization_grants",
      "packages/database/src/schema/agent.ts#agent_run_finalization_obligations",
      "packages/oxagen/src/contracts/run.frames.ingest.ts#ingest_run_frames",
      "packages/handlers/src/run.frames.ingest.ts#appendAttemptBatch",
      "packages/run-evidence/src/digest.ts#digestJcs",
      "packages/run-evidence/src/limits.ts#MAX_ENVELOPE_JCS_BYTES",
      "docs/specs/tacho/spec.md#ingest_run_evidence",
    ],
    notes: [
      "The stream digest folds only <code>(attempt_seq, schema_version, event_type, payload_digest)</code>, deliberately excluding stage and observed time, so a finalizer can reproduce it from the log alone.",
      "A repeated <code>(attempt_id, attempt_seq)</code> with a different digest is an integrity error: the insert has no <code>ON CONFLICT</code>, the transaction rolls back, and <code>agent_run.event_sequence_conflict</code> is emitted afterwards.",
      "Grants carry no expiry column. The seal binding and one successful consumption are meant to limit a grant, but the consumption record and <code>ingest_run_evidence</code> are not built yet. <code>(org_id, submission_id)</code> is already unique on the obligations table.",
      "Two producers write this ledger today: external engines through <code>ingest_run_frames</code>, and the in-app assistant, which opens and seals a run for every turn. A wrapped (tacho) session is sealed on <code>tacho.sessions</code> and has no attempt row.",
    ],
  },
  {
    kind: "dag",
    id: "run-states",
    section: "evidence",
    title: "Run and attempt status",
    claim:
      "An attempt is either open or sealed. Its terminal status maps onto the run, where denied and abandoned both read as failed because the denial itself is the evidence.",
    direction: "right",
    nodes: [
      { id: "pending", label: "pending", kind: "state" },
      { id: "running", label: "running", kind: "state" },
      { id: "completed", label: "completed", kind: "state", accent: true },
      { id: "failed", label: "failed", kind: "state" },
      { id: "cancelled", label: "cancelled", kind: "state" },
      { id: "a_open", label: "attempt: open", kind: "state" },
      { id: "a_completed", label: "sealed: completed", kind: "state" },
      { id: "a_failed", label: "sealed: failed", kind: "state" },
      { id: "a_cancelled", label: "sealed: cancelled", kind: "state" },
      { id: "a_denied", label: "sealed: denied", kind: "state" },
      { id: "a_abandoned", label: "sealed: abandoned", kind: "state" },
    ],
    edges: [
      { from: "pending", to: "running", label: "an attempt opens" },
      {
        from: "running",
        to: "a_open",
        label: "attempt",
        style: { dashed: true },
      },
      { from: "a_open", to: "a_completed", label: "seal" },
      { from: "a_open", to: "a_failed", label: "seal" },
      { from: "a_open", to: "a_cancelled", label: "seal" },
      { from: "a_open", to: "a_denied", label: "seal" },
      { from: "a_open", to: "a_abandoned", label: "seal" },
      { from: "a_completed", to: "completed", label: "runStatusForTerminal" },
      { from: "a_cancelled", to: "cancelled" },
      { from: "a_failed", to: "failed" },
      { from: "a_denied", to: "failed" },
      { from: "a_abandoned", to: "failed" },
    ],
    refs: [
      "packages/run-ledger/src/run-store.ts#ATTEMPT_TERMINAL_STATUSES",
      "packages/run-ledger/src/run-store.ts#runStatusForTerminal",
      "packages/database/src/schema/agent.ts#cancel_requested",
      "packages/database/src/schema/agent.ts#ingress_paused",
      "packages/handlers/src/run.fork.ts",
      "packages/run-ledger/src/run-control.ts#cancelRunInTransaction",
      "packages/run-ledger/src/run-store.ts#EMPTY_EVENT_STREAM_DIGEST",
    ],
    notes: [
      "Run status values: <code>pending · running · completed · failed · cancelled</code>. Attempt terminal statuses: <code>completed · failed · cancelled · denied · abandoned</code>.",
      "Every new attempt sets the run to <code>running</code>, including a <code>fork_run</code> successor on a run that was already sealed.",
      "Any seal may close an attempt with zero events. It then carries the canonical empty-stream digest.",
      "Pause and cancel are flags on the run, not statuses. <code>ingress_paused</code> and <code>cancel_requested</code> stop new evidence from being appended while the run keeps its status. Pause does not touch the producer's process. Cancel also revokes the run's credentials in the same transaction (ADR-056).",
    ],
  },
  {
    kind: "sequence",
    id: "tacho",
    section: "evidence",
    title: "Wrapping: evidencing an agent Oxagen does not run",
    claim:
      "The hook is answered only after the event is chained and appended to the host's write-ahead log. The control plane recomputes every hash on ingest and records a broken chain rather than rejecting the batch.",
    lanes: [
      {
        id: "harness",
        label: "agent harness",
        sub: "Claude Code · Codex · Cursor · Stella · custom",
        kind: "external",
      },
      {
        id: "tachod",
        label: "tachod",
        sub: "per-host collector",
        kind: "external",
      },
      { id: "api", label: "/v1/tacho/*", sub: "apps/api, API-key tier" },
      { id: "handler", label: "ingest_tacho_events", sub: "@oxagen/handlers" },
      PG,
      CH,
    ],
    steps: [
      {
        from: "harness",
        to: "tachod",
        label: "hook event",
        detail: "PreToolUse (fail-closed) · PostToolUse · SessionEnd …",
      },
      {
        from: "tachod",
        to: "tachod",
        label: "normalize → tacho/1.0 · dense seq · hash chain · WAL append",
        detail: "answered only after the WAL append",
        style: { accent: true },
      },
      {
        from: "tachod",
        to: "harness",
        label: "allow | deny | ask",
        detail:
          "from the cached ed25519-signed policy bundle; a defer refreshes the bundle, then fails closed in enforce mode",
      },
      {
        from: "harness",
        to: "tachod",
        label: "model call via the loopback model proxy",
        detail:
          "/anthropic · /backend-api/codex · /stella/anthropic, sealed as an llm_call frame",
      },
      {
        from: "tachod",
        to: "api",
        label: "POST /v1/tacho/events (tacho.batch.v1, ≤200 events, ≤4 MiB)",
        detail:
          "per minute: pre-auth 6000 per IP, 150 per credential; 120 per host for events",
      },
      {
        from: "api",
        to: "handler",
        label: "invoke(ingest_tacho_events)",
        detail: "tenant from the key's tacho_host_v1 scope, never the body",
      },
      {
        from: "handler",
        to: "handler",
        label: "recompute every hash · check chain against stored head",
        detail: "break → chain_verified=false, recorded, never rejected",
      },
      {
        from: "handler",
        to: "pg",
        label:
          "write tacho.sessions · session_models · session_files · session_commands",
        detail: "plus host liveness, the enforcement tier and proof verdicts",
      },
      {
        from: "handler",
        to: "ch",
        label: "tacho_events rows, after the Postgres commit",
        detail:
          "ReplacingMergeTree(received_at) on (org, ws, session_uuid, seq)",
      },
      {
        from: "handler",
        to: "tachod",
        label:
          "response: chain_breaks · host_status · deny_generation · bundle_etag · commands",
        detail:
          "pause · resume · cancel · steer · message · revoke · refresh_bundle · kill",
      },
      {
        from: "handler",
        to: "pg",
        label: "agent_stop (SessionEnd) → session sealed and graded",
        detail:
          "replay_grade and completeness_gaps on tacho.sessions; a root session emits cost/run.sealed",
      },
    ],
    refs: [
      "packages/tacho/src/envelope.ts#TACHO_ENVELOPE_VERSION",
      "packages/tacho/src/wire.ts#TACHO_BATCH_SCHEMA",
      "packages/tacho/src/wire.ts#TACHO_MAX_BATCH",
      "packages/tacho/src/wire.ts#TACHO_MAX_REQUEST_BYTES",
      "packages/tacho/src/wire.ts#WRAPPED_HARNESSES",
      "packages/tacho/src/wire.ts#MODEL_HARNESS_ROUTES",
      "packages/tacho/src/collector/hook-handler.ts#bundle_stale",
      "packages/tacho/src/collector/model-proxy.ts",
      "packages/database/src/schema/tacho.ts#TACHO_ENFORCEMENT_TIERS",
      "packages/database/src/schema/tacho.ts#TACHO_COMMANDS",
      "packages/handlers/src/tacho.events.ingest.ts#sealTachoSession",
      "packages/handlers/src/tacho.events.ingest.ts#enforcementTierOf",
      "apps/api/src/routes/v1/tacho.events.ingest.ts",
      "apps/api/src/app.ts#TACHO_INGEST_PER_MIN",
      "apps/api/src/middleware/distributed-rate-limit.ts#distributedRateLimiter",
      "packages/telemetry/src/tacho-events-ddl.ts",
    ],
    notes: [
      "Four enforcement tiers. <code>observe</code> means the host only records. <code>harness</code> means the hook enforces inside a process Oxagen does not own. <code>gateway</code> needs a verified chain that routed a model or MCP call through the host's loopback model proxy or local MCP gateway. <code>contained</code> also needs a registered contained launch whose genesis hash matches. The tier is set at ingest, only rises while the session is live, and is final once sealed.",
      "The ClickHouse DDL for <code>tacho_events</code> is generated from the envelope schema. A test fails when the SQL and the schema disagree.",
      "The session is sealed on <code>tacho.sessions</code>, not in the evidence ledger. Building a <code>RunEvidenceEnvelopeV1</code> for <code>ingest_run_evidence</code> is planned.",
    ],
  },

  // ───────────────────────────── Metering → billing ─────────────────────────────
  {
    kind: "sequence",
    id: "metering",
    section: "billing",
    title: "From governed action to GAU bucket debit (ADR-052, ADR-055)",
    claim:
      "The billable unit is the outermost invoke(). Tokens are reported, and charged only when the platform key paid for them. The debit to the organisation's month bucket is one upsert that commits before any claim or provider call, so a failed top-up or interim invoice leaves the action counted and the request intact.",
    lanes: [
      {
        id: "kernel",
        label: "kernel.invoke",
        sub: "top-level, admitted, executed",
      },
      {
        id: "recorder",
        label: "usage recorder",
        sub: "@oxagen/billing bootstrap",
      },
      { id: "meter", label: "recordGovernedAction", sub: "action-metering.ts" },
      { id: "bucket", label: "ensureCurrentBucket", sub: "gau-bucket.ts" },
      PG,
      {
        id: "stripe",
        label: "Stripe",
        sub: "charges · webhooks",
        kind: "external",
      },
    ],
    steps: [
      {
        from: "kernel",
        to: "recorder",
        label: "after output validation",
        detail:
          "skipped when the contract is noBillingGate, the invoke is nested, or the call carries no orgId",
      },
      {
        from: "recorder",
        to: "meter",
        label:
          "recordGovernedAction({ orgId, actions, capability, runId, now })",
        detail:
          "the recorder resolves terms itself; a caller cannot claim cheaper ones",
      },
      {
        from: "meter",
        to: "pg",
        label: "resolveGauEntitlement · readOrgBillingSettings",
        detail:
          "contracted terms, prepaid or invoice mode, periodFor → the org's month",
      },
      {
        from: "meter",
        to: "bucket",
        label: "ensureCurrentBucket({ period, terms, usedDelta: actions })",
      },
      {
        from: "bucket",
        to: "pg",
        label:
          "INSERT … ON CONFLICT (org_id, period_start) DO UPDATE used_gau += actions",
        detail:
          "billing.gau_buckets: lazy create and debit in one statement, row lock",
        style: { accent: true },
      },
      {
        from: "meter",
        to: "meter",
        label: "remainingGau = included + purchased + carried − used",
        detail: "negative when overdrawn",
      },
      {
        from: "meter",
        to: "pg",
        label:
          "claimAutoTopup (prepaid · remaining ≤ 0 · auto top-up on · card saved · no open episode)",
        detail:
          "marks the bucket and inserts a pending billing.gau_settlements row, committed before any provider call",
        style: { dashed: true },
      },
      {
        from: "meter",
        to: "pg",
        label:
          "claimInterimInvoice (invoice mode · uninvoiced overage ≥ invoice_gau_max)",
        detail:
          "a pending interim settlement; an invoice-billed org is never capped",
        style: { dashed: true },
      },
      {
        from: "meter",
        to: "stripe",
        label: "settleGauInvoice",
        detail:
          "creates, finalizes and pays the invoice; a failure leaves the row pending for billing.gau-close",
        style: { dashed: true },
      },
      {
        from: "stripe",
        to: "pg",
        label: "invoice.paid → settleGauPaid",
        detail:
          "grants purchased_gau once, on the current bucket; a block purchase is granted on checkout.session.completed",
        style: { dashed: true },
      },
    ],
    refs: [
      "packages/oxagen/src/kernel.ts#_usageRecorder",
      "packages/billing/src/bootstrap.ts#setUsageRecorder",
      "packages/billing/src/action-metering.ts#recordGovernedAction",
      "packages/billing/src/contract-terms.ts#resolveGauEntitlement",
      "packages/billing/src/billing-settings.ts#readOrgBillingSettings",
      "packages/billing/src/gau-bucket.ts#periodFor",
      "packages/billing/src/gau-bucket.ts#ensureCurrentBucket",
      "packages/billing/src/gau-bucket.ts#remainingGau",
      "packages/billing/src/gau-settlements.ts#claimAutoTopup",
      "packages/billing/src/gau-settlements.ts#claimInterimInvoice",
      "packages/billing/src/gau-settlements.ts#settleGauInvoice",
      "packages/billing/src/gau-settlements.ts#settleGauPaid",
      "packages/billing/src/gau-settlements.ts#grantGauPurchaseForCheckout",
      "packages/billing/src/webhooks.ts#processStripeEvent",
      "apps/api/src/routes/stripe.ts",
      "packages/inngest-functions/src/functions/billing.dunning-sweep.ts",
      "packages/inngest-functions/src/functions/billing.gau-close.ts",
      "packages/inngest-functions/src/functions/billing.usage-delivery.ts",
    ],
    notes: [
      "Stripe idempotency is three-phase: insert into <code>stripe_events</code> with <code>ON CONFLICT DO NOTHING</code>; treat as duplicate only if a processing row has <code>processed_at</code>; dispatch, then record the outcome. A prior failed attempt re-dispatches, so a provider retry self-heals. It is not exactly-once.",
      "Three billing crons run. <code>billing.dunning-sweep</code> (02:00 UTC) moves orgs from grace to suspended once grace ends, then pages through active orgs for credit low-balance notifications. <code>billing.gau-close</code> (hourly at :10) closes ended months, invoices month-end overage, and resumes settlements still pending. <code>billing.usage-delivery</code> (every minute, concurrency 1) drains <code>billing.usage_outbox</code> into ClickHouse.",
      "<code>invoice.paid</code> also still deposits a plan's legacy subscription credits into the credit ledger through <code>grantPlanCreditsForInvoicePaid</code>. Those credits fund platform-key assistant turns.",
      "The <code>stripe.sync-*</code> events named in older inventories have no sender; the webhook route handles those events inline.",
    ],
  },
  {
    kind: "chain",
    id: "gau-admission",
    section: "billing",
    title: "assertGauAvailable (governed-action admission)",
    claim:
      "The kernel's billing admission gate reads only: it never inserts and never calls Stripe, so a Stripe outage cannot make it fail open.",
    perRow: 4,
    steps: [
      {
        label: "Suspended?",
        sub: "dunning state",
        exit: "BillingSuspendedError",
      },
      { label: "Invoice billing?", sub: "admit" },
      { label: "Remaining > 0?", sub: "readBucket → admit" },
      {
        label: "Refuse",
        sub: "bucket exhausted",
        accent: true,
        exit: "GauExhaustedError",
      },
    ],
    refs: [
      "packages/billing/src/gau-bucket.ts#assertGauAvailable",
      "packages/billing/src/gau-bucket.ts#GauExhaustedError",
      "packages/billing/src/spend-budget-gate.ts#assertWithinSpendBudget",
    ],
    notes: [
      "A Free-tier org with no saved card is refused with the reason <code>free_no_payment_method</code>.",
      "The spend-budget gate runs right after it in <code>kernel.invoke()</code>, on the same skip conditions. It checks the org and workspace ceilings in <code>billing.spend_budgets</code> against <code>billing.spend_counters</code>. A breach throws <code>budget_exceeded</code>, and a database error fails open.",
    ],
  },
  {
    kind: "chain",
    id: "turn-admission",
    section: "billing",
    title: "assertCanStartTurn (platform-funded assistant turns)",
    claim:
      "The credit gate in front of a platform-funded assistant turn. Its auto-reload may charge the card, a failed reload falls through to the balance check, and any error other than the three billing refusals fails open.",
    perRow: 4,
    steps: [
      {
        label: "Suspended?",
        sub: "dunningState === 'suspended'",
        exit: "BillingSuspendedError",
      },
      {
        label: "Auto-reload",
        sub: "may charge the card",
      },
      {
        label: "Balance > 0?",
        sub: "effectiveBalance",
        exit: "InsufficientCreditsError",
      },
      {
        label: "Assistant cap",
        sub: "ADR-053 §3",
        exit: "AssistantSpendCapError",
      },
    ],
    refs: [
      "packages/billing/src/metering.ts#assertCanStartTurn",
      "packages/billing/src/turn-credit-gate.ts#evaluateTurnCreditGate",
      "packages/billing/src/autoreload.ts#maybeAutoReload",
    ],
    notes: [
      "Auto-reload runs when it is enabled, the balance is below the threshold, and no reload completed in the last hour. It charges the saved card off-session, and a failure is logged.",
      "<code>evaluateTurnCreditGate</code> calls it for the in-app assistant and for run enrichment. A refusal becomes <code>AssistantTurnRefusedError</code>, which the API maps to 402.",
    ],
  },

  // ───────────────────────────── Knowledge ─────────────────────────────
  {
    kind: "chain",
    id: "ingestion",
    section: "knowledge",
    title: "ingestion/entity.received → EntityNode",
    claim:
      "Six steps, each retried up to three times. The poller advances the Postgres cursor once the fan-out is sent, not after the graph write, so a node write that exhausts its retries is not replayed. Embedding failures never fail the run, so the node still lands.",
    perRow: 3,
    steps: [
      {
        label: "normalize-and-map",
        sub: "entity_type_mappings × delivery_config",
        exit: "skipped · filtered",
      },
      { label: "dedup-pass-a", sub: "exact naturalKey MATCH" },
      {
        label: "dedup-pass-b",
        sub: "vector match → ALIAS_OF",
        exit: "similarityDeferred",
      },
      {
        label: "upsert-node",
        sub: "MERGE :EntityNode via scopedSession",
        accent: true,
      },
      {
        label: "embed",
        sub: "1024-d Voyage vector",
        exit: "recorded, not fatal",
      },
      {
        label: "schedule-change-event",
        sub: "entity.created | updated",
      },
    ],
    refs: [
      "packages/inngest-functions/src/functions/ingestion.pipeline.ts#schedule-change-event",
      "packages/inngest-functions/src/functions/ingestion.connection-poll.ts",
      "packages/ingestion/src/dedup/resolve.ts#entity_node_embedding_index",
      "packages/ingestion/src/dedup/resolve.ts#similarityDeferred",
      "packages/ingestion/src/mutations/upsert-entity.ts",
      "packages/ingestion/src/pipeline.ts",
      "packages/ontology/src/tenant.ts#scopedSession",
      "packages/ontology/src/schema.cypher",
    ],
    notes: [
      "Concurrency is capped at 5 per organisation (<code>concurrency: { key: event.data.orgId }</code>).",
      "Pass B queries <code>entity_node_embedding_index</code> and writes an <code>ALIAS_OF</code> edge on a match. When the embedding backend is down, the entity becomes its own principal flagged <code>similarityDeferred</code>. The embed step runs only when semantic inference is on for the record type.",
      "A node with no vector is the backfill set: <code>MATCH (n:EntityNode) WHERE n.embedding IS NULL</code>.",
      "Every tenant node also carries the anchor label <code>GraphNode</code>; it exists to back indexes because Neo4j cannot parameterise labels. Relationship types are tenant data in <code>schema_registry.relationship_types</code>, not a static enum.",
    ],
  },

  // ───────────────────────────── Deployment ─────────────────────────────
  {
    kind: "grid",
    id: "prod-topology",
    section: "deploy",
    title: "Production topology (AWS account 916294258235)",
    claim:
      "The ALB is the only public entry to the node. One ARM node runs Caddy, four Node services, the stella-serve engine, two static sites, Neo4j and ClickHouse. Postgres is Aurora Serverless v2, reachable only from the node's security group.",
    cellW: 156,
    cellH: 50,
    nodes: [
      { id: "internet", label: "Internet", col: 0, row: 1, kind: "actor" },
      { id: "r53", label: "Route 53", sub: "oxagen.sh zone", col: 1, row: 1 },
      {
        id: "cf",
        label: "CloudFront + S3",
        sub: "oxagen.sh · www · downloads",
        col: 2,
        row: 0,
      },
      {
        id: "alb",
        label: "ALB",
        sub: "ACM TLS · :443 → node",
        col: 2,
        row: 2,
        accent: true,
      },
      {
        id: "caddy",
        label: "Caddy :80",
        sub: "host-based routing",
        col: 3,
        row: 2,
      },
      { id: "app", label: "app", sub: ":3000", col: 4, row: 0 },
      { id: "api", label: "api", sub: ":4000", col: 4, row: 1 },
      { id: "mcp", label: "mcp", sub: ":4100", col: 4, row: 2 },
      { id: "docs", label: "docs", sub: ":3002", col: 4, row: 3 },
      {
        id: "sites",
        label: "static sites",
        sub: "stella :3001 · internal :3003",
        col: 4,
        row: 4,
      },
      {
        id: "containers",
        label: "service containers",
        sub: "one per service",
        col: 3,
        row: 4,
      },
      {
        id: "stella",
        label: "stella-serve",
        sub: "Rust engine · 127.0.0.1:4300",
        col: 5,
        row: 0,
        kind: "external",
      },
      {
        id: "neo4j",
        label: "Neo4j",
        sub: "docker · EBS · SSM port-forward",
        col: 5,
        row: 2,
        kind: "store",
      },
      {
        id: "ch",
        label: "ClickHouse",
        sub: "docker · EBS",
        col: 5,
        row: 3,
        kind: "store",
      },
      {
        id: "aurora",
        label: "Aurora PostgreSQL",
        sub: "Serverless v2 · :5432 from node SG",
        col: 6,
        row: 1,
        kind: "store",
      },
      {
        id: "ssm",
        label: "SSM Parameter Store",
        sub: "/oxagen/production/*",
        col: 2,
        row: 4,
      },
      {
        id: "gha",
        label: "GitHub Actions",
        sub: "OIDC role gha-deploy-oxagen-platform",
        col: 1,
        row: 5,
        kind: "external",
      },
      {
        id: "s3d",
        label: "S3 deploy bucket",
        sub: "oxagen-deploy-916294258235",
        col: 2,
        row: 5,
      },
      {
        id: "runcmd",
        label: "SSM Run Command",
        sub: "oxagen-deploy-service",
        col: 3,
        row: 5,
      },
    ],
    edges: [
      { from: "internet", to: "r53", label: "DNS" },
      { from: "r53", to: "cf", label: "oxagen.sh · www · downloads" },
      {
        from: "r53",
        to: "alb",
        label: "app · api · mcp · docs · stella · internal",
      },
      { from: "alb", to: "caddy", label: "HTTP" },
      { from: "caddy", to: "app", label: "app.oxagen.sh" },
      { from: "caddy", to: "api", label: "api.oxagen.sh" },
      { from: "caddy", to: "mcp", label: "mcp.oxagen.sh" },
      { from: "caddy", to: "docs", label: "docs.oxagen.sh" },
      { from: "caddy", to: "sites", label: "stella · internal" },
      {
        from: "app",
        to: "stella",
        label: "loopback",
        style: { dashed: true },
      },
      {
        from: "api",
        to: "stella",
        label: "loopback",
        style: { dashed: true },
      },
      { from: "api", to: "neo4j", label: "bolt" },
      { from: "api", to: "ch", label: "http :8123" },
      { from: "api", to: "aurora", label: "pg :5432", style: { thin: true } },
      { from: "gha", to: "s3d", label: "package-for-node · upload" },
      { from: "s3d", to: "runcmd", label: "ship-to-node" },
      {
        from: "runcmd",
        to: "containers",
        label: "restart one service",
        route: "v",
      },
      {
        from: "ssm",
        to: "containers",
        label: "config at start",
        style: { dashed: true },
      },
    ],
    groups: [
      {
        label: "app node · t4g.large arm64 · private subnet · no SSH",
        col: 3,
        row: 0,
        colspan: 3,
        rowspan: 5,
      },
    ],
    refs: [
      "infra/stacks-new/oxagen/main.tf",
      "infra/stacks-new/oxagen/data-services.tf#aws_rds_cluster",
      "infra/stacks-new/oxagen/downloads.tf",
      "infra/stacks-new/oxagen/observability.tf#?ERROR ?WARN ?FATAL ?CRITICAL",
      "infra/stacks-new/oxagen/crypto.tf#alias/oxagen-app/ingestion",
      "infra/modules/app-node/main.tf",
      "infra/modules/network/main.tf",
      "infra/modules/static-site/main.tf",
      "infra/tools/caddy/Caddyfile.alb#internal.oxagen.sh",
      "infra/stacks-new/ci-deploy/infra-apply.tf",
      "infra/stacks-new/ci-deploy/ssm.tf#oxagen-deploy-service",
      ".github/actions/ship-to-node/action.yml",
      ".github/workflows/pipeline.yml#migration-gate:",
      "infra/tools/apply-postgres-migrations.sh",
      "infra/tools/check-store-drift.sh",
      "tools/scripts/package-for-node.sh#127.0.0.1:4300",
      "tools/scripts/build-env.ts",
    ],
    notes: [
      "For the node's hostnames only the ALB terminates TLS (ACM, DNS-validated). CloudFront terminates it for <code>oxagen.sh</code>, <code>www.oxagen.sh</code> and <code>downloads.oxagen.sh</code>. The node has no public IP and no SSH key. Administration is SSM Session Manager, and Neo4j and ClickHouse bind to 127.0.0.1 only.",
      "<code>deploy-node</code> runs one service at a time on an ARM runner, after checks, test, staging and <code>migration-gate</code> pass. <code>stella-serve</code> is first in the matrix so it is up before app and api, which call it. A commit that is no longer the tip of <code>main</code> skips every publish step and stays green.",
      "On every push to <code>main</code>, <code>migration-gate</code> applies pending migrations before <code>deploy-node</code> ships. Postgres goes through <code>infra/tools/apply-postgres-migrations.sh</code>, which runs Atlas on the node over SSM. ClickHouse and Neo4j go through <code>tools/scripts/db-migrate.ts</code> when <code>check-store-drift.sh</code> finds them behind. The deploy proceeds only when every store then reads current. A store that is behind or unreadable blocks it. <code>deploy-web</code> does not wait on the gate. The manual DB Migrate and Store Migrate workflows cover the cases the gate refuses.",
      "Every service log group is archived unfiltered through Kinesis Firehose to S3. Lines matching ERROR, WARN, FATAL, CRITICAL, incident or outage reach an EventBridge bus through a Lambda publisher. The ingestion KMS key (<code>alias/oxagen-app/ingestion</code>) wraps stored connector credentials and OAuth tokens.",
    ],
  },
];

export function verifyRefs(
  root: string,
  readFile: (p: string) => string | null,
): string[] {
  const problems: string[] = [];
  for (const f of flows) {
    for (const ref of f.refs) {
      const [path, symbol] = ref.split("#");
      const src = readFile(`${root}/${path}`);
      if (src === null) problems.push(`${f.id}: missing file ${path}`);
      else if (symbol && !src.includes(symbol))
        problems.push(`${f.id}: symbol ${symbol} not found in ${path}`);
    }
  }
  return problems;
}
