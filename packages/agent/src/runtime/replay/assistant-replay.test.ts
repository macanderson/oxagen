/**
 * The assistant's replay set (#4172).
 *
 * Each fixture in `fixtures/` is one assistant turn: the frames the engine
 * sends, the fake output of each capability it reaches, the gates to close,
 * and what the turn must produce. This file replays every fixture through the
 * composition `assistant-turn.ts` builds: `materializeTools` in park mode, the
 * tool belt with the interactive agent's capabilities pinned, and
 * `runGovernedTurn` on the client package's fake engine. The capability
 * registry and the kernel are the real ones.
 *
 * What stays real is the point: the contracts, their surfaces, the kernel's
 * gate order, the park path and the ledger classification. A renamed tool, a
 * capability that moves on or off the agent surface, a gate that is added,
 * dropped or reordered, or a refusal that changes class fails a fixture.
 *
 * What is faked is everything with a store behind it: the emergency-deny
 * read, the kill-switch gate, the approval row, the IAM decision, the billing
 * and budget gates, the tool-invocation telemetry and each capability's
 * handler. The fakes log every call, and that log is the `gates` a fixture
 * pins.
 *
 * The fixtures are hand-authored in the frame shape the fake replays, not
 * recorded from `stella-serve`. README.md in this folder says how to add a
 * turn and what recording one from the real binary would take.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StellaEngineClient,
  type ServerFrame,
} from "@oxagen/stella-engine-client";
import { FakeEngine } from "@oxagen/stella-engine-client/testing";
import { BudgetExceededError, GauExhaustedError } from "@oxagen/billing";
import type { KillSwitchRow } from "@oxagen/iam";
import {
  clearBillingAdmissionGate,
  clearBudgetAdmissionGate,
  clearHandlersForTests,
  clearKernelIAMRuntime,
  registerHandler,
  setBillingAdmissionGate,
  setBudgetAdmissionGate,
  setKernelIAMRuntime,
} from "@oxagen/oxagen/kernel";
import { INTERACTIVE_AGENT_CAPABILITIES } from "@oxagen/oxagen/interactive-agent";

const streamAgentReply = vi.hoisted(() => vi.fn());
const insertToolInvocation = vi.hoisted(() => vi.fn(async () => undefined));
const createApprovalRequest = vi.hoisted(() => vi.fn());
const waitForApproval = vi.hoisted(() => vi.fn());
const readActiveEmergencyDenies = vi.hoisted(() => vi.fn());

// The model chokepoint answers from the fixture; the rest of @oxagen/ai stays
// real, because materializeTools builds its tools with it.
vi.mock("@oxagen/ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/ai")>();
  return {
    ...real,
    streamAgentReply: (args: unknown) => streamAgentReply(args),
    defaultModel: () => ({ modelId: "default-model" }),
    selectModel: (s: { tier?: string }) => ({
      modelId: `model-for-${s.tier ?? "default"}`,
    }),
    modelIdentityFor: (wireId: string) => ({
      wireId,
      catalogId: wireId,
      provider: wireId.includes("/") ? (wireId.split("/")[0] ?? null) : null,
    }),
  };
});
vi.mock("@oxagen/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/telemetry")>()),
  insertToolInvocation,
}));
vi.mock("../approval", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../approval")>()),
  createApprovalRequest,
  waitForApproval,
}));
// No MCP servers or plugin types: the set covers the platform's own
// capabilities, and the contributors read Postgres.
vi.mock("../plugin-type", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-type")>()),
  getPluginTypeContributors: () => [],
}));
// The belt reads the active emergency denies once per turn (R4, #3370). The
// fake answers from the fixture's kill switches, and the tenant seam hands it
// a stand-in transaction because nothing else on this path reads Postgres.
// The org-wide seam is the same function (ADR-086), so a handler's role gate
// that reads through withOrgDb gets the stand-in too.
vi.mock("@oxagen/iam", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/iam")>()),
  readActiveEmergencyDenies,
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const withTenantDb = async (fn: (tx: unknown) => unknown) => fn({});
  return { ...real, withTenantDb, withOrgDb: withTenantDb };
});
vi.mock("@oxagen/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/plugins")>()),
  listEntitledCapabilityPluginIds: async () => new Set<string>(),
}));

import {
  runGovernedTurn,
  type TurnLedger,
  type TurnLedgerOutcome,
} from "../governed-turn";
import { materializeTools } from "../materialize-tools";
import { LOAD_TOOLS, SEARCH_TOOLS, createToolBelt } from "../tool-belt";
import type { KillSwitchGate } from "../kill-switch-gate";
import type { CapabilityContext } from "../../types";

/** One replayed turn. README.md documents every field. */
interface ReplayFixture {
  turn: string;
  question: string;
  source: "hand-authored" | "recorded";
  gates?: {
    iamDeny?: string[];
    /** Switched off before the turn: cut from the belt and refused per call. */
    killSwitch?: string[];
    /** Switched off after the belt was built: refused per call only. */
    killSwitchMidTurn?: string[];
    gauExhausted?: boolean;
    budgetExceeded?: boolean;
  };
  /** Fake handler output per capability; it must pass the real output schema. */
  handlers?: Record<string, unknown>;
  frames: ServerFrame[];
  expect: {
    tools: string[];
    gates: string[];
    ledger: string[];
    answers: string[];
    refusals: string[];
    invocations: string[];
    approvals: string[];
    answer: string;
    loadUnknown?: string[];
  };
}

const ORG = "6f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const WORKSPACE = "7a2d2e3f-4b5c-4d6e-9f70-8b9c0d1e2f30";
const USER = "8b3e3f40-5c6d-4e7f-a081-9c0d1e2f3041";
const MESSAGE = "9c4f4051-6d7e-4f80-b192-0d1e2f304152";
const MODEL = "anthropic/claude-sonnet-4.6";

const FIXTURES_DIR = join(__dirname, "fixtures");

function loadFixtures(): Array<{ file: string; fixture: ReplayFixture }> {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file: join(FIXTURES_DIR, file),
      fixture: JSON.parse(
        readFileSync(join(FIXTURES_DIR, file), "utf8"),
      ) as ReplayFixture,
    }));
}

interface Completion {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
}

/**
 * The model's side of the turn, read off the frames: a completion asks for
 * the tools the engine starts before its next `provider_request`, and the
 * last one answers with the turn's text.
 */
function completionsFor(frames: ServerFrame[]): Completion[] {
  const completions: Completion[] = [];
  let finalText = "";
  for (const frame of frames) {
    if (frame.type === "provider_request") {
      completions.push({ text: "", toolCalls: [] });
    } else if (frame.type === "event") {
      const event = frame.event as {
        type: string;
        text?: string;
        call?: { call_id: string; name: string; input: unknown };
      };
      if (event.type === "tool_start" && event.call) {
        completions.at(-1)?.toolCalls.push({
          toolCallId: event.call.call_id,
          toolName: event.call.name,
          input: event.call.input,
        });
      }
      if (event.type === "text" && typeof event.text === "string")
        finalText = event.text;
    }
  }
  const last = completions.at(-1);
  if (last) last.text = finalText;
  return completions;
}

function fakeStream(completion: Completion) {
  return {
    fullStream: (async function* () {})(),
    text: Promise.resolve(completion.text),
    toolCalls: Promise.resolve(completion.toolCalls),
    usage: Promise.resolve({ inputTokens: 10, outputTokens: 5 }),
    finishReason: Promise.resolve(
      completion.toolCalls.length > 0 ? "tool-calls" : "stop",
    ),
  };
}

function killSwitchRow(capability: string): KillSwitchRow {
  return {
    id: "3d5f5162-7e8f-4091-8203-1e2f30415263",
    publicId: "ksw_replay",
    targetKind: "tool_version",
    targetId: `tlv_${capability}`,
    scopeKind: "workspace",
    workspaceId: WORKSPACE,
    capabilityId: capability,
    resourceScopeDigest: null,
    principalId: null,
    reason: "replay: switched off for the set",
    active: true,
    activatedAt: new Date("2026-09-24T00:00:00.000Z"),
    deactivatedAt: null,
    flippedByUserId: USER,
    updatedById: USER,
  };
}

/** How the host answered the engine for one tool request. */
function answerClass(body: unknown): string {
  const output = (body as { output?: Record<string, unknown> }).output ?? {};
  if ("ok" in output) return "ok";
  const error = output.error as { class?: string } | undefined;
  return error?.class ?? "error";
}

async function replay(fixture: ReplayFixture) {
  const gates: string[] = [];
  const ledger: string[] = [];
  const approvals: string[] = [];
  const closed = fixture.gates ?? {};

  // The kernel's gates, in the order it runs them for a governed call.
  setKernelIAMRuntime(async ({ capability }) => {
    const denied = closed.iamDeny?.includes(capability) === true;
    gates.push(`iam ${capability} ${denied ? "deny" : "allow"}`);
    return denied
      ? {
          outcome: "deny",
          reason: "replay: no grant for this capability",
          principal: null,
        }
      : { outcome: "allow", principal: null };
  }, true);
  setBillingAdmissionGate(async () => {
    gates.push(`billing ${closed.gauExhausted ? "exhausted" : "admit"}`);
    if (closed.gauExhausted)
      throw new GauExhaustedError({
        reason: null,
        remainingGau: 0,
        periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      });
  });
  setBudgetAdmissionGate(async ({ capability }) => {
    gates.push(
      `budget ${capability} ${closed.budgetExceeded ? "exceeded" : "admit"}`,
    );
    if (closed.budgetExceeded)
      throw new BudgetExceededError({
        scope: "workspace",
        orgId: ORG,
        workspaceId: WORKSPACE,
        period: "monthly",
        limitMicros: 50_000_000n,
        spentMicros: 50_000_000n,
        capability,
      });
  });
  for (const [name, output] of Object.entries(fixture.handlers ?? {})) {
    registerHandler(name, async () => async () => {
      gates.push(`handler ${name}`);
      return output;
    });
  }
  const switchedOff = closed.killSwitch ?? [];
  readActiveEmergencyDenies.mockImplementation(async () => {
    gates.push(`emergency_denies ${switchedOff.join(" ") || "none"}`);
    return switchedOff.map((capabilityId) => ({
      publicId: `edn_${capabilityId}`,
      denyKind: "capability",
      capabilityId,
      resourceScopeDigest: null,
      principalId: null,
      reason: "replay: switched off for the set",
    }));
  });
  const killSwitchGate: KillSwitchGate = {
    check: async ({ capabilityId }) => {
      const hit =
        switchedOff.includes(capabilityId) ||
        closed.killSwitchMidTurn?.includes(capabilityId) === true;
      gates.push(`kill_switch ${capabilityId} ${hit ? "hit" : "open"}`);
      return hit ? killSwitchRow(capabilityId) : null;
    },
  };
  createApprovalRequest.mockImplementation(
    async (args: { capabilityName: string }) => {
      gates.push(`approval ${args.capabilityName} opened`);
      return {
        approvalId: "1e6b6273-8f90-41a2-9314-2f3041526375",
        approvalPublicId: "apr_replay1",
        expiresAt: new Date("2026-09-24T12:05:00.000Z"),
      };
    },
  );
  streamAgentReply.mockReset();
  for (const completion of completionsFor(fixture.frames))
    streamAgentReply.mockImplementationOnce(() => fakeStream(completion));

  const ctx: CapabilityContext = {
    orgId: ORG,
    workspaceId: WORKSPACE,
    userId: USER,
    apiKeyId: null,
    requestId: "req_replay",
    surface: "app",
    messageId: MESSAGE,
    executionStepId: MESSAGE,
  };
  const materialised = await materializeTools(ctx, {
    runIdRef: { current: "0d5a5162-7e8f-4091-8203-1e2f30415264" },
    excludeCapabilities: new Set([SEARCH_TOOLS, LOAD_TOOLS]),
    onApprovalRequired: (event) => approvals.push(event.capability),
    approvalMode: "park",
    killSwitchGate,
  });
  const pinned = new Set<string>(INTERACTIVE_AGENT_CAPABILITIES);
  const belt = createToolBelt({
    tools: materialised.tools,
    pinned: Object.entries(materialised.nameMap)
      .filter(([, real]) => pinned.has(real))
      .map(([alias]) => alias),
    modelId: MODEL,
  });

  const engine = new FakeEngine();
  engine.scriptTurn(fixture.frames);
  const client = new StellaEngineClient({
    baseUrl: "http://engine.test",
    token: "fake-token",
    fetchImpl: engine.fetch,
  });
  const recorder: TurnLedger = {
    modelCallStarted: async () => undefined,
    modelCall: async (record) => {
      ledger.push(`model ${record.outcome}`);
    },
    toolCallStarted: async () => undefined,
    toolCall: async (record) => {
      ledger.push(
        [`tool ${record.toolName} ${record.outcome}`, record.approvalPublicId]
          .filter(Boolean)
          .join(" "),
      );
    },
    seal: async (outcome: TurnLedgerOutcome) => {
      ledger.push(`seal ${outcome.status}`);
    },
  };
  const result = await runGovernedTurn({
    telemetry: {
      orgId: ORG,
      workspaceId: WORKSPACE,
      surface: "app",
      messageId: MESSAGE,
      userId: USER,
    },
    model: { modelId: MODEL } as never,
    system: "replay",
    history: [],
    instruction: fixture.question,
    tools: belt.tools,
    modelTools: belt.modelTools,
    governance: { ...materialised.governance, ...belt.governance },
    mutatingToolNames: materialised.mutatingToolNames,
    toolNameMap: materialised.nameMap,
    principal: USER,
    ledger: recorder,
    engine: client,
  });
  const parts: Array<{ type: string } & Record<string, unknown>> = [];
  for await (const part of result.fullStream)
    parts.push(part as { type: string } & Record<string, unknown>);
  const answer = await result.finalText;

  return {
    answer,
    parts,
    gates,
    ledger,
    approvals,
    engine,
  };
}

const fixtures = loadFixtures();

describe("assistant replay set", () => {
  beforeEach(() => {
    clearHandlersForTests();
    insertToolInvocation.mockClear();
    createApprovalRequest.mockReset();
    waitForApproval.mockReset();
    readActiveEmergencyDenies.mockReset();
  });
  afterEach(() => {
    clearKernelIAMRuntime();
    clearBillingAdmissionGate();
    clearBudgetAdmissionGate();
    clearHandlersForTests();
  });

  it("holds between 10 and 20 turns, each named once", () => {
    const names = fixtures.map(({ fixture }) => fixture.turn);
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names.length).toBeLessThanOrEqual(20);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(
    fixtures.map(({ file, fixture }) => [fixture.turn, file, fixture] as const),
  )("replays %s", async (_name, file, fixture) => {
    const run = await replay(fixture);
    const want = fixture.expect;

    // One object, one assertion: a failing fixture shows every field that
    // moved, not only the first.
    const observed: ReplayFixture["expect"] = {
      tools: run.parts
        .filter((p) => p.type === "tool-call")
        .map((p) => String(p.toolName)),
      gates: run.gates,
      ledger: run.ledger,
      answers: run.engine.posts
        .filter((post) => post.route === "tool-result")
        .map((post) => answerClass(post.body)),
      refusals: run.parts
        .filter((p) => p.type === "tool-error")
        .map((p) => (p.error as { code?: string }).code ?? "uncoded"),
      invocations: insertToolInvocation.mock.calls.map((call) => {
        const row = (call as unknown[])[0] as {
          capability_name: string;
          status: string;
          error_class: string | null;
        };
        return [row.capability_name, row.status, row.error_class]
          .filter((v) => v !== null && v !== "")
          .join(" ");
      }),
      approvals: run.approvals,
      answer: run.answer,
    };
    if (want.loadUnknown) {
      observed.loadUnknown = run.parts
        .filter((p) => p.type === "tool-result" && p.toolName === LOAD_TOOLS)
        .flatMap((p) => (p.output as { unknown?: string[] }).unknown ?? []);
    }
    if (process.env.REPLAY_DEBUG) {
      console.log(
        JSON.stringify(
          { observed, posts: run.engine.posts, parts: run.parts },
          null,
          1,
        ),
      );
    }
    if (process.env.REPLAY_UPDATE) {
      // Re-pin: write what this turn produced into the fixture, then read
      // the diff before committing it. README.md says when to use this.
      writeFileSync(
        file,
        `${JSON.stringify({ ...fixture, expect: observed }, null, 2)}\n`,
      );
      return;
    }
    expect(observed).toEqual(want);
  });
});
