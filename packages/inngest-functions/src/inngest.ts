import { Inngest, EventSchemas } from "inngest";
import { requireEnv, normalizeEnv } from "@oxagen/config/env";
import { z } from "zod";

// Inngest event registry. Adding an event here is the only way it becomes
// callable from inside the runner — typed at the boundary, never inferred.
type Events = {
  "stripe/subscription.updated": { data: { stripeSubscriptionId: string } };
  "stripe/invoice.updated": { data: { stripeInvoiceId: string } };
  "chat/message.streamed": {
    data: {
      orgId: string;
      workspaceId: string;
      conversationId: string;
      assistantMessageId: string;
      content: string;
      tokenUsage: {
        model: string;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        costMicros: number;
        /** AI provider — "anthropic" | "openai" | "" (OXA-1498). */
        provider?: "" | "anthropic" | "openai";
        /** Wall-clock duration of the LLM call in ms (OXA-1498). */
        durationMs?: number;
        /** SHA-256 first-16-bytes hex of the rendered prompt (OXA-1498). */
        promptHash?: string;
        /** Originating surface of the turn — "app" | "api" | "mcp" (OXA-1498). Defaults to "app". */
        surface?: "app" | "api" | "mcp";
      } | null;
    };
  };
  "agent/subagent.dispatch": {
    data: {
      orgId: string;
      workspaceId: string;
      fanoutId: string;
      depth?: number;
    };
  };
  "agent/subagent.fanout.completed": {
    data: {
      orgId: string;
      workspaceId: string;
      fanoutId: string;
      status: "completed" | "partial" | "failed";
      completedChildren: number;
      totalChildren: number;
    };
  };
  "agent/subagent.aggregate.requested": {
    data: {
      orgId: string;
      workspaceId: string;
      fanoutId: string;
      timeoutMs?: number;
    };
  };
  "agent/subagent.aggregated": {
    data: {
      orgId: string;
      workspaceId: string;
      fanoutId: string;
      status:
        | "pending"
        | "running"
        | "completed"
        | "partial"
        | "failed"
        | "timed_out";
      totalChildren: number;
      completedChildren: number;
    };
  };
  "agent/task.background.start": {
    data: {
      orgId: string;
      workspaceId: string;
      taskId: string;
      kind: string;
      payload: unknown;
    };
  };
  "agent/task.background.cancel": {
    data: { orgId: string; taskId: string };
  };
  "agent/video.render": {
    data: {
      /** The `generated_assets.id` UUID row to update on completion/failure. */
      assetId: string;
      orgId: string;
      workspaceId: string;
      userId: string;
      prompt: string;
      /**
       * Explicit gateway model id (e.g. "google/veo-3.0-fast-generate-001").
       * Takes precedence over `mediaTier` if non-empty.
       */
      model: string;
      /** White-labeled tier fallback when `model` is not provided. */
      mediaTier: "basic" | "advanced";
      /** Duration hint in seconds forwarded to the video model. */
      durationSeconds?: number;
      /** Aspect ratio in `{width}:{height}` format. */
      aspectRatio?: string;
    };
  };
  "agent/workflow.supervisor.start": {
    data: {
      orgId: string;
      workspaceId: string;
      executionId: string;
      maxParallelism: number;
      maxTasksGuard: number;
    };
  };
  "agent/workflow.task.execute": {
    data: {
      orgId: string;
      workspaceId: string;
      executionId: string;
      stepId: string;
      taskIndex: number;
      goal: string;
      outputFormat: "json" | "csv";
    };
  };
  "agent/workflow.cancel": {
    data: { orgId: string; executionId: string };
  };
  "privacy/export.process": {
    data: {
      exportId: string;
      userId: string;
      orgId: string;
      scope: "user" | "org";
    };
  };
  "privacy/erasure.execute": {
    data: {
      requestId: string;
      userId: string;
      orgId: string;
      scope: "user" | "org";
      scheduledAt: string;
    };
  };
  // ── Ingestion pipeline ─────────────────────────────────────────────────────

  // Stage 1: raw record arrives from a connector (webhook or poller).
  // The 6-stage pipeline (normalize → map → dedup → embed → infer) runs next.
  "ingestion/entity.received": {
    data: {
      connectionId: string;
      workspaceId: string;
      orgId: string;
      connectorType: string;
      sourceRecordType: string;
      idempotencyKey: string;
      payload: unknown;
      receivedAt: string; // ISO-8601
    };
  };

  // Stage 4.5: fired after a node is successfully upserted in Neo4j.
  // Downstream consumers (e.g. playbook trigger matcher) subscribe to this
  // event to react to new or updated entity nodes without coupling to the
  // pipeline internals. The properties snapshot is the post-mapping set —
  // the same view that will land on the Neo4j node.
  "ingestion/entity.created": {
    data: {
      nodeId: string;
      entityType: string;
      propertiesSnapshot: Record<string, unknown>;
      workspaceId: string;
      orgId: string;
      /** naturalKey of the upserted node — stable idempotency handle. */
      naturalKey: string;
      /** Whether this was a first-time create or an update to an existing node. */
      isNew: boolean;
    };
  };

  // Fired instead of entity.created when the upsert UPDATED an existing node
  // (dedup Pass A hit). Same shape as entity.created plus `previousProperties`
  // — the node's property snapshot BEFORE this write — so node.updated triggers
  // can evaluate previous-aware operators (`changed`, status X→merged).
  // `null` is never expected here (an update always had prior state) but the
  // field is typed nullable to mirror upsertEntityNode's guard.
  "ingestion/entity.updated": {
    data: {
      nodeId: string;
      entityType: string;
      propertiesSnapshot: Record<string, unknown>;
      /** The node's properties BEFORE this write overwrote them. */
      previousProperties?: Record<string, unknown> | null;
      workspaceId: string;
      orgId: string;
      /** naturalKey of the upserted node — stable idempotency handle. */
      naturalKey: string;
      /** Always false for entity.updated (the node already existed). */
      isNew: boolean;
    };
  };

  // Stage 6: async semantic inference after a node has been embedded.
  // LLM worker infers IMPLEMENTS / PART_OF / ASSIGNED_TO / etc. edges.
  "ingestion/entity.infer": {
    data: {
      nodeId: string;
      entityType: string;
      propertiesSnapshot: Record<string, unknown>;
      workspaceId: string;
      orgId: string;
      contextHops?: number;
    };
  };

  // Bulk inference request dispatched by the semantic.edge.infer handler.
  // The worker fans out per-entity infer events for all matched connections.
  "ingestion/semantic.edge.infer.requested": {
    data: {
      jobId: string;
      connectionIds: string[];
      orgId: string;
      workspaceId: string;
      maxEdgesPerNode: number;
      confidenceThreshold: number;
      semanticEdgePrompt: string;
      dryRun: boolean;
      requestedAt: string; // ISO-8601
    };
  };

  // Manual or polling sync request dispatched by the integration.sync handler.
  // The worker resolves the connector type and dispatches the appropriate sync event.
  "ingestion/sync.requested": {
    data: {
      jobId: string;
      connectionId: string;
      orgId: string;
      workspaceId: string;
      integrationId: string;
      mode: "full" | "incremental" | "dry_run";
      syncMethod: "manual" | "polling" | "webhook";
      syncIntervalSeconds: number;
      requestedAt: string; // ISO-8601
    };
  };

  // Async deletion job: remove a connection and optionally its ingested graph data.
  "ingestion/connection.delete": {
    data: {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      requestedBy: string; // userId
      mode: "connection_only" | "data_only" | "full";
      requestedAt: string; // ISO-8601
    };
  };

  // Provision (register) the provider webhook subscription for a webhook
  // connection once it is active. Consumed by ingestion-webhook-provision.
  "ingestion/webhook.provision": {
    data: {
      connectionId: string;
      orgId: string;
      workspaceId: string;
    };
  };

  // ── GitHub source-code ingestion ───────────────────────────────────────────

  // Kick off the initial sync for a newly-connected GitHub repository.
  "ingestion/github.initial-sync": {
    data: {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      owner: string;
      repo: string;
      defaultBranch: string;
    };
  };

  // Parse a single file blob fetched from the GitHub tree at a PINNED canonical
  // snapshot. The projection-binding fields (workspace-graph-boundary spec) tie
  // each file to its immutable snapshot + projection generation + code scope so
  // parse-file can attribute the projection and emit generation-file-done.
  "ingestion/github.parse-file": {
    data: {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      owner: string;
      repo: string;
      // Blob SHA of the file content to fetch (unchanged name).
      sha: string;
      path: string;
      // ── Canonical-snapshot projection binding ──────────────────────────────
      /** ingestion.code_repositories row this file's repository projects to. */
      repositoryId: string;
      /** ingestion.projection_generations row this parse belongs to. */
      generationId: string;
      /** Immutable commit SHA of the canonical snapshot being projected. */
      commitSha: string;
      /** Immutable tree SHA of the canonical snapshot being projected. */
      treeSha: string;
      /** Stable code-scope key this file maps to, e.g. "packages/billing". */
      scopeKey: string;
      /** ingestion.code_scopes row for scopeKey within this generation. */
      codeScopeId: string;
    };
  };

  // Emitted by parse-file after each file in a projection generation finishes
  // (or is skipped). generation-file-done atomically advances the generation's
  // files_processed / files_skipped counters and activates the generation once
  // processed + skipped >= files_total (spec §"GitHub projection lifecycle").
  "ingestion/github.generation-file-done": {
    data: {
      orgId: string;
      workspaceId: string;
      generationId: string;
      /**
       * True when parse-file SKIPPED the file (too large, unfetchable, etc.)
       * rather than projecting it — counted into files_skipped instead of
       * files_processed. Either way it advances the completion gate.
       */
      skipped: boolean;
    };
  };

  // A canonical-ref update TRIGGER (spec §"Push to the canonical ref"). Emitted
  // by the GitHub App webhook per resolved connection on a `push`, and by the
  // hourly reconcile cron as a synthetic delivery. The webhook is a trigger, not
  // the source of truth — repository.ref-updated re-fetches the authoritative
  // head from GitHub before staging a projection generation.
  "ingestion/repository.ref-updated": {
    data: {
      orgId: string;
      workspaceId: string;
      connectionId: string;
      /**
       * GitHub App installation id (text), retained for authoritative re-fetch.
       * NULL when the repository was connected via OAuth rather than the App —
       * stageGeneration COALESCEs a null so it never clears a stored id, which
       * an empty-string placeholder WOULD do.
       */
      installationId: string | null;
      /** Provider's immutable repository id (GitHub's numeric repo id as text). */
      providerRepoId: string;
      owner: string;
      repo: string;
      /** The updated ref, e.g. "refs/heads/main". */
      ref: string;
      /** Commit SHA before the push (all-zeros sentinel / null on branch create). */
      beforeSha: string | null;
      /** Commit SHA after the push (all-zeros sentinel / null on branch delete). */
      afterSha: string | null;
      forced: boolean;
      deleted: boolean;
      /**
       * GitHub `X-GitHub-Delivery` GUID, or a synthetic "reconcile:…" id from the
       * reconcile cron. The UNIQUE dedupe key for at-least-once webhook delivery
       * and idempotent hourly reconciles.
       */
      deliveryId: string;
      /** ISO-8601 observation time. */
      observedAt: string;
    };
  };

  // Infer product-level features from parsed source symbols.
  "ingestion/github.infer-features": {
    data: {
      fileNaturalKey: string;
      symbols: Array<{
        name: string;
        kind: string;
        startLine: number;
        endLine: number;
        docComment?: string;
      }>;
      orgId: string;
      workspaceId: string;
      connectionId: string;
    };
  };

  // Batched variant of infer-features: same per-file payload, but consumed via
  // Inngest batchEvents and submitted as one Anthropic Message Batch. Emitted by
  // parse-file instead of infer-features when INGESTION_FEATURE_BATCH=1.
  "ingestion/github.infer-features-batch": {
    data: {
      fileNaturalKey: string;
      symbols: Array<{
        name: string;
        kind: string;
        startLine: number;
        endLine: number;
        docComment?: string;
      }>;
      orgId: string;
      workspaceId: string;
      connectionId: string;
    };
  };

  // Infer application domains from the full repo file-path list and stamp
  // `domain` on SourceFile + SourceSymbol nodes in Neo4j. Triggered once
  // per initial sync (and per incremental re-sync) by the initial-sync function.
  "ingestion/github.infer-domains": {
    data: {
      /** All relative file paths in the repo being analysed. */
      filePaths: string[];
      orgId: string;
      workspaceId: string;
      connectionId: string;
      /** GitHub repo owner (user or org). */
      owner: string;
      /** GitHub repo name. */
      repo: string;
    };
  };

  // ── Playbook execution ─────────────────────────────────────────────────────
  // Fired after a playbook_runs row is inserted (status='pending') by either
  // automation.trigger.ts (manual/api) or playbook.trigger.match.ts (event-driven).
  // The executor picks it up and runs the steps end-to-end.
  "playbook/run.execute": {
    data: {
      runId: string;
      orgId: string;
      workspaceId: string;
    };
  };

  // ── Execution graph sync ────────────────────────────────────────────────────
  // Fired by recordExecution() after a completed execution row is committed to
  // Postgres. The Inngest worker picks this up and mirrors the execution to
  // the Neo4j knowledge graph (async, best-effort, 24 h retry window).
  "agent/execution.sync": {
    data: {
      executionId: string;
      orgId: string;
      workspaceId: string;
      status: string;
      originType: string;
      originId: string;
      agentId?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
      latencyMs?: number | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      estimatedCostUsd?: string | null;
      toolCalls?: Array<{ toolName: string; toolType: string }>;
    };
  };

  // ── File-lock graph projection (ADR-021 §5) ─────────────────────────────────
  // Fired fire-and-forget by the Postgres file-lock lease on acquire/release.
  // agent.project-file-lock-to-graph MERGEs an (:Agent)-[:LOCKED]->(:SourceFile)
  // lineage edge for hot-file analytics + conflict prediction. NEVER
  // load-bearing for mutual exclusion — the lock authority is the Postgres lease.
  "agent/file-lock.projected": {
    data: {
      orgId: string;
      workspaceId: string;
      resourceKey: string;
      holder: string;
      executionId: string;
      action: string;
      event: "acquired" | "released";
      fencingToken?: number;
      expiresAt?: number;
    };
  };

  // ── Generated-file graph sync ───────────────────────────────────────────────
  // Fired by persistGeneratedAsset() after a generated_assets row is committed.
  // content.sync-generated-file-to-graph mirrors the file into Neo4j as a
  // searchable :GeneratedFile node (embedding + lineage to the producing
  // execution) so NL queries like "find the files I made about X" return it.
  "content/generated-asset.sync": {
    data: {
      assetId: string;
      publicId: string;
      orgId: string;
      workspaceId: string;
      kind: string;
      mimeType: string;
      model: string;
      displayName: string;
      prompt?: string | null;
      conversationId?: string | null;
      messageId?: string | null;
      summary?: string | null;
      embedding?: number[] | null;
    };
  };

  // ── Schema reconciliation ─────────────────────────────────────────────────
  // Fired by schema.reconcile.dispatch handler to kick off an async reconcile job.
  // Workers coerce existing KnowledgeNode/relationship properties to the target schema version.
  "schema/reconcile.start": {
    data: {
      orgId: string;
      workspaceId: string;
      /** Internal UUID of the agent_executions row tracking this job. */
      executionId: string;
      /** Public ID (scv_…) of the target schema version. */
      versionId: string;
      /** When true, properties NOT in the target schema are pruned from existing nodes. */
      prune: boolean;
    };
  };
  // ── Web-search → knowledge-graph ingestion ──────────────────────────────────
  // Fired by the web.search handler after every search that returns hits (chat
  // agent, research swarm, API, MCP, CLI — all route through the same handler).
  // web.search.ingest-graph picks this up and feeds the hits to graph.ingest so
  // the entities a search uncovers become workspace knowledge-graph nodes/edges.
  "web/search.completed": {
    data: {
      orgId: string;
      workspaceId: string;
      userId?: string | null;
      query: string;
      results: Array<{ title?: string; url?: string; content?: string }>;
    };
  };

  // ── Engram memory graph sync ────────────────────────────────────────────────
  // Fired by the engram writer after a memory record is appended to the
  // episodic store. The async worker writes :REMEMBERS and :ABOUT edges into
  // Neo4j so the memory is anchored to its related entities in the graph.
  // Eventually consistent: the record in DuckDB/ClickHouse is the source of
  // truth; graph edges are best-effort with 24 h retry.
  "engram/memory.graph-sync": {
    data: {
      /** Content-addressed record ID (sha256 hex). */
      recordId: string;
      orgId: string;
      workspaceId: string;
      /** Graph node reference this memory is about (creates :REMEMBERS edge). */
      nodeRef?: string | null;
      /** KnowledgeNode IDs this memory relates to (creates :ABOUT edges). */
      entityRefs?: string[] | null;
      /** The lesson/fact text for the memory node label. */
      body: string;
      /** Record kind (episodic, semantic, procedural, entity, edge). */
      kind: string;
      /** Salience score 0–1. */
      salience: number;
    };
  };

  // ── Engram embedding pipeline ───────────────────────────────────────────────
  // Fired after a memory record is written. The async worker generates a vector
  // embedding and stores it back on the record for vector retrieval.
  "engram/memory.embed": {
    data: {
      recordId: string;
      orgId: string;
      workspaceId: string;
      kind: string;
      body: string;
    };
  };
};

// OXA-1349: INNGEST keys are optional in the base schema (not every service
// runs Inngest) but must be present in production when this package is loaded.
// Enforce the production requirement here, not in the global envSchema.
//
// The client is lazy-initialized (not at module eval time) so that importing
// this module during Next.js build-time page-data collection — when Inngest
// env vars are not injected — does not crash the build. The keys are validated
// and the Inngest instance is created on first `.send()` / `.createFunction()`
// call (i.e. at actual runtime, not import time).
function resolveInngestEnv() {
  const base = requireEnv([
    "INNGEST_EVENT_KEY",
    "INNGEST_SIGNING_KEY",
    "NODE_ENV",
  ] as const);
  if (base.NODE_ENV === "production") {
    const prodSchema = z.object({
      INNGEST_EVENT_KEY: z
        .string()
        .min(1, "INNGEST_EVENT_KEY required when NODE_ENV=production"),
      INNGEST_SIGNING_KEY: z
        .string()
        .min(1, "INNGEST_SIGNING_KEY required when NODE_ENV=production"),
    });
    const parsed = prodSchema.safeParse(normalizeEnv(process.env));
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid environment:\n${issues}`);
    }
  }
  return base;
}

// Concrete Inngest client type. Using InstanceType<typeof Inngest> avoids a
// callable helper function while still giving getInngest() and the Proxy a
// stable type. Event-name inference flows through the `as ConcreteInngestClient`
// cast in getInngest() and the EventSchemas binding at construction time.
type ConcreteInngestClient = InstanceType<typeof Inngest>;

let _inngest: ConcreteInngestClient | null = null;

function getInngest(): ConcreteInngestClient {
  if (!_inngest) {
    const env = resolveInngestEnv();
    _inngest = new Inngest({
      id: "oxagen-runner",
      eventKey: env.INNGEST_EVENT_KEY,
      schemas: new EventSchemas().fromRecord<Events>(),
    }) as ConcreteInngestClient;
  }
  return _inngest;
}

// Proxy object: module consumers import `inngest` and call `.send()`,
// `.createFunction()`, etc. exactly as before — the lazy init is transparent.
// The Proxy is cast to ConcreteInngestClient so full event-type inference
// flows into all createFunction() handlers without `any`.
export const inngest = new Proxy({} as ConcreteInngestClient, {
  get(_target, prop) {
    const instance = getInngest() as unknown as Record<
      string | symbol,
      unknown
    >;
    return instance[prop];
  },
  set(_target, prop, value) {
    const instance = getInngest() as unknown as Record<
      string | symbol,
      unknown
    >;
    instance[prop] = value;
    return true;
  },
});

export type InngestClient = typeof inngest;
