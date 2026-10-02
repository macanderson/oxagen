// steering.propose.test.ts: propose_steering over a fake proposer and a fake
// opener, and the PR it opens checked by the real steering checks on the
// fixture steering repo (packages/oxagen/fixtures/steering-repo/repo).
import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ assertContractRole: vi.fn() }));
vi.mock("./lib/capability-role-guard", () => guard);
// steering-repo/propose.ts loads the steering PR opener. Its host and logger stay out of these tests.
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("./context.steering.host", () => ({
  createSteeringHost: vi.fn(() => {
    throw new Error("each test passes its own opener");
  }),
}));

import { HandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { steeringPropose } from "@oxagen/oxagen/contracts/steering.propose";
import { fixtureContext, fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { readSteeringRecord } from "@oxagen/oxagen/steering-repo/record";
import { runChecks } from "@oxagen/steering-check";
import { createSteeringProposeHandler, type SteeringProposeDeps } from "./steering.propose";
import type { ProposingAgent } from "./steering.proposer";
import type { ToolsPullRequestArgs, ToolsPullRequestScope } from "./tools.pr.open";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac3f";
const NOW = new Date("2026-10-02T15:30:12.000Z");
const AGENT: ProposingAgent = { agent: "a-intel.core.ci-reviewer", run: "tse_01K5QK7D" };

const CTX = {
  orgId: ORG,
  workspaceId: WS,
  userId: null,
  apiKeyId: "key_gateway",
  requestId: "req_1",
  surface: "mcp",
  messageId: null,
  gatewaySessionUuid: "0b8f5c1e-7d2a-4f3b-9c6e-1a2b3c4d5e6f",
} satisfies CapabilityContext;

const PATH = "steering/billing/a-intel.billing.ask-before-refunds.md";
const RECORD = [
  "---",
  "schema: steering-record/v1",
  "lineage: a-intel.billing.ask-before-refunds",
  "label: Ask before refunds",
  "description: Refunds wait for a person's approval in the run.",
  "kind: business-rule",
  "force: must",
  "scope: workspace",
  "status: active",
  "origin: inferred",
  "---",
  "",
  "Ask a person before you refund a customer.",
  "",
].join("\n");

function input(overrides: Partial<ReturnType<typeof steeringPropose.input.parse>> = {}) {
  return steeringPropose.input.parse({
    title: "Ask before refunds",
    rationale: "Two runs refunded $240 without asking.",
    evidence: [88],
    files: [{ path: PATH, content: RECORD }],
    ...overrides,
  });
}

function rig(proposer: ProposingAgent | null = AGENT) {
  const opened: { scope: ToolsPullRequestScope; args: ToolsPullRequestArgs }[] = [];
  const deps: SteeringProposeDeps = {
    proposer: vi.fn(async () => proposer),
    opener: {
      open: vi.fn(async (scope: ToolsPullRequestScope, args: ToolsPullRequestArgs) => {
        opened.push({ scope, args });
        return {
          number: 42,
          url: "https://github.com/a-intel/oxagen-core-platform/pull/42",
          branch: args.branch,
          headSha: "3333333333333333333333333333333333333333",
        };
      }),
    },
    now: () => NOW,
  };
  return { deps, opened, handler: createSteeringProposeHandler(deps) };
}

/** The HandlerError a rejected call carries. */
async function refusal(promise: Promise<unknown>): Promise<HandlerError> {
  const err = await promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (caught: unknown) => caught,
  );
  if (!(err instanceof HandlerError)) throw err;
  return err;
}

beforeEach(() => {
  guard.assertContractRole.mockReset();
  guard.assertContractRole.mockResolvedValue("Member");
});

describe("propose_steering", () => {
  it("opens a PR with the record's provenance written from the agent and run", async () => {
    const { handler, opened } = rig();
    const out = await handler(input(), CTX);

    expect(out).toEqual({
      number: 42,
      url: "https://github.com/a-intel/oxagen-core-platform/pull/42",
      branch: "steering/propose-a-intel.billing.ask-before-refunds-20261002t153012",
      head_sha: "3333333333333333333333333333333333333333",
      agent: "a-intel.core.ci-reviewer",
      run: "tse_01K5QK7D",
    });
    expect(opened).toHaveLength(1);
    const [{ scope, args }] = opened as [(typeof opened)[number]];
    expect(scope).toEqual({ orgId: ORG, workspaceId: WS });
    expect(args.title).toBe("Ask before refunds");
    expect(args.commitMessage).toBe(
      "Ask before refunds\n\nProposed by a-intel.core.ci-reviewer from run tse_01K5QK7D.",
    );
    expect(args.body).toContain("## Rationale\n\nTwo runs refunded $240 without asking.");
    expect(args.body).toContain("`frame:tse_01K5QK7D/88`");

    const [file] = args.files;
    expect(file?.path).toBe(PATH);
    const read = readSteeringRecord(file?.content ?? "");
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.record.provenance).toEqual({
        source: "proposal",
        uri: "oxagen:run/tse_01K5QK7D",
        agent: "a-intel.core.ci-reviewer",
      });
    }
  });

  it("opens a PR the real steering checks pass on the fixture steering repo", async () => {
    const { handler, opened } = rig();
    await handler(input(), CTX);
    const base = fixtureRepo();
    const head = new Map(base);
    for (const file of opened[0]?.args.files ?? []) head.set(file.path, file.content as string);
    const { runtimes, members, teams, groups, credentials } = fixtureContext();
    const report = runChecks({
      files: head,
      base,
      index: null,
      context: { runtimes, members, teams, groups, credentials },
      health: null,
    });
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("checks the caller's role before it looks for the agent", async () => {
    const { handler, deps } = rig();
    guard.assertContractRole.mockRejectedValue(
      new HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    const err = await refusal(handler(input(), CTX));
    expect(err.reason).toBe("org_role_required");
    expect(guard.assertContractRole).toHaveBeenCalledWith(steeringPropose, CTX);
    expect(deps.proposer).not.toHaveBeenCalled();
  });

  it("refuses a request that resolves to no agent, and opens nothing", async () => {
    const { handler, deps } = rig(null);
    const err = await refusal(handler(input(), CTX));
    expect(err).toMatchObject({ code: "forbidden", reason: "no_proposing_agent" });
    expect(deps.opener.open).not.toHaveBeenCalled();
  });

  it("refuses an agent with no run Oxagen watched, since each record names its run", async () => {
    const { handler, deps } = rig({ agent: AGENT.agent, run: null });
    const err = await refusal(handler(input(), CTX));
    expect(err).toMatchObject({ code: "forbidden", reason: "no_watched_run" });
    expect(deps.opener.open).not.toHaveBeenCalled();
  });

  it("refuses a file only Oxagen writes", async () => {
    const { handler, deps } = rig();
    const files = [{ path: "tools/servers/billing/tools.lock.json", content: "{}\n" }];
    const err = await refusal(handler(input({ files }), CTX));
    expect(err).toMatchObject({ code: "conflict", reason: "oxagen_owned_path" });
    expect(deps.opener.open).not.toHaveBeenCalled();
  });

  it("refuses a record that names its own agent, as forbidden", async () => {
    const { handler, deps } = rig();
    const content = RECORD.replace(
      "origin: inferred\n",
      "origin: inferred\nprovenance:\n  source: proposal\n  uri: x\n  agent: a-intel.core.release-bot\n",
    );
    const err = await refusal(handler(input({ files: [{ path: PATH, content }] }), CTX));
    expect(err).toMatchObject({ code: "forbidden", reason: "provenance_claimed" });
    expect(deps.opener.open).not.toHaveBeenCalled();
  });

  it("refuses a record that types id", async () => {
    const { handler } = rig();
    const content = RECORD.replace("origin: inferred\n", "origin: inferred\nid: rec_x_000000000000\n");
    const err = await refusal(handler(input({ files: [{ path: PATH, content }] }), CTX));
    expect(err).toMatchObject({ code: "conflict", reason: "record_identity_typed" });
  });

  it("refuses files that span two folders", async () => {
    const { handler, deps } = rig();
    const files = [
      { path: PATH, content: RECORD },
      { path: "policy/money.cedar", content: "permit(principal, action, resource);\n" },
    ];
    const err = await refusal(handler(input({ files }), CTX));
    expect(err).toMatchObject({ code: "conflict", reason: "branch_scope" });
    expect(deps.opener.open).not.toHaveBeenCalled();
  });

  it("writes a policy file and a deletion as given, in path order", async () => {
    const { handler, opened } = rig();
    const cedar = "permit(principal, action, resource);\n";
    const files = [
      { path: "policy/money.tests.jsonl", content: null },
      { path: "policy/money.cedar", content: cedar },
    ];
    await handler(input({ files }), CTX);
    expect(opened[0]?.args.files).toEqual([
      { path: "policy/money.cedar", content: cedar },
      { path: "policy/money.tests.jsonl", content: null },
    ]);
    expect(opened[0]?.args.branch).toBe("policy/propose-money-20261002t153012");
  });

  it("deletes a record without reading it", async () => {
    const { handler, opened } = rig();
    await handler(input({ files: [{ path: PATH, content: null }] }), CTX);
    expect(opened[0]?.args.files).toEqual([{ path: PATH, content: null }]);
  });
});
