import { Inngest, EventSchemas } from "inngest";
import { requireEnv, normalizeEnv } from "@oxagen/config/env";
import { z } from "zod";

// Inngest event registry: the intended catalogue of every event the runner
// sends or triggers on.
//
// NOTE — this record is documentation, not a gate. `getInngest()` casts the
// constructed client to `ConcreteInngestClient` (see below), which drops the
// `EventSchemas` generic, so nothing type-checks a `.send()` against this map
// and an unlisted event still works at runtime. Keep it complete anyway: it is
// the only place the full event surface is written down, and restoring real
// inference is a one-line type change away.
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
  // The pipeline (normalize → map → dedup → embed) runs next.
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

  // One due connection to poll, fanned out by ingestion-poll-scheduler and
  // consumed by ingestion-connection-poll. The scheduler's `next_poll_at` lease
  // plus the consumer's per-connection concurrency key make a duplicate
  // delivery a no-op rather than a double poll.
  "ingestion/connection.poll": {
    data: {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      connectorId: string;
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

  // ── GitHub provider metadata ingestion ─────────────────────────────────────

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

  // ── Evals ─────────────────────────────────────────────────────────────────
  // Fired by the eval.run.start handler after the eval_runs row is inserted.
  // eval.run.execute runs every dataset item through the target + judge.
  "eval/run.start": {
    data: {
      orgId: string;
      workspaceId: string;
      /** Internal UUID of the eval.eval_runs row. */
      runId: string;
      /** Public ID (evr_…) — the id carried on every ClickHouse item result. */
      runPublicId: string;
      /** Internal UUID of the dataset whose items are evaluated. */
      datasetId: string;
      /** Caller-supplied cap, further clamped by the run's own itemCount. */
      maxItems: number | null;
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

// Concrete Inngest client type, used to give getInngest() and the Proxy a
// stable non-generic shape.
//
// Trade-off to know about: `InstanceType<typeof Inngest>` instantiates the
// class's DEFAULT schema generic, so the `EventSchemas().fromRecord<Events>()`
// binding made at construction is erased by the `as ConcreteInngestClient` cast
// below. `.send()` and `createFunction()` therefore accept any event name, and
// call sites that want to keep TypeScript quiet about the resulting `never`
// parameter write `name: "…" as never`. Narrowing this alias back to the
// event-typed client would restore inference and delete those casts.
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
// It is typed as ConcreteInngestClient, which keeps every call site free of
// `any` (see that alias for what the cast does to event-name inference).
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
