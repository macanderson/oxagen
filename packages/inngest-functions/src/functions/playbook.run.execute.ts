import { createFunction } from "../create-function";
import { schema, withTenantDb, withSystemDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { generateObjectFor } from "@oxagen/ai";
import { runInTenantScope } from "@oxagen/tenancy";
import { NonRetriableError } from "@oxagen/functions";
import {
  insertEvents,
  insertToolInvocation,
  deterministicEventId,
  type EventRow,
} from "@oxagen/telemetry";
import { invoke } from "@oxagen/oxagen/kernel";
import "@oxagen/oxagen";
import { z } from "zod";
import { createHash } from "crypto";
import { logger } from "../logger";
import {
  evaluatePropertyConditions,
  type PropertyCondition,
} from "./playbook.trigger.match";

// ---------------------------------------------------------------------------
// Step-type config shapes
// ---------------------------------------------------------------------------

interface ToolStepConfig {
  capability: string;
  input?: Record<string, unknown>;
}

interface AgentStepConfig {
  agentSlug?: string;
  prompt?: string;
  instructions?: string;
  model?: string;
}

interface PromptStepConfig {
  prompt: string;
  model?: string;
}

interface ConditionStepConfig {
  propertyConditions?: PropertyCondition[];
  property?: string;
  operator?: "eq" | "gt" | "lt" | "changed";
  value?: string | number;
}

interface WebhookStepConfig {
  url: string;
  headers?: Record<string, string>;
  method?: "POST" | "GET" | "PUT";
}

// ---------------------------------------------------------------------------
// SSRF protection for webhook steps
// ---------------------------------------------------------------------------
// The webhook step performs a server-side fetch to a user-configured URL from
// inside the trusted runner. An https-only check is NOT sufficient: an internal
// target can still serve TLS, and DNS can resolve an attacker domain to a
// private IP (the cloud metadata endpoint 169.254.169.254 included). We reject
// any URL whose host is a private/loopback/link-local/unique-local IP literal or
// a known internal hostname. Mirrors the guard in @oxagen/handlers
// (asset.upload.ts) — copied rather than imported because @oxagen/handlers
// depends on this package, so importing it back would create a dependency cycle.

function isIPv4Literal(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map((s) => {
    const n = Number.parseInt(s, 10);
    return Number.isNaN(n) ? -1 : n;
  });
  if (parts.length !== 4 || parts.some((p) => p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 — unspecified
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 — loopback
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // 169.254.0.0/16 (incl. 169.254.169.254 IMDS)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true; // loopback
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true; // fc00::/7 unique-local
  return false;
}

/**
 * Assert that `raw` is a publicly routable https:// URL safe to fetch from the
 * runner. Throws on non-https schemes, internal hostnames, and private/
 * loopback/link-local/unique-local IP literals.
 */
function assertPublicWebhookUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`webhook step: invalid URL "${raw}"`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `webhook step: only https:// URLs are allowed (got: ${parsed.protocol})`,
    );
  }

  const host = parsed.hostname.toLowerCase();

  const blockedHostnames = new Set(["localhost", "metadata.google.internal"]);
  if (blockedHostnames.has(host)) {
    throw new Error(
      `webhook step: refusing to fetch internal hostname "${host}"`,
    );
  }

  // IPv6 literal (wrapped in brackets in the URL hostname field)
  if (host.startsWith("[")) {
    const ipv6 = host.slice(1, -1);
    if (isPrivateIPv6(ipv6)) {
      throw new Error(
        `webhook step: refusing to fetch non-routable IPv6 address "${ipv6}"`,
      );
    }
    return parsed;
  }

  if (isIPv4Literal(host) && isPrivateIPv4(host)) {
    throw new Error(
      `webhook step: refusing to fetch non-routable IPv4 address "${host}"`,
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// SHA-256 hash chain helpers
// ---------------------------------------------------------------------------
// Schema comment: prevEventHash = 'genesis' for sequence = 1.
// eventHash = SHA-256(prevEventHash || canonical(eventType, eventData, sequence, occurredAt)).

function computeEventHash(
  prevHash: string,
  eventType: string,
  eventData: unknown,
  sequence: number,
  occurredAt: Date,
): string {
  const canonical = JSON.stringify({
    eventType,
    eventData,
    sequence,
    occurredAt: occurredAt.toISOString(),
  });
  return createHash("sha256")
    .update(prevHash + canonical)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// playbook.run.execute — Inngest function
// ---------------------------------------------------------------------------

/**
 * Execute a pending playbook run end-to-end.
 *
 * Triggered by `playbook/run.execute` with { runId, orgId, workspaceId }.
 * Works through the version's steps following edge routing (entry step = no
 * incoming edge; no edges → insertion order by created_at/stepKey).
 *
 * PRODUCT INVARIANT: the executor only runs for already-enabled triggers.
 * It never enables anything. Steps requiring human approval pause the run
 * instead of self-approving.
 */
export const [playbookRunExecute] = createFunction(
  {
    id: "playbook-run-execute",
    retries: 2,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "playbook/run.execute" },
  async ({ event, step }) => {
    const { runId, orgId, workspaceId } = event.data as {
      runId: string;
      orgId: string;
      workspaceId: string;
    };

    // ── Step 1: Load run row ──────────────────────────────────────────────────
    const run = await step.run("load-run", async () => {
      return withSystemDb((tx) =>
        tx.query.playbookRuns.findFirst({
          where: and(
            eq(schema.playbookRuns.id, runId),
            eq(schema.playbookRuns.orgId, orgId),
          ),
          columns: {
            id: true,
            orgId: true,
            workspaceId: true,
            playbookId: true,
            playbookVersionId: true,
            status: true,
            input: true,
            inngestRunId: true,
            startedByUserId: true,
          },
        }),
      );
    });

    if (!run) {
      logger.error({ runId, orgId }, "playbook-run-execute: run not found");
      // Throw so Inngest marks the function run as failed and does NOT retry.
      // A missing playbook_runs row will not appear on retry — this is a
      // permanent failure, not a transient one.
      throw new NonRetriableError(
        `playbook-run-execute: run not found (runId=${runId})`,
        { cause: { runId, orgId } },
      );
    }

    if (run.status !== "pending") {
      logger.warn(
        { runId, status: run.status },
        "playbook-run-execute: run is not pending — skipping",
      );
      return {
        status: "skipped",
        reason: `run already in status: ${run.status}`,
      };
    }

    const runPayload = (run.input ?? {}) as Record<string, unknown>;

    // ── Step 2: Mark running ──────────────────────────────────────────────────
    await step.run("mark-running", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.playbookRuns)
            .set({ status: "running", startedAt: new Date() })
            .where(eq(schema.playbookRuns.id, runId)),
        ),
      ),
    );

    // ── Step 3: Seed event chain — run_started ────────────────────────────────
    // prevEventHash = 'genesis' for sequence 1
    let currentSequence = 1;
    let prevHash = "genesis";

    const firstEventData = {
      runId,
      playbookVersionId: run.playbookVersionId,
      triggeredBy: run.startedByUserId ?? null,
    };
    const firstEventType = "run_started" as const;
    const firstOccurredAt = new Date();
    const firstEventHash = computeEventHash(
      prevHash,
      firstEventType,
      firstEventData,
      currentSequence,
      firstOccurredAt,
    );

    await step.run("emit-run-started", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx.insert(schema.playbookEvents).values({
            orgId,
            workspaceId,
            playbookRunId: runId,
            stepRunId: null,
            sequence: currentSequence,
            eventType: firstEventType,
            eventData: firstEventData,
            prevEventHash: prevHash,
            eventHash: firstEventHash,
            occurredAt: firstOccurredAt,
          }),
        ),
      ),
    );

    prevHash = firstEventHash;
    currentSequence++;

    // ── Step 4: Load steps + edges for this version ───────────────────────────
    type StepRow = {
      id: string;
      stepKey: string;
      name: string;
      stepType: string;
      isAsync: boolean;
      exitOnError: boolean;
      config: Record<string, unknown>;
    };

    type EdgeRow = {
      id: string;
      sourceStepId: string;
      targetStepId: string;
      edgeType: string;
      condition: unknown;
      priority: number;
    };

    const { steps, edges } = await step.run(
      "load-steps-edges",
      async (): Promise<{ steps: StepRow[]; edges: EdgeRow[] }> => {
        const loadedSteps = (await withSystemDb((tx) =>
          tx
            .select({
              id: schema.playbookSteps.id,
              stepKey: schema.playbookSteps.stepKey,
              name: schema.playbookSteps.name,
              stepType: schema.playbookSteps.stepType,
              isAsync: schema.playbookSteps.isAsync,
              exitOnError: schema.playbookSteps.exitOnError,
              config: schema.playbookSteps.config,
            })
            .from(schema.playbookSteps)
            .where(
              eq(schema.playbookSteps.playbookVersionId, run.playbookVersionId),
            )
            .orderBy(schema.playbookSteps.createdAt),
        )) as StepRow[];

        const loadedEdges = (await withSystemDb((tx) =>
          tx
            .select({
              id: schema.playbookEdges.id,
              sourceStepId: schema.playbookEdges.sourceStepId,
              targetStepId: schema.playbookEdges.targetStepId,
              edgeType: schema.playbookEdges.edgeType,
              condition: schema.playbookEdges.condition,
              priority: schema.playbookEdges.priority,
            })
            .from(schema.playbookEdges)
            .where(
              eq(schema.playbookEdges.playbookVersionId, run.playbookVersionId),
            )
            .orderBy(schema.playbookEdges.priority),
        )) as EdgeRow[];

        return { steps: loadedSteps, edges: loadedEdges };
      },
    );

    if (steps.length === 0) {
      // No steps — complete immediately
      await step.run("finalize-empty", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.playbookRuns)
              .set({ status: "completed", completedAt: new Date() })
              .where(eq(schema.playbookRuns.id, runId)),
          ),
        ),
      );
      return { runId, status: "completed", stepsExecuted: 0 };
    }

    // Build adjacency: sourceStepId → target stepId (for 'default' edges only)
    const nextStepByEdge = new Map<string, string>();
    const falseEdgeByStep = new Map<string, string>(); // for condition false-branch
    for (const e of edges) {
      if (e.edgeType === "default") {
        // Lowest priority edge wins if multiple (already ordered by priority asc)
        if (!nextStepByEdge.has(e.sourceStepId)) {
          nextStepByEdge.set(e.sourceStepId, e.targetStepId);
        }
      } else if (e.edgeType === "conditional") {
        // edgeType=conditional from a condition step leads to the false branch
        if (!falseEdgeByStep.has(e.sourceStepId)) {
          falseEdgeByStep.set(e.sourceStepId, e.targetStepId);
        }
      }
    }

    // Find entry step: step with no incoming edge
    const stepsWithIncoming = new Set(edges.map((e) => e.targetStepId));
    const entrySteps = steps.filter((s) => !stepsWithIncoming.has(s.id));
    let currentStep = entrySteps[0] ?? steps[0]; // fallback: first insertion-order step

    if (!currentStep) {
      logger.error(
        { runId, orgId },
        "playbook-run-execute: could not determine entry step",
      );
      await step.run("finalize-no-entry", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.playbookRuns)
              .set({
                status: "failed",
                completedAt: new Date(),
                error: { message: "could not determine entry step" },
              })
              .where(eq(schema.playbookRuns.id, runId)),
          ),
        ),
      );
      return { runId, status: "failed", reason: "no entry step" };
    }

    const stepMap = new Map(steps.map((s) => [s.id, s]));

    // Collect all step outputs for webhook step bodies
    const stepOutputs: Record<string, unknown> = {};

    // ── Step 5: Traverse and execute steps ───────────────────────────────────
    let stepsExecuted = 0;
    const MAX_STEPS = 200; // guard against infinite loops via loop_back edges

    while (currentStep && stepsExecuted < MAX_STEPS) {
      const stepDef = currentStep;
      const stepInvocationId = crypto.randomUUID();
      const stepStartedAt = Date.now();
      let shouldContinue = true;

      // Insert step_run row (started)
      const stepRunId = await step.run(
        `step-run-insert-${stepDef.id}`,
        async () => {
          const [stepRunRow] = await runInTenantScope(
            { orgId, workspaceId },
            () =>
              withTenantDb((tx) =>
                tx
                  .insert(schema.playbookStepRuns)
                  .values({
                    orgId,
                    workspaceId,
                    playbookRunId: runId,
                    playbookStepId: stepDef.id,
                    attempt: 1,
                    status: "running",
                    input: runPayload,
                    startedAt: new Date(),
                  })
                  .returning({ id: schema.playbookStepRuns.id }),
              ),
          );
          if (!stepRunRow?.id) {
            // The DB returned no rows — treat this as a fatal step error so
            // Inngest retries the step rather than silently completing the run.
            throw new Error(
              `playbook-run-execute: step_run insert returned no row for step ${stepDef.id} (playbookRunId=${runId})`,
            );
          }
          return stepRunRow.id;
        },
      );

      // Emit step_started event
      const stepStartedEventType = "step_started" as const;
      const stepStartedEventData = {
        stepId: stepDef.id,
        stepKey: stepDef.stepKey,
        stepType: stepDef.stepType,
        stepRunId,
      };
      const stepStartedOccurredAt = new Date();
      const stepStartedHash = computeEventHash(
        prevHash,
        stepStartedEventType,
        stepStartedEventData,
        currentSequence,
        stepStartedOccurredAt,
      );

      await step.run(`emit-step-started-${stepDef.id}`, () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx.insert(schema.playbookEvents).values({
              orgId,
              workspaceId,
              playbookRunId: runId,
              stepRunId,
              sequence: currentSequence,
              eventType: stepStartedEventType,
              eventData: stepStartedEventData,
              prevEventHash: prevHash,
              eventHash: stepStartedHash,
              occurredAt: stepStartedOccurredAt,
            }),
          ),
        ),
      );

      prevHash = stepStartedHash;
      currentSequence++;

      // ── Execute step by type ───────────────────────────────────────────────
      let stepOutput: unknown = null;
      let stepError: string | null = null;
      let stepStatus: "completed" | "failed" | "waiting_approval" = "completed";

      try {
        switch (stepDef.stepType) {
          case "tool": {
            const cfg = stepDef.config as unknown as ToolStepConfig;
            if (!cfg.capability) {
              throw new Error(
                `tool step "${stepDef.stepKey}": missing config.capability`,
              );
            }

            // Check if the capability contract declares requiresApproval.
            // Import the registry to check agent metadata without invoking.
            const { getCapability } = await import("@oxagen/oxagen/registry");
            const cap = getCapability(cfg.capability);
            if (cap?.agent?.requiresApproval === true) {
              // Autonomous runs cannot self-approve — pause and create approval record
              stepStatus = "waiting_approval";
              stepOutput = null;
              shouldContinue = false;

              // Insert approval row
              await step.run(`approval-insert-${stepDef.id}`, () =>
                runInTenantScope({ orgId, workspaceId }, () =>
                  withTenantDb((tx) =>
                    tx.insert(schema.playbookApprovals).values({
                      orgId,
                      workspaceId,
                      playbookRunId: runId,
                      stepRunId,
                      status: "pending",
                      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
                    }),
                  ),
                ),
              );

              // Emit approval_requested event
              const approvalEventType = "approval_requested" as const;
              const approvalEventData = {
                stepId: stepDef.id,
                stepKey: stepDef.stepKey,
                capability: cfg.capability,
                reason: "requires_approval",
              };
              const approvalOccurredAt = new Date();
              const approvalHash = computeEventHash(
                prevHash,
                approvalEventType,
                approvalEventData,
                currentSequence,
                approvalOccurredAt,
              );

              await step.run(`emit-approval-requested-${stepDef.id}`, () =>
                runInTenantScope({ orgId, workspaceId }, () =>
                  withTenantDb((tx) =>
                    tx.insert(schema.playbookEvents).values({
                      orgId,
                      workspaceId,
                      playbookRunId: runId,
                      stepRunId,
                      sequence: currentSequence,
                      eventType: approvalEventType,
                      eventData: approvalEventData,
                      prevEventHash: prevHash,
                      eventHash: approvalHash,
                      occurredAt: approvalOccurredAt,
                    }),
                  ),
                ),
              );

              prevHash = approvalHash;
              currentSequence++;
              break;
            }

            // Build a runner-surface CapabilityContext. executionStepId names
            // this playbook run as the correlation key (#2597/#2615) — the
            // same runId already carried as messageId, so the per-step
            // tool_invocations row emitted below and any token_usage this
            // capability incurs join on one value.
            const ctx = {
              orgId,
              workspaceId,
              userId: run.startedByUserId ?? null,
              apiKeyId: null,
              requestId: stepInvocationId,
              surface: "runner" as const,
              messageId: runId,
              executionStepId: runId,
            };

            const toolCallEventType = "tool_called" as const;
            const toolCallEventData = {
              stepId: stepDef.id,
              capability: cfg.capability,
            };
            const toolCallOccurredAt = new Date();
            const toolCallHash = computeEventHash(
              prevHash,
              toolCallEventType,
              toolCallEventData,
              currentSequence,
              toolCallOccurredAt,
            );

            await step.run(`emit-tool-called-${stepDef.id}`, () =>
              runInTenantScope({ orgId, workspaceId }, () =>
                withTenantDb((tx) =>
                  tx.insert(schema.playbookEvents).values({
                    orgId,
                    workspaceId,
                    playbookRunId: runId,
                    stepRunId,
                    sequence: currentSequence,
                    eventType: toolCallEventType,
                    eventData: toolCallEventData,
                    prevEventHash: prevHash,
                    eventHash: toolCallHash,
                    occurredAt: toolCallOccurredAt,
                  }),
                ),
              ),
            );

            prevHash = toolCallHash;
            currentSequence++;

            stepOutput = await step.run(`tool-invoke-${stepDef.id}`, () =>
              runInTenantScope({ orgId, workspaceId }, () =>
                invoke(cfg.capability, cfg.input ?? runPayload, ctx),
              ),
            );

            // Emit tool_completed event
            const toolCompleteEventType = "tool_completed" as const;
            const toolCompleteEventData = {
              stepId: stepDef.id,
              capability: cfg.capability,
              status: "completed",
            };
            const toolCompleteOccurredAt = new Date();
            const toolCompleteHash = computeEventHash(
              prevHash,
              toolCompleteEventType,
              toolCompleteEventData,
              currentSequence,
              toolCompleteOccurredAt,
            );

            await step.run(`emit-tool-completed-${stepDef.id}`, () =>
              runInTenantScope({ orgId, workspaceId }, () =>
                withTenantDb((tx) =>
                  tx.insert(schema.playbookEvents).values({
                    orgId,
                    workspaceId,
                    playbookRunId: runId,
                    stepRunId,
                    sequence: currentSequence,
                    eventType: toolCompleteEventType,
                    eventData: toolCompleteEventData,
                    prevEventHash: prevHash,
                    eventHash: toolCompleteHash,
                    occurredAt: toolCompleteOccurredAt,
                  }),
                ),
              ),
            );

            prevHash = toolCompleteHash;
            currentSequence++;
            break;
          }

          case "agent": {
            const cfg = stepDef.config as unknown as AgentStepConfig;
            const prompt =
              cfg.prompt ??
              cfg.instructions ??
              `Execute the agent task for: ${JSON.stringify(runPayload)}`;

            const agentEventType = "agent_invoked" as const;
            const agentEventData = {
              stepId: stepDef.id,
              stepKey: stepDef.stepKey,
              agentSlug: cfg.agentSlug ?? null,
            };
            const agentOccurredAt = new Date();
            const agentHash = computeEventHash(
              prevHash,
              agentEventType,
              agentEventData,
              currentSequence,
              agentOccurredAt,
            );

            await step.run(`emit-agent-invoked-${stepDef.id}`, () =>
              runInTenantScope({ orgId, workspaceId }, () =>
                withTenantDb((tx) =>
                  tx.insert(schema.playbookEvents).values({
                    orgId,
                    workspaceId,
                    playbookRunId: runId,
                    stepRunId,
                    sequence: currentSequence,
                    eventType: agentEventType,
                    eventData: agentEventData,
                    prevEventHash: prevHash,
                    eventHash: agentHash,
                    occurredAt: agentOccurredAt,
                  }),
                ),
              ),
            );

            prevHash = agentHash;
            currentSequence++;

            // Single-shot LLM completion — no hand-rolled agent loop
            const { object: agentResult } = await step.run(
              `agent-run-${stepDef.id}`,
              () =>
                generateObjectFor({
                  schema: z.object({ output: z.string() }),
                  system: `You are an autonomous agent step executor. Execute the given instruction and return your output as a concise text string.`,
                  prompt: `Instruction: ${prompt}\n\nContext payload: ${JSON.stringify(runPayload)}`,
                  telemetry: {
                    orgId,
                    workspaceId,
                    surface: "runner" as const,
                    messageId: stepRunId,
                  },
                }),
            );

            stepOutput = agentResult.output;
            break;
          }

          case "prompt": {
            const cfg = stepDef.config as unknown as PromptStepConfig;
            if (!cfg.prompt) {
              throw new Error(
                `prompt step "${stepDef.stepKey}": missing config.prompt`,
              );
            }

            // Interpolate {{key}} placeholders from the run payload
            const interpolatedPrompt = cfg.prompt.replace(
              /\{\{(\w+)\}\}/g,
              (_match: string, key: string) => {
                const val = runPayload[key];
                return val !== undefined ? String(val) : `{{${key}}}`;
              },
            );

            const { object: promptResult } = await step.run(
              `prompt-run-${stepDef.id}`,
              () =>
                generateObjectFor({
                  schema: z.object({ output: z.string() }),
                  system:
                    "You are an assistant. Respond to the following prompt.",
                  prompt: interpolatedPrompt,
                  telemetry: {
                    orgId,
                    workspaceId,
                    surface: "runner" as const,
                    messageId: stepRunId,
                  },
                }),
            );

            stepOutput = promptResult.output;
            break;
          }

          case "condition": {
            const cfg = stepDef.config as unknown as ConditionStepConfig;
            const conditions: readonly PropertyCondition[] = Array.isArray(
              cfg.propertyConditions,
            )
              ? (cfg.propertyConditions as PropertyCondition[])
              : cfg.property
                ? [
                    {
                      property: cfg.property,
                      operator: cfg.operator ?? "eq",
                      toValue: cfg.value,
                    } as PropertyCondition,
                  ]
                : [];

            const passed = evaluatePropertyConditions(conditions, runPayload);

            const conditionEventType = "condition_evaluated" as const;
            const conditionEventData = {
              stepId: stepDef.id,
              stepKey: stepDef.stepKey,
              passed,
              conditions,
            };
            const conditionOccurredAt = new Date();
            const conditionHash = computeEventHash(
              prevHash,
              conditionEventType,
              conditionEventData,
              currentSequence,
              conditionOccurredAt,
            );

            await step.run(`emit-condition-${stepDef.id}`, () =>
              runInTenantScope({ orgId, workspaceId }, () =>
                withTenantDb((tx) =>
                  tx.insert(schema.playbookEvents).values({
                    orgId,
                    workspaceId,
                    playbookRunId: runId,
                    stepRunId,
                    sequence: currentSequence,
                    eventType: conditionEventType,
                    eventData: conditionEventData,
                    prevEventHash: prevHash,
                    eventHash: conditionHash,
                    occurredAt: conditionOccurredAt,
                  }),
                ),
              ),
            );

            prevHash = conditionHash;
            currentSequence++;
            stepOutput = { passed };

            if (!passed) {
              // Follow false-branch edge if it exists; otherwise stop traversal cleanly
              const falseTargetId = falseEdgeByStep.get(stepDef.id);
              if (falseTargetId) {
                const falseTarget = stepMap.get(falseTargetId);
                // Update step_run to completed (condition evaluated successfully)
                await step.run(`step-run-complete-${stepDef.id}`, () =>
                  runInTenantScope({ orgId, workspaceId }, () =>
                    withTenantDb((tx) =>
                      tx
                        .update(schema.playbookStepRuns)
                        .set({
                          status: "completed",
                          output: stepOutput as Record<string, unknown>,
                          completedAt: new Date(),
                        })
                        .where(eq(schema.playbookStepRuns.id, stepRunId)),
                    ),
                  ),
                );
                stepsExecuted++;
                stepOutputs[stepDef.stepKey] = stepOutput;
                currentStep =
                  falseTarget ?? (null as unknown as typeof currentStep);
                continue;
              } else {
                // No false-branch: run completes here
                await step.run(`step-run-complete-${stepDef.id}`, () =>
                  runInTenantScope({ orgId, workspaceId }, () =>
                    withTenantDb((tx) =>
                      tx
                        .update(schema.playbookStepRuns)
                        .set({
                          status: "completed",
                          output: stepOutput as Record<string, unknown>,
                          completedAt: new Date(),
                        })
                        .where(eq(schema.playbookStepRuns.id, stepRunId)),
                    ),
                  ),
                );
                stepsExecuted++;
                stepOutputs[stepDef.stepKey] = stepOutput;

                // Finalize run as completed (clean stop — condition not met)
                const condStopEventType = "run_completed" as const;
                const condStopEventData = {
                  reason: "condition_not_met",
                  stepKey: stepDef.stepKey,
                };
                const condStopOccurredAt = new Date();
                const condStopHash = computeEventHash(
                  prevHash,
                  condStopEventType,
                  condStopEventData,
                  currentSequence,
                  condStopOccurredAt,
                );

                await step.run(
                  `emit-run-completed-condition-${stepDef.id}`,
                  () =>
                    runInTenantScope({ orgId, workspaceId }, () =>
                      withTenantDb((tx) =>
                        tx.insert(schema.playbookEvents).values({
                          orgId,
                          workspaceId,
                          playbookRunId: runId,
                          stepRunId,
                          sequence: currentSequence,
                          eventType: condStopEventType,
                          eventData: condStopEventData,
                          prevEventHash: prevHash,
                          eventHash: condStopHash,
                          occurredAt: condStopOccurredAt,
                        }),
                      ),
                    ),
                );

                await step.run("finalize-condition-stop", () =>
                  runInTenantScope({ orgId, workspaceId }, () =>
                    withTenantDb((tx) =>
                      tx
                        .update(schema.playbookRuns)
                        .set({ status: "completed", completedAt: new Date() })
                        .where(eq(schema.playbookRuns.id, runId)),
                    ),
                  ),
                );

                return {
                  runId,
                  status: "completed",
                  stepsExecuted,
                  reason: "condition_not_met",
                };
              }
            }
            break;
          }

          case "webhook": {
            const cfg = stepDef.config as unknown as WebhookStepConfig;
            if (!cfg.url) {
              throw new Error(
                `webhook step "${stepDef.stepKey}": missing config.url`,
              );
            }

            // SSRF guard: https-only AND reject internal/private/link-local
            // destinations (incl. the cloud metadata endpoint). Never follow
            // redirects to non-https.
            assertPublicWebhookUrl(cfg.url);

            const webhookBody = JSON.stringify({
              runId,
              payload: runPayload,
              stepOutputs,
            });

            const webhookResult = await step.run(
              `webhook-${stepDef.id}`,
              async () => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10_000);
                try {
                  const resp = await fetch(cfg.url, {
                    method: cfg.method ?? "POST",
                    headers: {
                      "Content-Type": "application/json",
                      ...(cfg.headers ?? {}),
                    },
                    body: webhookBody,
                    redirect: "manual", // never follow redirects automatically
                    signal: controller.signal,
                  });
                  return { statusCode: resp.status, ok: resp.ok };
                } finally {
                  clearTimeout(timeout);
                }
              },
            );

            stepOutput = webhookResult;
            break;
          }

          case "human_input": {
            // Pause the run for human input — do not block the Inngest function
            stepStatus = "waiting_approval";
            shouldContinue = false;

            await step.run(`approval-human-input-${stepDef.id}`, () =>
              runInTenantScope({ orgId, workspaceId }, () =>
                withTenantDb((tx) =>
                  tx.insert(schema.playbookApprovals).values({
                    orgId,
                    workspaceId,
                    playbookRunId: runId,
                    stepRunId,
                    status: "pending",
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                  }),
                ),
              ),
            );

            const humanInputEventType = "approval_requested" as const;
            const humanInputEventData = {
              stepId: stepDef.id,
              stepKey: stepDef.stepKey,
              reason: "human_input_required",
            };
            const humanInputOccurredAt = new Date();
            const humanInputHash = computeEventHash(
              prevHash,
              humanInputEventType,
              humanInputEventData,
              currentSequence,
              humanInputOccurredAt,
            );

            await step.run(`emit-human-input-${stepDef.id}`, () =>
              runInTenantScope({ orgId, workspaceId }, () =>
                withTenantDb((tx) =>
                  tx.insert(schema.playbookEvents).values({
                    orgId,
                    workspaceId,
                    playbookRunId: runId,
                    stepRunId,
                    sequence: currentSequence,
                    eventType: humanInputEventType,
                    eventData: humanInputEventData,
                    prevEventHash: prevHash,
                    eventHash: humanInputHash,
                    occurredAt: humanInputOccurredAt,
                  }),
                ),
              ),
            );

            prevHash = humanInputHash;
            currentSequence++;
            break;
          }

          default: {
            // Unknown step type — treat as non-fatal skip if exitOnError=false
            throw new Error(
              `Unsupported stepType: "${stepDef.stepType}" on step "${stepDef.stepKey}"`,
            );
          }
        }
      } catch (err) {
        stepError = err instanceof Error ? err.message : String(err);
        stepStatus = "failed";
        logger.error(
          { runId, stepId: stepDef.id, stepKey: stepDef.stepKey, err },
          "playbook-run-execute: step failed",
        );
      }

      // ── Update step_run row ──────────────────────────────────────────────────
      await step.run(`step-run-update-${stepDef.id}`, () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.playbookStepRuns)
              .set({
                status: stepStatus,
                output:
                  stepOutput !== null
                    ? (stepOutput as Record<string, unknown>)
                    : undefined,
                error: stepError !== null ? { message: stepError } : undefined,
                completedAt:
                  stepStatus !== "waiting_approval" ? new Date() : undefined,
              })
              .where(eq(schema.playbookStepRuns.id, stepRunId)),
          ),
        ),
      );

      // ── Emit step_completed / step_failed event ────────────────────────────
      const stepTerminalEventType =
        stepStatus === "completed"
          ? ("step_completed" as const)
          : stepStatus === "failed"
            ? ("step_failed" as const)
            : ("run_paused" as const);
      const stepTerminalEventData = {
        stepId: stepDef.id,
        stepKey: stepDef.stepKey,
        status: stepStatus,
        error: stepError,
      };
      const stepTerminalOccurredAt = new Date();
      const stepTerminalHash = computeEventHash(
        prevHash,
        stepTerminalEventType,
        stepTerminalEventData,
        currentSequence,
        stepTerminalOccurredAt,
      );

      await step.run(`emit-step-terminal-${stepDef.id}`, () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx.insert(schema.playbookEvents).values({
              orgId,
              workspaceId,
              playbookRunId: runId,
              stepRunId,
              sequence: currentSequence,
              eventType: stepTerminalEventType,
              eventData: stepTerminalEventData,
              prevEventHash: prevHash,
              eventHash: stepTerminalHash,
              occurredAt: stepTerminalOccurredAt,
            }),
          ),
        ),
      );

      prevHash = stepTerminalHash;
      currentSequence++;

      // ── ClickHouse telemetry per step ───────────────────────────────────────
      // Wrapped in its own memoized step keyed by (runId, stepDef.id) — the
      // per-step loop body above this point runs many step.run calls per
      // iteration, and Inngest replays the whole function from the top to
      // reach each one. Un-stepped code between those replays re-executes on
      // every replay that passes through it, not just on genuine failures —
      // an unwrapped insertEvents()/insertToolInvocation() here duplicated a
      // `playbook_step.executed` event (and a tool_invocations row) on every
      // subsequent step checkpoint in the same iteration. Both `events` and
      // `tool_invocations` are plain append-only MergeTree tables — no
      // background dedup — so those duplicates were permanent. event_id /
      // invocation_id are now derived deterministically from (runId,
      // stepDef.id) instead of crypto.randomUUID() so the row identity is
      // reproducible rather than re-randomized per replay.
      await step.run(`emit-step-telemetry-${stepDef.id}`, async () => {
        const telRow: EventRow = {
          event_id: deterministicEventId(
            runId,
            stepDef.id,
            "playbook_step.executed",
          ),
          org_id: orgId,
          workspace_id: workspaceId,
          event_type: "playbook_step.executed",
          source_system: "runner",
          stream_offset: null,
          payload: JSON.stringify({
            runId,
            stepId: stepDef.id,
            stepKey: stepDef.stepKey,
            stepType: stepDef.stepType,
            status: stepStatus,
            latencyMs: Date.now() - stepStartedAt,
            error: stepError,
          }),
          emitted_at: new Date().toISOString(),
        };

        try {
          await insertEvents([telRow]);
        } catch (telErr) {
          logger.warn(
            { telErr, stepId: stepDef.id },
            "playbook-run-execute: insertEvents failed",
          );
        }

        try {
          await insertToolInvocation({
            invocation_id: deterministicEventId(
              runId,
              stepDef.id,
              "tool_invocation",
            ),
            org_id: orgId,
            workspace_id: workspaceId,
            capability_name: `playbook.step.${stepDef.stepType}`,
            message_id: stepRunId,
            parent_message_id: runId,
            // runId is this playbook run's own id — the same value the
            // capability-invoking branch above hands the CapabilityContext as
            // both messageId and executionStepId, so this row joins to that
            // run's token_usage on the same key (#2597/#2615).
            execution_step_id: runId,
            status: stepStatus === "completed" ? "completed" : "failed",
            input_size_bytes: 0,
            output_size_bytes: 0,
            latency_ms: Date.now() - stepStartedAt,
            error_class: stepError !== null ? "StepError" : null,
            external_provider: "",
            external_server_id: null,
            risk_level: "low",
            required_approval: stepStatus === "waiting_approval" ? 1 : 0,
            surface: "runner",
            provider: "",
            created_at: new Date().toISOString(),
          });
        } catch (telErr) {
          logger.warn(
            { telErr },
            "playbook-run-execute: insertToolInvocation failed",
          );
        }
      });

      stepsExecuted++;

      // ── Handle step failure / pause ─────────────────────────────────────────
      if (stepStatus === "waiting_approval") {
        // Pause the run — awaiting human approval
        await step.run("finalize-paused", () =>
          runInTenantScope({ orgId, workspaceId }, () =>
            withTenantDb((tx) =>
              tx
                .update(schema.playbookRuns)
                .set({
                  status: "waiting_approval",
                  completedAt: undefined,
                })
                .where(eq(schema.playbookRuns.id, runId)),
            ),
          ),
        );

        return { runId, status: "waiting_approval", stepsExecuted };
      }

      if (stepStatus === "failed") {
        if (stepDef.exitOnError) {
          // Fail the run immediately
          const runFailEventType = "run_failed" as const;
          const runFailEventData = {
            stepId: stepDef.id,
            stepKey: stepDef.stepKey,
            error: stepError,
          };
          const runFailOccurredAt = new Date();
          const runFailHash = computeEventHash(
            prevHash,
            runFailEventType,
            runFailEventData,
            currentSequence,
            runFailOccurredAt,
          );

          await step.run(`emit-run-failed-${stepDef.id}`, () =>
            runInTenantScope({ orgId, workspaceId }, () =>
              withTenantDb((tx) =>
                tx.insert(schema.playbookEvents).values({
                  orgId,
                  workspaceId,
                  playbookRunId: runId,
                  stepRunId,
                  sequence: currentSequence,
                  eventType: runFailEventType,
                  eventData: runFailEventData,
                  prevEventHash: prevHash,
                  eventHash: runFailHash,
                  occurredAt: runFailOccurredAt,
                }),
              ),
            ),
          );

          await step.run("finalize-failed", () =>
            runInTenantScope({ orgId, workspaceId }, () =>
              withTenantDb((tx) =>
                tx
                  .update(schema.playbookRuns)
                  .set({
                    status: "failed",
                    completedAt: new Date(),
                    error: { message: stepError ?? "step failed" },
                  })
                  .where(eq(schema.playbookRuns.id, runId)),
              ),
            ),
          );

          return {
            runId,
            status: "failed",
            stepsExecuted,
            failedStep: stepDef.stepKey,
          };
        }
        // exitOnError=false: record failure, continue to next step
        // (fall through to next-step resolution below)
      }

      // ── Advance to next step ────────────────────────────────────────────────
      if (!shouldContinue) break;

      stepOutputs[stepDef.stepKey] = stepOutput;

      const nextId = nextStepByEdge.get(stepDef.id);
      if (nextId) {
        const nextStepDef = stepMap.get(nextId);
        currentStep = nextStepDef ?? (null as unknown as typeof currentStep);
      } else if (edges.length === 0) {
        // No edges defined at all — fall back to insertion order traversal
        const currentIdx = steps.findIndex((s) => s.id === stepDef.id);
        const nextStepDef = steps[currentIdx + 1];
        if (nextStepDef) {
          currentStep = nextStepDef;
        } else {
          // Last step in insertion order — done
          break;
        }
      } else {
        // Edges exist but this step has no outgoing default edge — traversal ends
        break;
      }
    }

    // ── Step 6: Finalize run ──────────────────────────────────────────────────
    const finalStatus = "completed" as const;
    const finalEventType = "run_completed" as const;
    const finalEventData = { stepsExecuted };
    const finalOccurredAt = new Date();
    const finalHash = computeEventHash(
      prevHash,
      finalEventType,
      finalEventData,
      currentSequence,
      finalOccurredAt,
    );

    await step.run("emit-run-completed", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx.insert(schema.playbookEvents).values({
            orgId,
            workspaceId,
            playbookRunId: runId,
            stepRunId: null,
            sequence: currentSequence,
            eventType: finalEventType,
            eventData: finalEventData,
            prevEventHash: prevHash,
            eventHash: finalHash,
            occurredAt: finalOccurredAt,
          }),
        ),
      ),
    );

    await step.run("finalize-completed", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.playbookRuns)
            .set({
              status: finalStatus,
              completedAt: new Date(),
            })
            .where(eq(schema.playbookRuns.id, runId)),
        ),
      ),
    );

    // ── ClickHouse run-level telemetry ──────────────────────────────────────
    // Wrapped in its own memoized step: this was the last statement before
    // `return`, but "last statement" does not mean "runs exactly once" in
    // Inngest's execution model — if the worker process is interrupted after
    // this insert succeeds but before the function's return value is
    // acknowledged, Inngest replays the whole function from the top. Every
    // earlier step.run is memoized and skipped, but this raw insertEvents()
    // call was not, so the replay re-inserted a duplicate
    // `playbook_run.completed` row into the append-only (non-Replacing)
    // `events` MergeTree table. event_id is now derived deterministically
    // from (runId, "run.completed") instead of crypto.randomUUID().
    await step.run("emit-run-completed-telemetry", async () => {
      try {
        await insertEvents([
          {
            event_id: deterministicEventId(runId, "playbook_run.completed"),
            org_id: orgId,
            workspace_id: workspaceId,
            event_type: "playbook_run.completed",
            source_system: "runner",
            stream_offset: null,
            payload: JSON.stringify({ runId, stepsExecuted }),
            emitted_at: new Date().toISOString(),
          },
        ]);
      } catch (telErr) {
        logger.warn(
          { telErr },
          "playbook-run-execute: final insertEvents failed",
        );
      }
    });

    logger.info(
      { runId, orgId, workspaceId, stepsExecuted },
      "playbook-run-execute: completed",
    );

    return { runId, status: finalStatus, stepsExecuted };
  },
);
