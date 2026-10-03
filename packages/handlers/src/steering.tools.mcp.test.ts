// steering.tools.mcp.test.ts: the steering tools an agent calls on Oxagen's
// MCP server, invoked through the kernel on the mcp surface, the way
// apps/mcp/src/tools calls them, against fakes (#5134).
//
// The handlers are the ones register.ts loads. The steering repo's host, the
// published version store, the steering checks' reads, and the role gate are
// fakes, and the MCP server's agent resolver is a fake registered through
// steering.proposer.ts the way apps/mcp/src/middleware.ts registers the real
// one. search_steering and read_steering read version 21 of the workspace
// fixture and version 4 of the organization fixture (steering.test-support.ts)
// through a fake of the version store port steering.published.ts binds.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delivery } from "@oxagen/steering-bundle";

const fakes = vi.hoisted(() => ({
  host: null as unknown,
  assertContractRole: vi.fn(),
  delivery: null as Delivery | null,
  readFile: null as null | ((...args: unknown[]) => Promise<string>),
  published: vi.fn(),
}));

vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: fakes.assertContractRole }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("./context.steering.host", () => ({
  createSteeringHost: vi.fn(() => {
    // The opener builds its host once, so each call reads the test's current host.
    // `then` stays undefined, so nothing mistakes the host for a promise.
    return new Proxy(
      {},
      {
        get: (_target, method) =>
          method === "then" || typeof method !== "string"
            ? undefined
            : (...args: unknown[]) =>
                (fakes.host as Record<string, (...a: unknown[]) => unknown>)[method]?.(...args),
      },
    );
  }),
}));
// The port steering.published.ts binds the two read tools to. It answers the
// fixture versions, and records each scope it was asked for.
vi.mock("./tacho.published", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tacho.published")>()),
  VERSION_STORE_PUBLISHED: {
    published: async (scope: unknown) => {
      fakes.published(scope);
      if (fakes.delivery === null) throw new Error("the fixture versions are not built yet");
      return fakes.delivery;
    },
    readAsset: async (...args: unknown[]) => {
      if (fakes.readFile === null) throw new Error("the fixture reader is not set");
      return fakes.readFile(...args);
    },
  },
}));
vi.mock("./tacho.published.postgres", () => ({
  postgresTachoPublished: {
    published: vi.fn(async () => ({ workspace: null, organization: null })),
    readAsset: vi.fn(async () => {
      throw new Error("no asset read in these tests");
    }),
  },
}));
vi.mock("./context.steering.index.get", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context.steering.index.get")>()),
  readCheckContext: vi.fn(async () => ({
    runtimes: [],
    members: [],
    teams: [],
    groups: [],
    credentials: [],
  })),
}));
vi.mock("./context.steering.checks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context.steering.checks")>()),
  checkSteeringChange: vi.fn(async () => ({ passed: true, results: [], findings: [] })),
  steeringTreeHost: vi.fn(() => ({})),
}));

import {
  CapabilityError,
  clearBillingAdmissionGate,
  clearKernelIAMRuntime,
  clearSecurityEventEmitter,
  getCapability,
  getSurfaces,
  hasHandler,
  invoke,
  type CapabilityContext,
} from "@oxagen/oxagen";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { GOVERNANCE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import { readSteeringRecord } from "@oxagen/oxagen/steering-repo/record";
import type { SteeringRepository } from "./context.steering.github";
import { registerProposingAgentResolver } from "./steering.proposer";
import { fixtureDelivery, readFixtureFile } from "./steering.test-support";
import type { ToolsPullRequestHost } from "./tools.pr.open";

await import("./register");

beforeAll(async () => {
  fakes.delivery = await fixtureDelivery();
  fakes.readFile = readFixtureFile as (...args: unknown[]) => Promise<string>;
});

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac3f";
const HEAD = "1111111111111111111111111111111111111111";
const NEW_SHA = "3333333333333333333333333333333333333333";
const REPO = fixtureRepo();

const CTX: CapabilityContext = {
  orgId: ORG,
  workspaceId: WS,
  userId: null,
  apiKeyId: "key_gateway",
  requestId: "req_1",
  surface: "mcp",
  messageId: null,
  gatewaySessionUuid: "0b8f5c1e-7d2a-4f3b-9c6e-1a2b3c4d5e6f",
};

const STEERING_REPO: SteeringRepository = {
  provider: "github",
  owner: "a-intel",
  repo: "oxagen-core-platform",
  fullName: "a-intel/oxagen-core-platform",
  currentFullName: "a-intel/oxagen-core-platform",
  defaultBranch: "main",
};

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

const INPUT = {
  title: "Ask before refunds",
  rationale: "Two runs refunded $240 without asking.",
  evidence: [88],
  files: [{ path: PATH, content: RECORD }],
};

/** A steering repo whose production branch is the fixture repo. */
function steeringHost() {
  const branches = new Map([["main", HEAD]]);
  const host: ToolsPullRequestHost = {
    resolveRepository: vi.fn(async () => STEERING_REPO),
    readFile: vi.fn(async (_repo: SteeringRepository, path: string) =>
      path === GOVERNANCE_TOML_PATH ? (REPO.get(path) ?? null) : null,
    ),
    listFiles: vi.fn(async () => []),
    branchHead: vi.fn(async (_repo: SteeringRepository, branch: string) => branches.get(branch) ?? null),
    ensureBranch: vi.fn(async (_repo: SteeringRepository, branch: string) => {
      branches.set(branch, HEAD);
    }),
    deleteBranch: vi.fn(async () => undefined),
    commitFiles: vi.fn(async () => ({ sha: NEW_SHA })),
    openPullRequest: vi.fn(async () => ({
      number: 42,
      htmlUrl: "https://github.com/a-intel/oxagen-core-platform/pull/42",
    })),
    updatePullRequest: vi.fn(async () => ({ number: 42, htmlUrl: "" })),
    findOpenPullRequest: vi.fn(async () => null),
    reportCheckRun: vi.fn(async () => "https://github.com/a-intel/oxagen-core-platform/runs/1"),
    // The branch holds the production head, so the two share it.
    mergeBase: vi.fn(async (_repo: SteeringRepository, _head: string, base: string) => base),
  };
  return host;
}

let host: ToolsPullRequestHost;

beforeEach(() => {
  clearKernelIAMRuntime();
  clearBillingAdmissionGate();
  clearSecurityEventEmitter();
  fakes.assertContractRole.mockReset();
  fakes.assertContractRole.mockResolvedValue("Member");
  fakes.published.mockClear();
  host = steeringHost();
  fakes.host = host;
  registerProposingAgentResolver(async (ctx) =>
    ctx.apiKeyId === "key_gateway" ? { agent: "a-intel.core.ci-reviewer", run: "tse_01K5QK7D" } : null,
  );
});

afterEach(() => {
  registerProposingAgentResolver(null);
});

describe("propose_steering on the mcp surface", () => {
  it("is a registered capability on the mcp surface, with a handler", () => {
    const cap = getCapability("propose_steering");
    expect(cap?.name).toBe("propose_steering");
    expect(getSurfaces(cap as NonNullable<typeof cap>)).toEqual(["mcp"]);
    expect(hasHandler("propose_steering")).toBe(true);
  });

  it("opens a steering PR whose record names the agent and run the MCP server resolved", async () => {
    const out = await invoke("propose_steering", INPUT, CTX, { surface: "mcp" });
    expect(out).toEqual({
      number: 42,
      url: "https://github.com/a-intel/oxagen-core-platform/pull/42",
      branch: expect.stringMatching(/^steering\/propose-a-intel\.billing\.ask-before-refunds-\d{8}t\d{6}$/),
      head_sha: NEW_SHA,
      agent: "a-intel.core.ci-reviewer",
      run: "tse_01K5QK7D",
    });
    expect(host.commitFiles).toHaveBeenCalledTimes(1);
    const [, commit] = vi.mocked(host.commitFiles).mock.calls[0] as unknown as [
      SteeringRepository,
      { branch: string; parent: string; files: { path: string; content: string | null }[] },
    ];
    expect(commit.parent).toBe(HEAD);
    const read = readSteeringRecord(commit.files[0]?.content ?? "");
    expect(read.ok && read.record.provenance).toEqual({
      source: "proposal",
      uri: "oxagen:run/tse_01K5QK7D",
      agent: "a-intel.core.ci-reviewer",
    });
    expect(host.reportCheckRun).toHaveBeenCalledWith(
      STEERING_REPO,
      expect.objectContaining({ name: "Oxagen steering", headSha: NEW_SHA, conclusion: "success" }),
    );
  });

  it("refuses a caller the MCP server resolves to no agent, and touches no repository", async () => {
    const call = invoke("propose_steering", INPUT, { ...CTX, apiKeyId: "key_script" }, { surface: "mcp" });
    await expect(call).rejects.toMatchObject({ code: "forbidden", reason: "no_proposing_agent" });
    expect(host.resolveRepository).not.toHaveBeenCalled();
  });

  it("refuses every call while no resolver is registered", async () => {
    registerProposingAgentResolver(null);
    const call = invoke("propose_steering", INPUT, CTX, { surface: "mcp" });
    await expect(call).rejects.toMatchObject({ code: "forbidden", reason: "no_proposing_agent" });
  });

  it("refuses an agent field in the input, so no caller names its own agent", async () => {
    const call = invoke(
      "propose_steering",
      { ...INPUT, agent: "a-intel.core.release-bot" },
      CTX,
      { surface: "mcp" },
    );
    await expect(call).rejects.toBeInstanceOf(CapabilityError);
    await expect(call).rejects.toMatchObject({ code: "invalid_input" });
    expect(host.commitFiles).not.toHaveBeenCalled();
  });

  it("is not exposed on the api surface", async () => {
    const call = invoke("propose_steering", INPUT, { ...CTX, surface: "api" }, { surface: "api" });
    await expect(call).rejects.toMatchObject({ code: "surface_denied" });
    expect(fakes.assertContractRole).not.toHaveBeenCalled();
  });
});

describe("search_steering on the mcp surface", () => {
  it("is a registered capability on the mcp surface, with a handler", () => {
    const cap = getCapability("search_steering");
    expect(getSurfaces(cap as NonNullable<typeof cap>)).toEqual(["mcp"]);
    expect(hasHandler("search_steering")).toBe(true);
  });

  it("finds a record in the versions published now", async () => {
    const out = (await invoke("search_steering", { query: "refund" }, CTX, { surface: "mcp" })) as {
      workspace_version: number | null;
      organization_version: number | null;
      hits: { lineage: string; source: string }[];
    };
    expect(fakes.published).toHaveBeenCalledWith({ orgId: ORG, workspaceId: WS, runId: null });
    expect(out.workspace_version).toBe(21);
    expect(out.organization_version).toBe(4);
    expect(out.hits).toContainEqual(
      expect.objectContaining({ lineage: "a-intel.domain.refund", source: "workspace" }),
    );
  });

  it("refuses a call that names a run, before it reads a version", async () => {
    const call = invoke("search_steering", { query: "refund" }, { ...CTX, runId: "run_1" }, { surface: "mcp" });
    await expect(call).rejects.toMatchObject({ code: "not_found", reason: "steering_run_versions_unrecorded" });
    expect(fakes.published).not.toHaveBeenCalled();
  });
});

describe("read_steering on the mcp surface", () => {
  it("is a registered capability on the mcp surface, with a handler", () => {
    const cap = getCapability("read_steering");
    expect(getSurfaces(cap as NonNullable<typeof cap>)).toEqual(["mcp"]);
    expect(hasHandler("read_steering")).toBe(true);
  });

  it("reads a record as the model reads it, from the version published now", async () => {
    const out = (await invoke("read_steering", { lineage: "a-intel.domain.refund" }, CTX, {
      surface: "mcp",
    })) as { lineage: string; source: string; version: number; path: string; text: string };
    expect(fakes.published).toHaveBeenCalledWith({ orgId: ORG, workspaceId: WS, runId: null });
    expect(out).toMatchObject({
      lineage: "a-intel.domain.refund",
      source: "workspace",
      version: 21,
      path: "steering/domain/a-intel.domain.refund.md",
    });
    expect(out.text.startsWith("### Refund\n")).toBe(true);
    expect(out.text).not.toContain("schema: steering-record/v1");
  });

  it("refuses a call that names a run, before it reads a version", async () => {
    const call = invoke(
      "read_steering",
      { lineage: "a-intel.domain.refund" },
      { ...CTX, runId: "run_1" },
      { surface: "mcp" },
    );
    await expect(call).rejects.toMatchObject({ code: "not_found", reason: "steering_run_versions_unrecorded" });
    expect(fakes.published).not.toHaveBeenCalled();
  });
});
