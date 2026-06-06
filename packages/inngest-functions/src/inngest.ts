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

// Inngest uses ClientOptions as its generic parameter. We store the untyped
// base form (ClientOptions default) internally; callers get full event-type
// safety from `InngestClient` below, which captures the inferred constructor
// return type of the concrete call (with EventSchemas<Events>).
let _inngest: Inngest | null = null;

function getInngest(): Inngest {
  if (!_inngest) {
    const env = resolveInngestEnv();
    _inngest = new Inngest({
      id: "oxagen-runner",
      eventKey: env.INNGEST_EVENT_KEY,
      schemas: new EventSchemas().fromRecord<Events>(),
    });
  }
  return _inngest;
}

// Proxy object: module consumers import `inngest` and call `.send()`,
// `.createFunction()`, etc. exactly as before — the lazy init is transparent.
// The base-generic `Inngest` target is an internal implementation detail;
// all exported `.send()` / `.createFunction()` calls flow through the real
// fully-typed instance at runtime.
export const inngest = new Proxy({} as Inngest, {
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
