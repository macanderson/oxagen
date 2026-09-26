/**
 * A goal-shaped turn on the engine, and the witness the in-app agent spec
 * names in §6: "a rule authored across two sources is answered by a graph
 * query".
 *
 * What is real here: the goal on the turn request, the role routing that
 * answers the verifier on another tier, the governed tool path each tool call
 * takes, the ledger calls in the order the turn makes them, and the payload
 * the recorder writes, checked against the run ledger's own registry.
 *
 * What is simulated, and why:
 *
 * - The engine is `FakeEngine` replaying a scripted goal run. The script has
 *   the frames `stella-serve`'s `drive_goal` emits for one round: the worker's
 *   completions and tool calls, the `verdict` stage, the verifier's own
 *   completion with `role: "verdict"`, the `goal_verdict` event, and the
 *   terminal frame, whose text is the verifier's reasoning.
 * - The models are `streamAgentReply` mocked at the chokepoint, as in
 *   `governed-turn.test.ts`.
 * - The graph is an in-memory stand-in behind the two tools. A person from
 *   `hubspot` and an account from `stripe` share an email, and no edge joins
 *   them until a rule is authored. `query_ontology` walks only the edges the
 *   authored rules produce, so the query reaches the `stripe` node only
 *   through the rule the turn wrote. A unit test cannot reach Neo4j; the
 *   stand-in keeps the property the witness is about, that the graph answers
 *   through the rule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  StellaEngineClient,
  type ServerFrame,
} from "@oxagen/stella-engine-client";
import { FakeEngine } from "@oxagen/stella-engine-client/testing";
import { validateInlineEventPayload } from "@oxagen/run-ledger";

const streamAgentReply = vi.fn();
const selectModel = vi.fn((s: { tier?: string }) => ({
  modelId: `model-for-${s.tier ?? "default"}`,
}));

vi.mock("@oxagen/ai", () => ({
  tool: (def: unknown) => def,
  streamAgentReply: (args: unknown) => streamAgentReply(args),
  defaultModel: () => ({ modelId: "default-model" }),
  modelIdOf: (m: unknown) =>
    typeof m === "string" ? m : ((m as { modelId?: string }).modelId ?? ""),
  modelIdentityFor: (wireId: string) => ({
    wireId,
    catalogId: wireId,
    provider: wireId.includes("/") ? (wireId.split("/")[0] ?? null) : null,
  }),
  selectModel: (s: { tier?: string }) => selectModel(s),
  stepCountIs: (n: number) => ({ __stepCountIs: n }),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    STELLA_SERVE_URL: "http://engine.test",
    STELLA_SERVE_TOKEN: "fake-token",
  }),
}));

import {
  GOAL_VERDICT_EVENT_TYPE,
  goalVerdictOf,
  goalVerdictPayload,
  toGoalSpec,
} from "./engine/goal";
import {
  runGovernedTurn,
  type TurnLedger,
  type TurnLedgerGoalVerdict,
  type TurnLedgerOutcome,
} from "./governed-turn";
import {
  RULE_AUTHORING_ROUNDS,
  ruleAuthoringGoal,
  ruleAuthoringInstruction,
  type GraphRule,
} from "./rule-authoring-goal";

// ── the graph stand-in ──────────────────────────────────────────────────────

interface GraphNode {
  nodeId: string;
  label: string;
  source: string;
  displayName: string;
  /** The key the rule joins the two sources on. */
  email: string;
}

const NODES: readonly GraphNode[] = [
  {
    nodeId: "p_hubspot_ada",
    label: "Person",
    source: "hubspot",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
  },
  {
    nodeId: "a_stripe_ada",
    label: "Account",
    source: "stripe",
    displayName: "Ada's billing account",
    email: "ada@example.com",
  },
  {
    nodeId: "a_stripe_bob",
    label: "Account",
    source: "stripe",
    displayName: "Bob's billing account",
    email: "bob@example.com",
  },
];

interface GraphEdge {
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
}

const RULE: GraphRule = {
  relationshipType: "OWNS_ACCOUNT",
  start: { label: "Person", source: "hubspot" },
  end: { label: "Account", source: "stripe" },
};

/** The rules the turn authored, and the traversal that walks them. */
function graphStandIn() {
  const rules: GraphRule[] = [];
  const author = vi.fn(async (input: unknown) => {
    const rule = input as {
      name: string;
      startLabel: string;
      endLabel: string;
      startSource: string;
      endSource: string;
    };
    rules.push({
      relationshipType: rule.name,
      start: { label: rule.startLabel, source: rule.startSource },
      end: { label: rule.endLabel, source: rule.endSource },
    });
    return { relationshipTypeId: `rt_${rule.name}`, created: true };
  });
  const query = vi.fn(async (input: unknown) => {
    const { startNodeId, edgeTypes } = input as {
      startNodeId: string;
      edgeTypes: string[];
    };
    const start = NODES.find((n) => n.nodeId === startNodeId) ?? null;
    const edges: GraphEdge[] = [];
    for (const rule of rules) {
      if (!start || !edgeTypes.includes(rule.relationshipType)) continue;
      if (start.label !== rule.start.label) continue;
      if (start.source !== rule.start.source) continue;
      for (const node of NODES) {
        if (node.label !== rule.end.label) continue;
        if (node.source !== rule.end.source) continue;
        if (node.email !== start.email) continue;
        edges.push({
          fromNodeId: start.nodeId,
          toNodeId: node.nodeId,
          edgeType: rule.relationshipType,
        });
      }
    }
    const reached = edges.map((e) =>
      NODES.find((n) => n.nodeId === e.toNodeId),
    );
    return {
      startNode: start,
      nodes: [start, ...reached].filter(
        (n): n is GraphNode => n !== null && n !== undefined,
      ),
      edges,
      truncated: false,
    };
  });
  const tools = {
    upsert_schema_relationship: {
      description: "Create a relationship rule",
      inputSchema: { type: "object" } as never,
      execute: author,
    } as never,
    query_ontology: {
      description: "Traverse the graph",
      inputSchema: { type: "object" } as never,
      execute: query,
    } as never,
  };
  const governance = {
    upsert_schema_relationship: {
      riskLevel: "low" as const,
      requiresApproval: false,
      readOnly: false,
    },
    query_ontology: {
      riskLevel: "low" as const,
      requiresApproval: false,
      readOnly: true,
    },
  };
  return { rules, author, query, tools, governance };
}

// ── the scripted goal run ───────────────────────────────────────────────────

const AUTHOR_INPUT = {
  schemaName: "crm-billing",
  name: "OWNS_ACCOUNT",
  displayName: "Owns account",
  startLabel: "Person",
  endLabel: "Account",
  startSource: "hubspot",
  endSource: "stripe",
};
const QUERY_INPUT = {
  startNodeId: "p_hubspot_ada",
  edgeTypes: ["OWNS_ACCOUNT"],
  maxDepth: 1,
};
const WORKER_TEXT =
  "OWNS_ACCOUNT now links Ada in HubSpot to her Stripe account.";
const REASONING =
  "query_ontology over OWNS_ACCOUNT from p_hubspot_ada returned a_stripe_ada, an Account from stripe.";

function workerRequest(id: string): ServerFrame {
  return {
    type: "provider_request",
    request_id: id,
    provider_id: "oxagen",
    role: "worker",
    request: { messages: [{ role: "user", content: "author the rule" }] },
  } as ServerFrame;
}

/** One round of `drive_goal`, then the verdict `met` decides. */
function goalRunScript(met: boolean): ServerFrame[] {
  const frames: ServerFrame[] = [
    workerRequest("prov-1"),
    {
      type: "tool_request",
      request_id: "tool-1",
      name: "upsert_schema_relationship",
      input: AUTHOR_INPUT,
    },
    workerRequest("prov-2"),
    {
      type: "tool_request",
      request_id: "tool-2",
      name: "query_ontology",
      input: QUERY_INPUT,
    },
    workerRequest("prov-3"),
    {
      type: "event",
      event: { type: "text", text: WORKER_TEXT },
    } as ServerFrame,
    {
      type: "event",
      event: { type: "stage", name: "verdict", scope: "run" },
    } as ServerFrame,
    {
      type: "provider_request",
      request_id: "prov-verdict-1",
      provider_id: "oxagen",
      role: "verdict",
      request: {
        messages: [{ role: "user", content: "GOAL: ... Has it been met?" }],
      },
    } as ServerFrame,
    {
      type: "event",
      event: {
        type: "goal_verdict",
        round: 1,
        met,
        reasoning: met ? REASONING : "no traversal was run",
        cost_usd: 0.0021,
      },
    } as ServerFrame,
  ];
  frames.push({
    type: "turn_complete",
    outcome: met
      ? { status: "completed", text: REASONING, cost_usd: 0.01 }
      : {
          status: "aborted",
          reason:
            "goal not met — round cap (1) reached without a passing verdict",
          cost_usd: 0.01,
        },
  } as ServerFrame);
  return frames;
}

function fakeStream(options: {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
}) {
  return {
    fullStream: (async function* () {})(),
    text: Promise.resolve(options.text ?? ""),
    toolCalls: Promise.resolve(options.toolCalls ?? []),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    finishReason: Promise.resolve(
      options.toolCalls?.length ? "tool-calls" : "stop",
    ),
  };
}

function scriptModels(): void {
  streamAgentReply
    .mockImplementationOnce(() =>
      fakeStream({
        toolCalls: [
          {
            toolCallId: "call_1",
            toolName: "upsert_schema_relationship",
            input: AUTHOR_INPUT,
          },
        ],
      }),
    )
    .mockImplementationOnce(() =>
      fakeStream({
        toolCalls: [
          {
            toolCallId: "call_2",
            toolName: "query_ontology",
            input: QUERY_INPUT,
          },
        ],
      }),
    )
    .mockImplementationOnce(() => fakeStream({ text: WORKER_TEXT }))
    .mockImplementationOnce(() =>
      fakeStream({
        text: JSON.stringify({ met: true, reasoning: REASONING, feedback: "" }),
      }),
    );
}

/** A ledger that keeps what it was told, in order. */
function recordingLedger(overrides: Partial<TurnLedger> = {}): TurnLedger & {
  log: string[];
  verdicts: TurnLedgerGoalVerdict[];
  seals: TurnLedgerOutcome[];
} {
  const log: string[] = [];
  const verdicts: TurnLedgerGoalVerdict[] = [];
  const seals: TurnLedgerOutcome[] = [];
  return {
    log,
    verdicts,
    seals,
    modelCallStarted: async () => undefined,
    modelCall: async (record) => {
      log.push(`model:${record.role}`);
    },
    toolCallStarted: async () => undefined,
    toolCall: async (record) => {
      log.push(`tool:${record.toolName}`);
    },
    goalVerdict: async (record) => {
      log.push(`verdict:${record.round}:${record.met}`);
      verdicts.push(record);
    },
    seal: async (outcome) => {
      log.push(`seal:${outcome.status}`);
      seals.push(outcome);
    },
    ...overrides,
  };
}

function setup(script: ServerFrame[]) {
  const engine = new FakeEngine();
  engine.scriptTurn(script);
  const client = new StellaEngineClient({
    baseUrl: "http://engine.test",
    token: "fake-token",
    fetchImpl: engine.fetch,
  });
  return { engine, client };
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

const telemetry = {
  orgId: "org-1",
  workspaceId: "ws-1",
  surface: "app" as const,
  messageId: "11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  streamAgentReply.mockReset();
  selectModel.mockClear();
});

// ── the witness ─────────────────────────────────────────────────────────────

describe("a rule authored across two sources is answered by a graph query", () => {
  it("records the verifier's verdict on the run once the graph answers through the rule", async () => {
    scriptModels();
    const graph = graphStandIn();
    const goal = ruleAuthoringGoal(RULE);
    const ledger = recordingLedger();
    const { engine, client } = setup(goalRunScript(true));

    const turn = await runGovernedTurn({
      telemetry,
      model: { modelId: "anthropic/claude-sonnet-4.6" } as never,
      tier: "balanced",
      system: "s",
      history: [],
      instruction:
        "Link HubSpot people to their Stripe accounts by email as OWNS_ACCOUNT.",
      tools: graph.tools,
      governance: graph.governance,
      goal,
      engine: client,
      ledger,
    });
    await drain(turn.fullStream);

    // The engine was asked for a judged run against the rule's goal.
    expect(engine.turnRequests[0]).toMatchObject({
      goal: { goal: goal.statement, max_rounds: RULE_AUTHORING_ROUNDS },
    });

    // The rule spans two sources, and the graph answered through it: the
    // traversal from the HubSpot person over the authored type reached the
    // Stripe account, and only Ada's.
    expect(graph.rules).toEqual([RULE]);
    expect(graph.query).toHaveBeenCalledWith(QUERY_INPUT, expect.anything());
    const answer = await graph.query.mock.results[0]!.value;
    expect(answer.edges).toEqual([
      {
        fromNodeId: "p_hubspot_ada",
        toNodeId: "a_stripe_ada",
        edgeType: "OWNS_ACCOUNT",
      },
    ]);
    expect(
      answer.nodes.map((n: GraphNode) => `${n.source}:${n.nodeId}`),
    ).toEqual(["hubspot:p_hubspot_ada", "stripe:a_stripe_ada"]);

    // The verdict is on the run: after the query that proves the rule, and
    // before the seal, naming the query and the node it returned.
    expect(ledger.log).toEqual([
      "model:worker",
      "tool:upsert_schema_relationship",
      "model:worker",
      "tool:query_ontology",
      "model:worker",
      "model:verdict",
      "verdict:1:true",
      "seal:completed",
    ]);
    const [verdict] = ledger.verdicts;
    expect(verdict).toMatchObject({
      round: 1,
      met: true,
      goal: goal.statement,
      costUsd: 0.0021,
    });
    expect(verdict!.reasoning).toContain("query_ontology");
    expect(verdict!.reasoning).toContain("a_stripe_ada");

    // The frame the recorder writes for it passes the ledger's registry.
    const validated = validateInlineEventPayload(
      GOAL_VERDICT_EVENT_TYPE,
      goalVerdictPayload(verdict!),
    );
    expect(validated.stage).toBe("verification");

    // The reply is the worker's own words; the verifier's reasoning is the
    // engine's outcome text, which is what the seal records.
    await expect(turn.finalText).resolves.toBe(WORKER_TEXT);
    expect(ledger.seals).toEqual([{ status: "completed", text: REASONING }]);
  });

  it("answers the verifier on a different model from the worker's", async () => {
    scriptModels();
    const graph = graphStandIn();
    const { client } = setup(goalRunScript(true));
    const turn = await runGovernedTurn({
      telemetry,
      model: { modelId: "anthropic/claude-sonnet-4.6" } as never,
      tier: "balanced",
      system: "s",
      history: [],
      instruction: "author the rule",
      tools: graph.tools,
      governance: graph.governance,
      goal: ruleAuthoringGoal(RULE),
      engine: client,
    });
    await drain(turn.fullStream);
    await turn.finalText;

    const models = streamAgentReply.mock.calls.map(
      ([args]) => (args as { model: { modelId: string } }).model.modelId,
    );
    expect(models).toEqual([
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet-4.6",
      "model-for-precise",
    ]);
  });

  it("records a verdict that is not met and seals the turn aborted (negative)", async () => {
    scriptModels();
    const graph = graphStandIn();
    const ledger = recordingLedger();
    const { client } = setup(goalRunScript(false));
    const turn = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "author the rule",
      tools: graph.tools,
      governance: graph.governance,
      goal: ruleAuthoringGoal(RULE),
      engine: client,
      ledger,
    });
    const parts = await drain(turn.fullStream);

    expect(ledger.verdicts.map((v) => v.met)).toEqual([false]);
    expect(ledger.seals.map((s) => s.status)).toEqual(["aborted"]);
    // An unmet goal is not an answer: the stream ends on the engine's abort.
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "engine_aborted" }),
      }),
    );
  });

  it("does not answer when the verdict cannot be recorded (negative)", async () => {
    scriptModels();
    const graph = graphStandIn();
    const ledger = recordingLedger({
      goalVerdict: async () => {
        throw new Error("ledger is read-only");
      },
    });
    const { client } = setup(goalRunScript(true));
    const turn = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "author the rule",
      tools: graph.tools,
      governance: graph.governance,
      goal: ruleAuthoringGoal(RULE),
      engine: client,
      ledger,
    });
    await drain(turn.fullStream);
    await expect(turn.finalText).rejects.toThrow("ledger is read-only");
  });
});

// ── the plain turn is unchanged ─────────────────────────────────────────────

describe("a turn without a goal", () => {
  it("sends no goal and records no verdict", async () => {
    streamAgentReply.mockImplementation(() => fakeStream({ text: "hi" }));
    const ledger = recordingLedger();
    const { engine, client } = setup([
      workerRequest("prov-1"),
      { type: "event", event: { type: "text", text: "hi" } } as ServerFrame,
      {
        type: "turn_complete",
        outcome: { status: "completed", text: "hi", cost_usd: 0 },
      } as ServerFrame,
    ]);
    const turn = await runGovernedTurn({
      telemetry,
      system: "s",
      history: [],
      instruction: "hi",
      tools: {},
      engine: client,
      ledger,
    });
    await drain(turn.fullStream);
    await turn.finalText;
    expect(engine.turnRequests[0]).not.toHaveProperty("goal");
    expect(ledger.verdicts).toEqual([]);
  });
});

// ── the pieces ──────────────────────────────────────────────────────────────

describe("the goal's wire shape and receipt", () => {
  it("maps the goal onto the engine's GoalSpec", () => {
    expect(toGoalSpec({ statement: "done when x", maxRounds: 2 })).toEqual({
      goal: "done when x",
      max_rounds: 2,
    });
  });

  it("reads only goal_verdict events", () => {
    const goal = { statement: "g", maxRounds: 1 };
    expect(goalVerdictOf({ type: "text", text: "x" }, 4, goal)).toBeNull();
    expect(
      goalVerdictOf(
        {
          type: "goal_verdict",
          round: 2,
          met: false,
          reasoning: "r",
          cost_usd: 0.5,
        },
        9,
        goal,
      ),
    ).toEqual({
      seq: 9,
      round: 2,
      met: false,
      reasoning: "r",
      goal: "g",
      costUsd: 0.5,
    });
  });

  it("writes digests and integer micro-dollars, never the text", () => {
    const payload = goalVerdictPayload({
      seq: 3,
      round: 1,
      met: true,
      reasoning: "because",
      goal: "the goal",
      costUsd: 0.0021,
    });
    expect(payload.verifier_cost_usd_micros).toBe(2100);
    expect(JSON.stringify(payload)).not.toContain("because");
    expect(JSON.stringify(payload)).not.toContain("the goal");
    expect(
      goalVerdictPayload({
        seq: 3,
        round: 1,
        met: true,
        reasoning: "r",
        goal: "g",
        costUsd: Number.NaN,
      }).verifier_cost_usd_micros,
    ).toBe(0);
  });
});

describe("ruleAuthoringGoal", () => {
  it("names both sources and the graph query that proves the rule", () => {
    const goal = ruleAuthoringGoal(RULE);
    expect(goal.maxRounds).toBe(RULE_AUTHORING_ROUNDS);
    for (const word of ["OWNS_ACCOUNT", "hubspot", "stripe", "query_ontology"])
      expect(goal.statement).toContain(word);
  });

  it("refuses a rule whose names would push the goal past the cap (negative)", () => {
    expect(() =>
      ruleAuthoringGoal({
        ...RULE,
        start: { label: "Person", source: "x".repeat(2000) },
      }),
    ).toThrow();
  });
});

describe("ruleAuthoringInstruction", () => {
  it("asks for the rule and for the query the goal judges", () => {
    const text = ruleAuthoringInstruction(RULE);
    for (const word of ["OWNS_ACCOUNT", "hubspot", "stripe", "query_ontology"])
      expect(text).toContain(word);
    expect(text).not.toContain("note");
  });

  it("adds the person's note after the request, marked as theirs", () => {
    const text = ruleAuthoringInstruction(RULE, "Join on email.");
    expect(text.endsWith("The person's note: Join on email.")).toBe(true);
  });
});
