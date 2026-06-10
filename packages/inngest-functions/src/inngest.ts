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
    data: { orgId: string; workspaceId: string; fanoutId: string; depth?: number };
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
  "plugin/registry.sync": {
    data: { registryId: string; mode: "full" | "incremental" };
  };
  "agent/workflow.supervisor.start": {
    data: {
      orgId: string;
      workspaceId: string;
      workflowRunId: string;
      maxParallelism: number;
      maxTasksGuard: number;
    };
  };
  "agent/workflow.task.execute": {
    data: {
      orgId: string;
      workspaceId: string;
      workflowRunId: string;
      taskId: string;
      taskIndex: number;
      goal: string;
      outputFormat: "json" | "csv";
    };
  };
  "agent/workflow.cancel": {
    data: { orgId: string; workflowRunId: string };
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

  // Parse a single file blob fetched from the GitHub tree.
  "ingestion/github.parse-file": {
    data: {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      owner: string;
      repo: string;
      sha: string;
      path: string;
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
  const base = requireEnv(["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY", "NODE_ENV"] as const);
  if (base.NODE_ENV === "production") {
    const prodSchema = z.object({
      INNGEST_EVENT_KEY: z.string().min(1, "INNGEST_EVENT_KEY required when NODE_ENV=production"),
      INNGEST_SIGNING_KEY: z.string().min(1, "INNGEST_SIGNING_KEY required when NODE_ENV=production"),
    });
    const parsed = prodSchema.safeParse(normalizeEnv(process.env));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
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
    const instance = getInngest() as unknown as Record<string | symbol, unknown>;
    return instance[prop];
  },
  set(_target, prop, value) {
    const instance = getInngest() as unknown as Record<string | symbol, unknown>;
    instance[prop] = value;
    return true;
  },
});

export type InngestClient = typeof inngest;
