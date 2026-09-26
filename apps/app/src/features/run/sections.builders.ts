// Fixtures for the Issues, Policy, Context and Chain and seal tabs: a
// transcript shaped like the mockup's release run (the operator's prompt, a
// steering manifest, a context assembly, model calls with reported usage, and
// two policy decisions), a work read with a checkout and a pull request, and
// the props bundle a tab receives.
import { type RecallBody, recallOf, tachoFrame } from "@oxagen/run-ledger";
import type {
  RunTranscript,
  TranscriptEntry,
  TranscriptUsage,
} from "@/data/contracts/run";
import type { RunWork } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { runMetrics } from "./metrics";
import {
  NOW,
  runCost,
  runDetail,
  runOutputs,
  runRow,
  transcriptBody,
  transcriptEntry,
} from "./run.builders";
import type { FrameTabProps, RunTabProps } from "./tab-props";

const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

/** The body a host seals into `steering.manifest`, as JSON text. */
export function manifestText(
  overrides: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    schema: "oxagen.steering.manifest/1",
    delivers: ["must", "should", "may"],
    budget_tokens: 1600,
    spent_tokens: 1340,
    included: 3,
    cut: 5,
    text_digest: `sha256:${"b".repeat(64)}`,
    items: [
      {
        id: "ctx.release.never-merge",
        kind: "record",
        force: "must",
        recorded_at: at(-9000),
        tokens: 188,
        outcome: "included",
      },
      {
        id: "gate.rg_0093",
        kind: "policy",
        force: "must",
        recorded_at: at(-9000),
        tokens: 33,
        outcome: "included",
      },
      {
        id: "ctx.release.notes-format",
        kind: "record",
        force: "should",
        recorded_at: at(-8000),
        tokens: 214,
        outcome: "included",
      },
      {
        id: "skill:a-intel.release-notes-from-prs",
        kind: "skill",
        force: "info",
        recorded_at: at(-7000),
        tokens: 34,
        outcome: "cut",
        reason: "budget",
      },
      {
        id: "ont.release-train",
        kind: "ontology",
        force: "info",
        recorded_at: at(-7000),
        tokens: 34,
        outcome: "cut",
        reason: "budget",
      },
      {
        id: "ont.surface",
        kind: "ontology",
        force: "info",
        recorded_at: at(-7000),
        tokens: 29,
        outcome: "cut",
        reason: "tier",
      },
      {
        id: "ctx.release.notes-format-legacy",
        kind: "record",
        force: "should",
        recorded_at: at(-9500),
        tokens: 120,
        outcome: "cut",
        reason: "superseded",
        superseded_by: "ctx.release.notes-format",
      },
      {
        id: "mem.release-cadence",
        kind: "memory",
        force: "may",
        recorded_at: at(-6000),
        tokens: 61,
        outcome: "cut",
        reason: "budget",
      },
    ],
    bundle_version: 41,
    bundle_etag: "etag-41",
    ...overrides,
  });
}

const USAGE: TranscriptUsage = {
  inputUncached: 3368,
  cacheRead: 12_000,
  cacheWrite: 0,
  output: 812,
  reasoning: null,
};

type Spec = {
  seq: number;
  type: string;
  kind: TranscriptEntry["kind"];
  label: string;
  kinds: TranscriptEntry["kinds"];
  turn: number | null;
  /** What the server's fold states the frame is. */
  node: TranscriptEntry["node"];
  /** The call a decision was made on, as the server states it. */
  subject?: string;
  recall?: TranscriptEntry["recall"];
  text?: string | null;
  request?: boolean;
  decision?: string;
  usage?: TranscriptUsage;
};

/**
 * What the server reads from a manifest frame's body, by the server's own
 * rule (`recallOf` in `@oxagen/run-ledger`), so a fixture's recall and the
 * text it seals never disagree. Text is the body the frame kept, null a
 * frame that kept none, and a `RecallBody` any other state the server found.
 */
export function manifestRecall(
  body: string | RecallBody | null,
): NonNullable<TranscriptEntry["recall"]> {
  const frame = tachoFrame({
    seq: 1,
    ts: at(-3598),
    kind: "steering.manifest",
    hash: "",
    contentDigest: "",
    bytesRef: "",
    redactions: "",
    toolName: "",
    toolStatus: "",
    toolUseId: "",
    model: "",
    provider: "",
    policyDecision: "",
    costUsdMicros: null,
    turnSeq: null,
  });
  return recallOf(
    frame,
    body === null
      ? { state: "unretained" }
      : typeof body === "string"
        ? { state: "kept", text: body }
        : body,
  );
}

/**
 * A wrapped release run read at `everything`: the manifest and the context
 * assembly before the first turn, the operator's prompt, a model call that
 * reported its usage, an allowed tool call and a call routed to a person.
 */
export function evidenceTranscript(
  overrides: Partial<RunTranscript> = {},
  manifest: string | null = manifestText(),
): RunTranscript {
  const specs: Spec[] = [
    {
      seq: 0,
      type: "agent_start",
      kind: "frame",
      label: "agent_start",
      kinds: [],
      turn: null,
      node: "control",
    },
    {
      seq: 1,
      type: "steering.manifest",
      kind: "frame",
      label: "steering.manifest",
      kinds: ["recall"],
      turn: null,
      node: "recall",
      recall: manifestRecall(manifest),
      text: manifest,
    },
    {
      seq: 2,
      type: "context.assembled",
      kind: "frame",
      label: "context.assembled",
      kinds: ["recall"],
      turn: null,
      node: "recall",
      text: null,
    },
    {
      seq: 3,
      type: "turn_start",
      kind: "frame",
      label: "turn_start",
      kinds: ["prompt"],
      turn: 1,
      node: "prompt",
      text: "Cut 4.11.0 release notes. Task a-intel/platform#482.",
    },
    {
      seq: 4,
      type: "model.request",
      kind: "model_call",
      label: "anthropic/claude-opus-5",
      kinds: [],
      turn: 1,
      node: "model",
      request: true,
    },
    {
      seq: 5,
      type: "model.response",
      kind: "model_call",
      label: "anthropic/claude-opus-5",
      kinds: ["responses", "usage"],
      turn: 1,
      node: "model",
      text: "I will list the merged pull requests.",
      usage: USAGE,
    },
    {
      seq: 6,
      type: "tool_requested",
      kind: "tool_call",
      label: "github__list_pull_requests",
      kinds: ["tools"],
      turn: 1,
      node: "tool",
      request: true,
    },
    {
      seq: 7,
      type: "policy_decision",
      kind: "frame",
      label: "allow github__list_pull_requests",
      kinds: ["policy"],
      turn: 1,
      node: "policy",
      subject: "github__list_pull_requests",
      decision: "allow",
    },
    {
      seq: 8,
      type: "tool_call",
      kind: "tool_call",
      label: "github__list_pull_requests ok",
      kinds: ["tools"],
      turn: 1,
      node: "tool",
      text: '{"merged":38}',
    },
    {
      seq: 9,
      type: "tool_requested",
      kind: "tool_call",
      label: "github__create_release",
      kinds: ["tools"],
      turn: 1,
      node: "tool",
      request: true,
    },
    {
      seq: 10,
      type: "policy_decision",
      kind: "frame",
      label: "ask github__create_release",
      kinds: ["policy"],
      turn: 1,
      node: "policy",
      subject: "github__create_release",
      decision: "ask",
    },
  ];
  const entries = specs.map((spec) => {
    const body = transcriptBody({
      seq: String(spec.seq),
      type: spec.type,
      text: spec.text ?? null,
    });
    return transcriptEntry({
      seq: String(spec.seq),
      endSeq: String(spec.seq),
      at: at(-3600 + spec.seq * 2),
      elapsedMs: spec.seq * 2000,
      kind: spec.kind,
      type: spec.type,
      label: spec.label,
      kinds: spec.kinds,
      turn: spec.turn,
      node: spec.node,
      subject: spec.subject ?? null,
      recall: spec.recall ?? null,
      outcome: null,
      frames: 1,
      usage: spec.usage ?? null,
      request: spec.request === true ? body : null,
      response: spec.request === true ? null : body,
      decision:
        spec.decision === undefined
          ? null
          : {
              seq: String(spec.seq),
              decision: spec.decision,
              type: spec.type,
              harness: false,
              rules: [],
              taint: null,
              at: at(-3600 + spec.seq * 2),
            },
      cost: null,
      cumulativeCost: null,
    });
  });
  return {
    zoom: "everything",
    kinds: [],
    entries,
    cursor: null,
    complete: true,
    counts: {
      kinds: {
        prompt: 1,
        responses: 1,
        thinking: 0,
        tools: 3,
        policy: 2,
        usage: 1,
        recall: 2,
        seal: 0,
        errors: 0,
      },
      entries: 9,
      errors: 0,
      policy: 2,
      frames: { kinds: { policy: 2, recall: 2 }, policy: 2 },
    },
    figures: null,
    search: null,
    ...overrides,
  };
}

/**
 * The same release run read at `steps`, as the server folds it: the model
 * call's request and the response that reported its usage are one entry.
 */
export function evidenceSteps(
  overrides: Partial<RunTranscript> = {},
): RunTranscript {
  const step = (seq: number, rest: Partial<TranscriptEntry>) =>
    transcriptEntry({
      seq: String(seq),
      endSeq: String(seq),
      at: at(-3600 + seq * 2),
      elapsedMs: seq * 2000,
      frames: 1,
      cost: null,
      cumulativeCost: null,
      ...rest,
    });
  return {
    zoom: "steps",
    kinds: [],
    entries: [
      step(3, {
        kind: "frame",
        type: "turn_start",
        label: "turn_start",
        node: "prompt",
        kinds: ["prompt"],
        outcome: null,
        request: transcriptBody({
          seq: "3",
          type: "turn_start",
          text: "Cut 4.11.0 release notes. Task a-intel/platform#482.",
        }),
        response: null,
      }),
      step(4, {
        endSeq: "5",
        frames: 2,
        kind: "model_call",
        type: "model.request",
        label: "anthropic/claude-opus-5",
        node: "model",
        kinds: ["responses", "usage"],
        usage: USAGE,
        request: transcriptBody({ seq: "4", type: "model.request" }),
        response: transcriptBody({
          seq: "5",
          type: "model.response",
          text: "I will list the merged pull requests.",
        }),
      }),
    ],
    cursor: null,
    complete: true,
    counts: null,
    figures: null,
    search: null,
    ...overrides,
  };
}

const REPOSITORY = {
  host: "github.com",
  owner: "a-intel",
  name: "platform",
  url: "https://github.com/a-intel/platform",
  connected: true,
};

/** A work read with one checkout and one pull request carrying a failing check and a patch. */
export function runWork(overrides: Partial<RunWork> = {}): RunWork {
  return {
    runId: "tse_7k2m9q",
    machine: { name: "mbell-mbp-16" },
    checkouts: [
      {
        ref: "co_1",
        path: "~/src/platform/.worktrees/release-4.11.0-notes",
        branch: "release/4.11.0-notes",
        headSha: "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
        remoteDigest: null,
        repository: REPOSITORY,
        firstSeq: "3",
        lastSeq: "28",
      },
    ],
    diffs: [
      {
        checkoutRef: "co_1",
        seq: "31",
        baseSha: null,
        headSha: null,
        digest: `sha256:${"9".repeat(64)}`,
        bodyAvailable: true,
        completeness: "complete",
        limitations: [],
        observedAt: at(-600),
      },
    ],
    pullRequests: [
      {
        repository: REPOSITORY,
        number: 511,
        url: "https://github.com/a-intel/platform/pull/511",
        title: "Release notes for 4.11.0",
        state: "open",
        headSha: "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
        headRef: "release/4.11.0-notes",
        baseRef: "main",
        association: "recorded",
        closingIssues: null,
        checkoutRefs: ["co_1"],
        observedAt: at(-500),
        current: true,
        ci: {
          overall: "failing",
          counts: {
            total: 3,
            passed: 2,
            failed: 1,
            pending: 0,
            skipped: 0,
            neutral: 0,
          },
          runs: [
            {
              name: "lint",
              status: "completed",
              conclusion: "success",
              url: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
              app: null,
            },
            {
              name: "unit",
              status: "completed",
              conclusion: "success",
              url: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
              app: null,
            },
            {
              name: "docs",
              status: "completed",
              conclusion: "failure",
              url: "https://github.com/a-intel/platform/actions/runs/1",
              startedAt: null,
              completedAt: null,
              durationMs: null,
              app: null,
            },
          ],
          complete: true,
        },
        diff: {
          digest: `sha256:${"8".repeat(64)}`,
          headSha: "3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39",
          files: [
            {
              path: "RELEASE-4.11.0.md",
              previousPath: null,
              status: "added",
              additions: 3,
              deletions: 0,
              patch: "@@ -0,0 +1,3 @@\n+# 4.11.0\n+\n+## Features",
            },
          ],
          complete: true,
          limitations: [],
        },
      },
    ],
    complete: true,
    warnings: [],
    ...overrides,
  };
}

/** The props a tab receives, over a source a test hands in. */
export function tabProps({
  ctx,
  source,
  run = runRow(),
  everything = readOk(evidenceTranscript()),
  transcript = readOk(evidenceSteps()),
  outputs = readOk(runOutputs()),
  work = readOk(runWork()),
  body = null,
}: {
  ctx: WsCtx;
  source: DataSource;
  run?: RunRow;
  everything?: Read<RunTranscript>;
  transcript?: Read<RunTranscript>;
  outputs?: RunTabProps["outputs"];
  work?: Read<RunWork>;
  /** `?body=`, the frame the page has open. */
  body?: string | null;
}): FrameTabProps {
  const cost = readOk(runCost());
  return {
    ctx,
    source,
    run,
    detail: runDetail({ run }),
    place: { org: ctx.orgSlug, ws: ctx.wsSlug, runId: run.id },
    view: { kinds: [], frames: null, body },
    metrics: runMetrics({ run, cost, transcript }),
    transcript,
    everything,
    cost,
    outputs,
    work: Promise.resolve(work),
    agent: null,
    now: NOW,
  };
}
