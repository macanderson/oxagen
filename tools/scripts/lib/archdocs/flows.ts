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
        sub: "browser · CLI · MCP · SDK",
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
        label: "Authorization: Bearer ox_… ?",
        detail: "resolveApiKey → orgId + workspaceId pre-bound from the key",
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
        label: "handler runs inside runInTenantScope",
        detail: "@oxagen/tenancy AsyncLocalStorage",
      },
      {
        from: "tenant",
        to: "pg",
        label: "BEGIN; select set_config(…, true) ×3",
        detail:
          "app.current_org_id · app.current_workspace_id · app.rls_bypass",
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
      "packages/database/atlas/migrations/20260612140000_restore_rls_policies.sql",
    ],
    notes: [
      "An API key wins outright when present: the session cookie is never consulted, and the key's immutable org and workspace scope is copied onto the request, so the slug middlewares return early.",
      "The three GUCs are set with <code>set_config(name, value, true)</code>, which is transaction-local. <code>app.rls_bypass</code> is always written explicitly so a policy never evaluates a missing setting.",
      "<code>withSystemDb</code> is the audited bypass: it sets only <code>app.rls_bypass = 'on'</code>, always on the shared plane, and unscoped calls are counted under the <code>db.query.unscoped</code> metric.",
    ],
  },
  {
    kind: "chain",
    id: "invoke-gates",
    section: "kernel",
    title: "Gate order inside invoke()",
    claim:
      "A refused call never reaches a handler, and both outcomes leave a security event. Only the outermost invoke() accrues a governed action.",
    perRow: 5,
    steps: [
      {
        label: "Lookup",
        sub: "getCapability(name)",
        exit: "unknown_capability → deny",
      },
      {
        label: "Forged binding?",
        sub: "caller-supplied authz",
        exit: "authz_denied",
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
      { label: "Enter tenant scope", sub: "runInTenantScope" },
      {
        label: "IAM",
        sub: "checkIAM → allow | deny | pending_approval",
        accent: true,
        exit: "access_requests row",
      },
      {
        label: "Billing admission",
        sub: "assertCanStartTurn",
        exit: "InsufficientCredits · Suspended",
      },
      {
        label: "Budget admission",
        sub: "assertWithinSpendBudget",
        exit: "budget_exceeded",
      },
      { label: "Entitlement", sub: "plugin-claimed contracts only" },
      { label: "Decision rules", sub: "_decisionRulesGate" },
      { label: "Handler", sub: "resolveHandler → runWithPrincipal" },
      {
        label: "Output valid?",
        sub: "cap.output.safeParse",
        exit: "invalid_output",
      },
      { label: "Audit", sub: "emitSecurityEvent(allow) + trace" },
      {
        label: "Accrue action",
        sub: "usageRecorder (top-level only)",
        accent: true,
      },
    ],
    refs: [
      "packages/oxagen/src/kernel.ts#_invokeCoreInner",
      "packages/oxagen/src/kernel.ts#setBillingAdmissionGate",
      "packages/oxagen/src/kernel.ts#setUsageRecorder",
      "packages/iam/src/check-iam.ts#checkIAM",
      "packages/billing/src/metering.ts#assertCanStartTurn",
      "packages/billing/src/spend-budget-gate.ts#assertWithinSpendBudget",
      "packages/billing/src/bootstrap.ts#bootstrapBillingRuntime",
    ],
    notes: [
      "The billing, budget and usage slots are empty until <code>bootstrapBillingRuntime()</code> fills them once per surface; a surface that forgets to bootstrap runs ungated, which is why the gate is set at boot, not per request.",
      "An IAM <em>throw</em> fails closed regardless of <code>IAM_ENFORCEMENT_ENABLED</code>. An agent-run invocation whose pinned authorization decision is null also fails closed.",
      "Every failure path exits through the catch block before the accrual step, which is how ADR-052's rule that denials are free is enforced structurally rather than by policy.",
    ],
  },
  {
    kind: "chain",
    id: "iam-order",
    section: "kernel",
    title: "checkIAM decision order",
    claim:
      "Agent principals are checked against their pinned ceiling at every plan tier; the tier fast-path applies to humans only and fails closed when the tier cannot be established.",
    perRow: 4,
    steps: [
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
      { label: "fetchAuthz", sub: "grants · roles · policies (withTenantDb)" },
      { label: "resolve()", sub: "pure evaluator, @oxagen/oxagen/iam" },
      { label: "emitAudit", sub: "ClickHouse audit_events, hash-chained" },
    ],
    refs: [
      "packages/iam/src/check-iam.ts#checkIAM",
      "packages/iam/src/emit-audit.ts#AuditEventRow",
      "packages/oxagen/src/iam/index.ts",
      "packages/run-evidence/src/digest.ts#digestJcs",
    ],
    notes: [
      "The audit row stores <code>payload_hash = sha256(raw input)</code>, never the input, and <code>chain_hash = sha256(prev | event_id | capability)</code> per (org, capability) chain. Verification is at range level: two concurrent writes can read the same predecessor.",
      "The audit write is fire-and-forget with three retries; a failed emission is itself captured to the <code>error_events</code> table.",
    ],
  },
  {
    kind: "grid",
    id: "data-planes",
    section: "request",
    title: "Tenant data planes (ADR-042)",
    claim:
      "Every store switches at the organisation: a request resolves the org's binding per store kind and is routed to the shared pool or a dedicated one; degraded and disabled bindings fail closed.",
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
        sub: "cached 5 s · digest in pool key",
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
        sub: "per-org pool, LRU-capped",
        col: 3,
        row: 0,
        kind: "store",
      },
      {
        id: "sharedneo",
        label: "shared Neo4j",
        sub: "",
        col: 2,
        row: 1,
        kind: "store",
      },
      {
        id: "dedneo",
        label: "dedicated Neo4j",
        sub: "per-org driver",
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
        sub: "per-org client",
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
          "one binding per (org, kind) — status: active | degraded | disabled",
        col: 2,
        row: 0,
        colspan: 2,
        rowspan: 3,
      },
    ],
    refs: [
      "packages/tenancy/src/data-plane.ts#resolveDataPlane",
      "packages/database/src/data-plane-resolver.ts",
      "packages/database/src/data-plane-pool.ts#MAX_DEDICATED_POOLS",
    ],
    notes: [
      "The decrypted plane config never leaves the resolver except inside a binding handed to a store client; it is never logged, serialised into an error, or returned by a read capability.",
      "The resolver itself reads <code>org.data_planes</code> through <code>withSystemDb</code> on the shared plane, which is why the system path can never be plane-aware without a cycle.",
    ],
  },

  // ───────────────────────────── Governed turn ─────────────────────────────
  {
    kind: "sequence",
    id: "governed-turn",
    section: "agent",
    title: "The governed turn (in-app agent)",
    claim:
      "Funding is decided before the credit gate, grounding arrives through a metered capability, the model runs on stella-serve over loopback with no fallback, and tools re-enter invoke().",
    lanes: [
      { id: "client", label: "Client", sub: "SSE consumer", kind: "actor" },
      { id: "route", label: "chat.stream", sub: "apps/api route" },
      { id: "billing", label: "@oxagen/billing" },
      { id: "agent", label: "runGovernedTurn", sub: "@oxagen/agent" },
      {
        id: "engine",
        label: "stella-serve",
        sub: "loopback :3001 (prod) · :4300 (dev)",
        kind: "external",
      },
      { id: "ai", label: "@oxagen/ai", sub: "provider port" },
      { id: "kernel", label: "kernel.invoke" },
      PG,
      NEO,
      CH,
    ],
    steps: [
      { from: "client", to: "route", label: "POST /v1/:org/:ws/chat/stream" },
      {
        from: "route",
        to: "ai",
        label: "resolveModelFundingSource(orgId)",
        detail: "BYOK credential or platform key — decided first (ADR-053 §2)",
      },
      {
        from: "route",
        to: "billing",
        label: "evaluateTurnCreditGate({ fundedBy })",
        detail: "402 on refusal",
      },
      {
        from: "route",
        to: "pg",
        label: "history (≤50 messages) · model defaults · budget policy",
      },
      {
        from: "route",
        to: "kernel",
        label: "recallWorkspaceMemoryMessage → invoke('agent.memory.recall')",
        detail: "limit 6 · 2.5 s timeout · fails open",
      },
      {
        from: "kernel",
        to: "neo4j",
        label: "vector recall",
        detail: "graph_node_embedding_index",
      },
      {
        from: "route",
        to: "agent",
        label: "materializeTools + prompt config → runGovernedTurn",
        style: { accent: true },
      },
      {
        from: "agent",
        to: "engine",
        label: "assertEngineReady → driveTurn",
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
        to: "ch",
        label: "token_usage row",
        detail: "priced in full, billed zero unless platform-funded",
      },
      {
        from: "engine",
        to: "kernel",
        label:
          "onToolRequest → tool.execute → invoke(name, …, { surface: 'agent' })",
        detail:
          "approval wait ≤5 min · MCP consent · mutating tools serialised",
      },
      { from: "kernel", to: "ch", label: "tool_invocations row" },
      {
        from: "agent",
        to: "client",
        label: "SSE parts + one usage event",
        detail: "createApiStreamTranslator owns the wire shapes",
      },
      {
        from: "route",
        to: "pg",
        label: "insert user + assistant messages · update conversation leaf",
        detail: "skipped when the stream errored",
      },
      {
        from: "route",
        to: "kernel",
        label:
          "invoke('get_message_execution', { status: 'completed', steps })",
        detail: "the SOC 2 execution record",
      },
    ],
    refs: [
      "apps/api/src/routes/v1/chat.stream.ts#chatStreamRoute",
      "packages/agent/src/runtime/assistant-recall.ts#recallWorkspaceMemoryMessage",
      "apps/api/src/routes/v1/chat-stream-translator.ts#createApiStreamTranslator",
      "packages/ai/src/funding-source.ts#resolveModelFundingSource",
      "packages/billing/src/turn-credit-gate.ts#evaluateTurnCreditGate",
      "packages/agent/src/runtime/governed-turn.ts#runGovernedTurn",
      "packages/agent/src/runtime/materialize-tools.ts#materializeTools",
      "packages/agent/src/runtime/tool-budget.ts#assertToolListFitsProvider",
      "packages/agent/src/runtime/engine/provider.ts#createProviderPort",
      "packages/agent/src/runtime/engine/tools.ts#executeToolRequest",
      "packages/ai/src/index.ts#streamAgentReply",
    ],
    notes: [
      "There is no Inngest persistence hop: messages are written inline by the route inside <code>withTenantDb</code>. The <code>chat.persist-stream</code> function named in older codemaps has no sender and no file.",
      "Role routing inside the provider port: verdict/judge calls use the tier above the worker, summarisation and reflection use <code>fast</code>, everything else the turn's worker model.",
      "Context records (ADR-051) no longer enter the turn; that ADR is superseded by ADR-043. What rides as a volatile user message today is recalled workspace memory.",
    ],
  },

  // ───────────────────────────── Evidence ─────────────────────────────
  {
    kind: "grid",
    id: "ledger-hierarchy",
    section: "evidence",
    title: "The evidence ledger's record chain",
    claim:
      "A run owns immutable attempts; each attempt owns a dense, digest-chained event log; a seal closes the attempt and mints exactly one finalization grant and one obligation in the same transaction.",
    cellW: 170,
    nodes: [
      {
        id: "run",
        label: "agent_runs",
        sub: "arun_… · RunSpecV2 · status",
        col: 0,
        row: 0,
        kind: "store",
      },
      {
        id: "attempt",
        label: "agent_run_attempts",
        sub: "arat_… · engine pinned · immutable",
        col: 1,
        row: 0,
        kind: "store",
      },
      {
        id: "events",
        label: "agent_run_events",
        sub: "attempt_seq dense from 1 · event_digest",
        col: 2,
        row: 0,
        kind: "store",
      },
      {
        id: "seal",
        label: "agent_run_attempt_seals",
        sub: "event_stream_digest · one per attempt",
        col: 2,
        row: 1,
        kind: "store",
        accent: true,
      },
      {
        id: "grant",
        label: "finalization_grants",
        sub: "afg_… = submission_id",
        col: 1,
        row: 1,
        kind: "store",
      },
      {
        id: "obl",
        label: "finalization_obligations",
        sub: "one shot",
        col: 0,
        row: 1,
        kind: "store",
      },
      {
        id: "ingest",
        label: "ingest_run_evidence",
        sub: "RunEvidenceEnvelopeV1 · JCS ≤ 1 MiB",
        col: 1,
        row: 2,
      },
    ],
    edges: [
      { from: "run", to: "attempt", label: "1 : n" },
      { from: "attempt", to: "events", label: "1 : n, append-only" },
      { from: "events", to: "seal", label: "fold → seal", route: "v" },
      { from: "seal", to: "grant", label: "same tx" },
      { from: "grant", to: "obl", label: "same tx" },
      { from: "grant", to: "ingest", label: "consumed once", route: "v" },
      {
        from: "ingest",
        to: "run",
        label: "runStatusForTerminal",
        style: { dashed: true },
      },
    ],
    groups: [
      {
        label: "@oxagen/run-ledger is the only writer of these tables",
        col: 0,
        row: 0,
        colspan: 3,
        rowspan: 2,
      },
    ],
    refs: [
      "packages/run-ledger/src/run-store.ts#ATTEMPT_TERMINAL_STATUSES",
      "packages/run-ledger/src/run-store.ts#runStatusForTerminal",
      "packages/run-ledger/src/finalization-grant.ts#FINALIZATION_GRANT_CAPABILITY",
      "packages/run-ledger/src/event-payload-registry.ts#EVIDENCE_STAGES",
      "packages/run-evidence/src/digest.ts#digestJcs",
      "packages/run-evidence/src/limits.ts#MAX_ENVELOPE_JCS_BYTES",
    ],
    notes: [
      "The stream digest folds only <code>(attempt_seq, schema_version, event_type, payload_digest)</code>, deliberately excluding stage and observed time, so a finalizer can reproduce it from the log alone.",
      "A repeated <code>(attempt_id, attempt_seq)</code> with a different digest is an integrity error: the insert has no <code>ON CONFLICT</code>, the transaction rolls back, and <code>agent_run.event_sequence_conflict</code> is emitted afterwards.",
      "Grants carry no expiry column. The seal binding plus one successful consumption is the limiting authority; <code>(org_id, submission_id)</code> is the finalization idempotency key.",
    ],
  },
  {
    kind: "dag",
    id: "run-states",
    section: "evidence",
    title: "Run and attempt status",
    claim:
      "An attempt is either open or sealed; its terminal status maps onto the run, where denied and abandoned both read as failed because the denial itself is the evidence.",
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
      { from: "pending", to: "running", label: "first attempt opens" },
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
      { from: "a_open", to: "a_abandoned", label: "seal (0 events ok)" },
      { from: "a_completed", to: "completed", label: "runStatusForTerminal" },
      { from: "a_cancelled", to: "cancelled" },
      { from: "a_failed", to: "failed" },
      { from: "a_denied", to: "failed" },
      { from: "a_abandoned", to: "failed" },
    ],
    refs: [
      "packages/run-ledger/src/run-store.ts#ATTEMPT_TERMINAL_STATUSES",
      "packages/run-ledger/src/run-store.ts#runStatusForTerminal",
    ],
    notes: [
      "Run status values: <code>pending · running · completed · failed · cancelled</code>. Attempt terminal statuses: <code>completed · failed · cancelled · denied · abandoned</code>.",
    ],
  },
  {
    kind: "sequence",
    id: "tacho",
    section: "evidence",
    title: "Wrapping: evidencing an agent Oxagen does not run",
    claim:
      "The hook is answered only after the event is chained and durably written on the host; the control plane recomputes every hash on ingest and records a broken chain rather than rejecting the batch.",
    lanes: [
      {
        id: "harness",
        label: "agent harness",
        sub: "Claude Code · Agent SDK · custom",
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
      CH,
      PG,
    ],
    steps: [
      {
        from: "harness",
        to: "tachod",
        label: "hook / OTLP event",
        detail: "PreToolUse · PostToolUse · SessionEnd …",
      },
      {
        from: "tachod",
        to: "tachod",
        label: "normalize → tacho/1.0 · dense seq · hash chain · WAL append",
        detail: "answered only after the WAL write",
        style: { accent: true },
      },
      {
        from: "tachod",
        to: "harness",
        label: "allow | deny | ask | defer",
        detail: "from the cached signed policy bundle (ed25519)",
      },
      {
        from: "tachod",
        to: "api",
        label: "POST /v1/tacho/events (tacho.batch.v1, ≤1 MiB)",
        detail: "pre-auth limits: ip 6000 · credential 120 · post-auth 30/min",
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
        to: "ch",
        label: "tacho_events rows",
        detail:
          "ReplacingMergeTree(received_at) on (org, ws, session_uuid, seq)",
      },
      {
        from: "handler",
        to: "pg",
        label: "upsert tacho_sessions · authorization_decisions",
        detail: "agent.* and iam.* tables",
      },
      {
        from: "handler",
        to: "tachod",
        label: "response: deny_generation · bundle etag · pending commands",
        detail:
          "pause · resume · cancel · message · revoke · refresh_bundle · kill",
      },
      {
        from: "harness",
        to: "tachod",
        label: "SessionEnd → session sealed",
        detail: "→ RunEvidenceEnvelopeV1 → ingest_run_evidence",
      },
    ],
    refs: [
      "packages/tacho/src/envelope.ts#TACHO_ENVELOPE_VERSION",
      "packages/tacho/src/wire.ts#TACHO_BATCH_SCHEMA",
      "packages/handlers/src/tacho.events.ingest.ts",
      "apps/api/src/routes/v1/tacho.events.ingest.ts",
      "apps/api/src/middleware/distributed-rate-limit.ts#distributedRateLimiter",
      "packages/telemetry/src/tacho-events-ddl.ts",
    ],
    notes: [
      "Two enforcement tiers: a denial inside a process Oxagen does not own grades as <code>harness</code> (client-attested); only calls through the governed gateway grade as <code>gateway</code>-enforced.",
      "The ClickHouse DDL for <code>tacho_events</code> is generated from the envelope schema; a test fails when the SQL and the schema disagree.",
    ],
  },

  // ───────────────────────────── Metering → billing ─────────────────────────────
  {
    kind: "sequence",
    id: "metering",
    section: "billing",
    title: "From governed action to GAU bucket debit (ADR-052, ADR-055)",
    claim:
      "Tokens are reported, never billed; the billable unit is the outermost invoke(). The debit to the organisation's month bucket is one upsert committed before anything else, so a failed auto top-up claim leaves the action counted and the request intact.",
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
        sub: "webhooks → grants",
        kind: "external",
      },
    ],
    steps: [
      {
        from: "kernel",
        to: "recorder",
        label: "after output validation",
        detail: "skipped when noBillingGate, nested, or unscoped",
      },
      {
        from: "recorder",
        to: "meter",
        label: "recordGovernedAction({ orgId, actions, capability, runId })",
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
        label: "INSERT … ON CONFLICT DO UPDATE used_gau + actions",
        detail:
          "billing.gau_buckets — lazy create and debit in one statement, row lock",
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
          "claimAutoTopup (prepaid · remaining ≤ 0 · auto top-up on · card saved)",
        detail:
          "billing.gau_settlements — at most one episode, committed before any provider call",
        style: { dashed: true },
      },
      {
        from: "stripe",
        to: "pg",
        label: "invoice.paid → grants",
        detail:
          "stripe_events (append-only) · stripe_event_processing (processed_at)",
        style: { dashed: true },
      },
    ],
    refs: [
      "packages/billing/src/bootstrap.ts#setUsageRecorder",
      "packages/billing/src/action-metering.ts#recordGovernedAction",
      "packages/billing/src/contract-terms.ts#resolveGauEntitlement",
      "packages/billing/src/billing-settings.ts#readOrgBillingSettings",
      "packages/billing/src/gau-bucket.ts#periodFor",
      "packages/billing/src/gau-bucket.ts#ensureCurrentBucket",
      "packages/billing/src/gau-bucket.ts#remainingGau",
      "packages/billing/src/gau-settlements.ts#claimAutoTopup",
      "packages/billing/src/webhooks.ts#processStripeEvent",
      "packages/billing/src/grants.ts#grantPlanCreditsForInvoicePaid",
      "apps/api/src/routes/stripe.ts",
      "packages/inngest-functions/src/functions/billing.dunning-sweep.ts",
    ],
    notes: [
      "Stripe idempotency is three-phase: insert into <code>stripe_events</code> with <code>ON CONFLICT DO NOTHING</code>; treat as duplicate only if a processing row has <code>processed_at</code>; dispatch, then record the outcome. A prior failed attempt re-dispatches, so a provider retry self-heals. It is not exactly-once.",
      "The only billing background job is <code>billing.dunning-sweep</code> (02:00 UTC): grace → suspended past the grace end, then a keyset sweep for low-balance notifications.",
      "The <code>stripe.sync-*</code> events named in older inventories have no sender; the webhook route handles those events inline.",
    ],
  },
  {
    kind: "chain",
    id: "turn-admission",
    section: "billing",
    title: "assertCanStartTurn",
    claim:
      "The billing admission gate reads only, so a Stripe outage cannot make it fail open.",
    perRow: 4,
    steps: [
      {
        label: "Suspended?",
        sub: "dunningState === 'suspended'",
        exit: "BillingSuspendedError",
      },
      { label: "Auto-reload", sub: "if configured and balance is 0" },
      {
        label: "Balance > 0?",
        sub: "effectiveBalance",
        exit: "InsufficientCreditsError",
      },
      {
        label: "Assistant cap",
        sub: "platform-funded turns only (ADR-053 §3)",
        exit: "AssistantSpendCapError",
      },
    ],
    refs: [
      "packages/billing/src/metering.ts#assertCanStartTurn",
      "packages/billing/src/spend-budget-gate.ts#assertWithinSpendBudget",
    ],
    notes: [
      "The spend-budget gate runs after it with org and workspace ceilings from <code>billing.spend_budgets</code>; a breach surfaces as <code>budget_exceeded</code>.",
    ],
  },

  // ───────────────────────────── Knowledge ─────────────────────────────
  {
    kind: "chain",
    id: "ingestion",
    section: "knowledge",
    title: "ingestion/entity.received → EntityNode",
    claim:
      "Six individually retried steps; the Postgres cursor is the source of truth and Neo4j is a lossy-okay index, so a failed graph write is retried rather than skipped (ADR-012).",
    perRow: 3,
    steps: [
      {
        label: "normalize-and-map",
        sub: "entity_type_mappings × delivery_config",
        exit: "skipped · filtered",
      },
      { label: "dedup pass A", sub: "exact naturalKey MATCH" },
      { label: "dedup pass B", sub: "embedding similarity (stub today)" },
      {
        label: "upsert-node",
        sub: "MERGE :EntityNode via scopedSession",
        accent: true,
      },
      {
        label: "embed",
        sub: "1536-d vector on the node",
        exit: "recorded, not fatal",
      },
      { label: "schedule-event", sub: "entity.created | entity.updated" },
    ],
    refs: [
      "packages/inngest-functions/src/functions/ingestion.pipeline.ts",
      "packages/ingestion/src/dedup/resolve.ts",
      "packages/ingestion/src/mutations/upsert-entity.ts",
      "packages/ingestion/src/pipeline.ts",
      "packages/ontology/src/tenant.ts#scopedSession",
      "packages/ontology/src/schema.cypher",
    ],
    notes: [
      "Concurrency is capped at 5 per organisation (<code>concurrency: { key: event.data.orgId }</code>).",
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
      "The ALB is the only thing on the internet; one ARM node runs Caddy, the five Node services and the two self-hosted stores; Postgres is Aurora Serverless v2 reachable only from the node's security group.",
    cellW: 156,
    cellH: 50,
    nodes: [
      { id: "internet", label: "Internet", col: 0, row: 1, kind: "actor" },
      { id: "r53", label: "Route 53", sub: "oxagen.sh zone", col: 1, row: 1 },
      {
        id: "cf",
        label: "CloudFront + S3",
        sub: "oxagen.sh · www",
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
        id: "stella",
        label: "stella-serve",
        sub: "loopback only",
        col: 4,
        row: 4,
        kind: "external",
      },
      {
        id: "neo4j",
        label: "Neo4j",
        sub: "docker · EBS · SSM port-forward",
        col: 5,
        row: 1,
        kind: "store",
      },
      {
        id: "ch",
        label: "ClickHouse",
        sub: "docker · EBS",
        col: 5,
        row: 2,
        kind: "store",
      },
      {
        id: "aurora",
        label: "Aurora PostgreSQL",
        sub: "Serverless v2 · :5432 from node SG",
        col: 6,
        row: 0,
        kind: "store",
      },
      {
        id: "ssm",
        label: "SSM Parameter Store",
        sub: "/oxagen/production/*",
        col: 3,
        row: 4,
      },
      {
        id: "gha",
        label: "GitHub Actions",
        sub: "OIDC role gha-deploy-oxagen-platform",
        col: 1,
        row: 4,
        kind: "external",
      },
      {
        id: "s3d",
        label: "S3 deploy bucket",
        sub: "+ SSM Run Command",
        col: 2,
        row: 4,
      },
    ],
    edges: [
      { from: "internet", to: "r53", label: "DNS" },
      { from: "r53", to: "cf", label: "oxagen.sh" },
      { from: "r53", to: "alb", label: "docs · app · api · mcp · stella" },
      { from: "alb", to: "caddy", label: "HTTP" },
      { from: "caddy", to: "app", label: "app.oxagen.sh" },
      { from: "caddy", to: "api", label: "api.oxagen.sh" },
      { from: "caddy", to: "mcp", label: "mcp.oxagen.sh" },
      { from: "caddy", to: "docs", label: "docs.oxagen.sh" },
      {
        from: "api",
        to: "stella",
        label: "reverse RPC",
        style: { dashed: true },
        route: "v",
      },
      { from: "api", to: "neo4j", label: "bolt" },
      { from: "api", to: "ch", label: "http :8123" },
      { from: "api", to: "aurora", label: "pg :5432", style: { thin: true } },
      { from: "gha", to: "s3d", label: "package-for-node" },
      { from: "s3d", to: "ssm", label: "oxagen-deploy-service" },
      {
        from: "ssm",
        to: "caddy",
        label: "restart",
        style: { dashed: true },
        route: "v",
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
      "infra/modules/app-node/main.tf",
      "infra/modules/network/main.tf",
      "infra/modules/static-site/main.tf",
      "infra/tools/caddy/Caddyfile.alb",
      "infra/stacks-new/ci-deploy/infra-apply.tf",
      ".github/actions/ship-to-node/action.yml",
      "tools/scripts/package-for-node.sh",
      "tools/scripts/build-env.ts",
    ],
    notes: [
      "Only the ALB terminates TLS (ACM, DNS-validated). The node has no public IP and no SSH key; administration is SSM Session Manager, and Neo4j's ports never leave loopback.",
      "The deploy job runs one service at a time on an ARM runner; <code>stella-serve</code> is first in the matrix so it is up before the services that call it. A commit that is no longer the tip of <code>main</code> refuses to ship.",
      "Nothing migrates production automatically. Postgres migrations run from the node over SSM (<code>infra/tools/run-db-migrations.sh</code>); ClickHouse and Neo4j through the manual <code>store-migrate</code> workflow.",
      "Logs go CloudWatch → Kinesis Firehose → S3 archive; high-severity log lines fan into an EventBridge bus through a Lambda publisher. The ingestion KMS key wraps connector credentials.",
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
