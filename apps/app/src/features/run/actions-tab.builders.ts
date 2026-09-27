// Fixtures for the Governed actions tab: a page of frames shaped like the
// mockup's release run (`FIXTURES.FRAMES`, sixteen frames from `agent_start`
// to the `approval_request` that parks `github__create_release`), the
// whole-run transcript at `everything` that places them in turns and carries
// their decisions and running totals, and the approvals recorded on the run.
import type {
  ApprovalItem,
  ResolvedApprovalItem,
} from "@/data/contracts/approvals";
import type {
  RunFrame,
  RunTranscript,
  TranscriptEntry,
} from "@/data/contracts/run";
import { runFrame, transcriptEntry } from "./run.builders";

/** When the release run's first frame was recorded. */
const T0 = Date.parse("2026-09-15T09:14:02.114Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

type Spec = {
  type: string;
  ms: number;
  summary: string;
  /** The frame's `tool` and `toolStatus`, which `summary` shows a person. */
  tool?: string;
  toolStatus?: string;
  stage: string;
  turn: number | null;
  kind: TranscriptEntry["kind"];
  costMicros?: string;
  decision?: string;
  body?: "full" | "digest_only" | "none";
};

const SPECS: readonly Spec[] = [
  {
    type: "agent_start",
    ms: 0,
    summary: "agent_start",
    stage: "session",
    turn: null,
    kind: "frame",
    body: "digest_only",
  },
  {
    type: "context.assembled",
    ms: 205,
    summary: "context.assembled",
    stage: "model",
    turn: null,
    kind: "frame",
  },
  {
    type: "model.request",
    ms: 288,
    summary: "anthropic/claude-opus-5",
    stage: "model",
    turn: 1,
    kind: "model_call",
  },
  {
    type: "model.response",
    ms: 7657,
    summary: "anthropic/claude-opus-5",
    stage: "model",
    turn: 1,
    kind: "model_call",
    costMicros: "412600",
  },
  {
    type: "tool_requested",
    ms: 7698,
    summary: "github__list_pull_requests",
    tool: "github__list_pull_requests",
    stage: "tool",
    turn: 1,
    kind: "tool_call",
  },
  {
    type: "policy_decision",
    ms: 7705,
    summary: "allow github__list_pull_requests",
    tool: "github__list_pull_requests",
    stage: "policy",
    turn: 1,
    kind: "policy",
    decision: "allow",
  },
  {
    type: "token_issued",
    ms: 7712,
    summary: "token_issued",
    stage: "policy",
    turn: 1,
    kind: "policy",
    body: "none",
  },
  {
    type: "tool_call",
    ms: 8826,
    summary: "github__list_pull_requests ok",
    tool: "github__list_pull_requests",
    toolStatus: "ok",
    stage: "tool",
    turn: 1,
    kind: "tool_call",
    costMicros: "0",
  },
  {
    type: "model.request",
    ms: 8888,
    summary: "anthropic/claude-opus-5",
    stage: "model",
    turn: 1,
    kind: "model_call",
  },
  {
    type: "model.response",
    ms: 16550,
    summary: "anthropic/claude-opus-5",
    stage: "model",
    turn: 1,
    kind: "model_call",
    costMicros: "551800",
  },
  {
    type: "control.steer",
    ms: 41894,
    summary: "control.steer",
    stage: "control",
    turn: 2,
    kind: "frame",
  },
  {
    type: "model.request",
    ms: 42096,
    summary: "anthropic/claude-opus-5",
    stage: "model",
    turn: 2,
    kind: "model_call",
  },
  {
    type: "model.response",
    ms: 49223,
    summary: "anthropic/claude-opus-5",
    stage: "model",
    turn: 2,
    kind: "model_call",
    costMicros: "390400",
  },
  {
    type: "tool_requested",
    ms: 49276,
    summary: "github__create_release",
    tool: "github__create_release",
    stage: "tool",
    turn: 2,
    kind: "tool_call",
  },
  {
    type: "policy_decision",
    ms: 49283,
    summary: "ask github__create_release",
    tool: "github__create_release",
    stage: "policy",
    turn: 2,
    kind: "policy",
    decision: "ask",
  },
  {
    type: "approval_request",
    ms: 49290,
    summary: "approval_request github__create_release",
    tool: "github__create_release",
    stage: "policy",
    turn: 2,
    kind: "policy",
  },
];

/** The instant the release run's frame `seq` was recorded. */
export function releaseAt(seq: number): string {
  return at(SPECS[seq]?.ms ?? 0);
}

/** The sixteen frames, one page of `get_run`, each with its body reference and the cost it recorded. */
export function releaseFrames(): RunFrame[] {
  return SPECS.map((spec, seq) =>
    runFrame({
      cursor: `ZjoxN${String(seq)}`,
      seq: String(seq),
      type: spec.type,
      stage: spec.stage,
      observedAt: at(spec.ms),
      digest: `sha256:ev${String(seq).padStart(2, "0")}`,
      summary: spec.summary,
      tool: spec.tool ?? null,
      toolStatus: spec.toolStatus ?? null,
      approvalId: null,
      body:
        spec.body === "none"
          ? { digest: null, bytesRef: null, redactions: [], fidelity: "full" }
          : spec.body === "digest_only"
            ? {
                digest: `sha256:bd${String(seq)}`,
                bytesRef: null,
                redactions: [],
                fidelity: "digest_only",
              }
            : {
                digest: `sha256:bd${String(seq)}`,
                bytesRef: `evb:v1:k:${String(seq)}`,
                redactions: [],
                fidelity: "full",
              },
      cost:
        spec.costMicros === undefined
          ? null
          : {
              micros: spec.costMicros,
              currency: "USD",
              basis: "client_attested",
            },
    }),
  );
}

/** The same frames at `everything`: their turns, their decisions and the run's running total at each. */
export function releaseTranscript(): RunTranscript {
  let running = 0;
  let spent = false;
  const entries = SPECS.map((spec, seq) => {
    if (spec.costMicros !== undefined) {
      running += Number(spec.costMicros);
      spent = true;
    }
    return transcriptEntry({
      seq: String(seq),
      endSeq: String(seq),
      at: at(spec.ms),
      elapsedMs: spec.ms,
      kind: spec.kind,
      type: spec.type,
      label: spec.summary,
      turn: spec.turn,
      frames: 1,
      request: null,
      response: null,
      decision:
        spec.decision === undefined
          ? null
          : {
              seq: String(seq),
              decision: spec.decision,
              type: spec.type,
              harness: false,
              rules: [],
              taint: null,
              at: at(spec.ms),
            },
      cost:
        spec.costMicros === undefined
          ? null
          : {
              micros: spec.costMicros,
              currency: "USD",
              basis: "client_attested",
            },
      cumulativeCost: spent
        ? { micros: String(running), currency: "USD", basis: "client_attested" }
        : null,
    });
  });
  return {
    zoom: "everything",
    kinds: [],
    entries,
    cursor: null,
    complete: true,
    counts: null,
    figures: null,
    search: null,
  };
}

/** The call parked at frame 15, still waiting on a person. */
export function parkedRelease(
  overrides: Partial<ApprovalItem> = {},
): ApprovalItem {
  return {
    id: "apr_01k5rs3k7",
    runId: "tse_7k2m9q",
    tool: "github__create_release",
    agentKey: "acme.core.release-bot",
    requester: "usr_marcusbell",
    mandateId: null,
    rule: null,
    autoEligibility: null,
    createdAt: releaseAt(15),
    expiresAt: at(49290 + 600_000),
    ...overrides,
  };
}

/** The same call, decided. */
export function decidedRelease(
  overrides: Partial<ResolvedApprovalItem> = {},
): ResolvedApprovalItem {
  return {
    id: "apr_01k5rs3k7",
    runId: "tse_7k2m9q",
    tool: "github__create_release",
    requester: "usr_marcusbell",
    createdAt: releaseAt(15),
    expiresAt: at(49290 + 600_000),
    resolvedAt: at(49290 + 47_000),
    resolution: "approved",
    resolvedBy: "user:usr_marcusbell",
    autoRuleRef: null,
    ...overrides,
  };
}
