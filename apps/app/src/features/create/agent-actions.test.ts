// The agent wizard's two actions through the kernel seam: the viewer and the
// two kernel calls are the fakes. The toolbelt read narrows list_tool_versions
// to what a pick needs and says whether a call parks; propose_agent sends
// exactly the file the operator saw, drops an empty rationale, and hands a
// failed check back as the conflict it was.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireViewer, kernelRead, kernelWrite } = vi.hoisted(() => ({
  requireViewer: vi.fn(),
  kernelRead: vi.fn(),
  kernelWrite: vi.fn(),
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", () => ({ requireViewer }));
vi.mock("@/server/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/kernel")>()),
  kernelRead,
  kernelWrite,
}));

const { agentPropose } = await import("@oxagen/oxagen/contracts/agent.propose");
const { toolVersionList } = await import(
  "@oxagen/oxagen/contracts/tool.version.list"
);
const { proposeAgent, readToolbelt } = await import("./actions");

const CTX = { orgSlug: "acme", wsSlug: "core-platform" };

const version = (over: Record<string, unknown> = {}) => ({
  id: "tlv_1",
  toolId: "tol_1",
  slug: "github__create_pull_request",
  name: "Create pull request",
  description: null,
  version: 3,
  source: "mcp",
  serverId: "mcs_1",
  capabilityId: "mcp.github.create_pull_request",
  readOnly: false,
  riskGrade: "medium",
  classification: {
    sideEffect: "write",
    egress: "third_party",
    consequenceTags: [],
    measures: {},
    dataClasses: [],
  },
  classifiedAt: null,
  schemaOrigin: "imported",
  schemaDigest: "abc",
  enabled: true,
  gate: { kind: "open", switchId: null },
  calls30d: 4,
  updatedAt: "2026-09-19T00:00:00Z",
  ...over,
});

const OPENED = {
  slug: "perf-watch",
  agentKey: "acme.core.perf-watch",
  path: ".oxagen/agents/perf-watch.toml",
  generatedPath: ".claude/agents/perf-watch.md",
  branch: "agents/perf-watch",
  repository: "acme/platform",
  baseRef: "main",
  digest: `sha256:${"a".repeat(64)}`,
  commitSha: "c0ffee",
  pullRequest: {
    number: 526,
    url: "https://github.com/acme/platform/pull/526",
  },
  // Fields the wizard does not show, so the action must not pass them on.
  checks: [],
};

beforeEach(() => {
  requireViewer.mockReset().mockResolvedValue(CTX);
  kernelRead.mockReset();
  kernelWrite.mockReset();
});

describe("readToolbelt", () => {
  it("reads list_tool_versions page by page and keeps what a pick needs", async () => {
    kernelRead.mockResolvedValueOnce({
      ok: true,
      value: {
        items: [
          version(),
          version({
            slug: "stripe__refund",
            name: "Refund",
            version: 1,
            riskGrade: "high",
            classification: {
              sideEffect: "irreversible",
              egress: "third_party",
              consequenceTags: ["moves_money"],
              measures: {},
              dataClasses: [],
            },
            gate: { kind: "killed_class", switchId: "emd_1" },
          }),
          version({ slug: "search", classification: null, riskGrade: "low" }),
        ],
        nextCursor: "c2",
      },
    });
    kernelRead.mockResolvedValueOnce({
      ok: true,
      value: { items: [], nextCursor: null },
    });
    const result = await readToolbelt("acme", "core-platform");
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelRead).toHaveBeenNthCalledWith(1, CTX, {
      contract: toolVersionList,
      input: { limit: 100 },
      page: "tools",
    });
    expect(kernelRead).toHaveBeenNthCalledWith(2, CTX, {
      contract: toolVersionList,
      input: { limit: 100, cursor: "c2" },
      page: "tools",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        tools: [
          {
            slug: "github__create_pull_request",
            name: "Create pull request",
            version: 3,
            riskGrade: "medium",
            sideEffect: "write",
            financial: false,
            killed: false,
          },
          {
            slug: "stripe__refund",
            name: "Refund",
            version: 1,
            riskGrade: "high",
            sideEffect: "irreversible",
            financial: true,
            killed: true,
          },
          {
            slug: "search",
            name: "Create pull request",
            version: 3,
            riskGrade: "low",
            sideEffect: null,
            financial: false,
            killed: false,
          },
        ],
        more: false,
      },
    });
  });

  it("stops at ten pages and says more exist", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: { items: [version()], nextCursor: "next" },
    });
    const result = await readToolbelt("acme", "core-platform");
    expect(kernelRead).toHaveBeenCalledTimes(10);
    expect(result.ok && result.value.tools.length).toBe(10);
    expect(result.ok && result.value.more).toBe(true);
  });

  it("fails the belt when a later page is refused (negative)", async () => {
    kernelRead
      .mockResolvedValueOnce({
        ok: true,
        value: { items: [version()], nextCursor: "c2" },
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: "denied",
        permission: "tool.read",
      });
    expect(await readToolbelt("acme", "core-platform")).toEqual({
      ok: false,
      reason: "denied",
      code: "tool.read",
    });
  });

  it("answers an empty registry with no tools and nothing more (empty)", async () => {
    kernelRead.mockResolvedValue({
      ok: true,
      value: { items: [], nextCursor: null },
    });
    expect(await readToolbelt("acme", "core-platform")).toEqual({
      ok: true,
      value: { tools: [], more: false },
    });
  });

  it("passes a denied read on as denied (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "tool.read",
    });
    expect(await readToolbelt("acme", "core-platform")).toEqual({
      ok: false,
      reason: "denied",
      code: "tool.read",
    });
  });
});

describe("proposeAgent", () => {
  const input = {
    slug: "perf-watch",
    harness: "cursor" as const,
    source: 'schema = "agent-definition/v0.1"\n',
    rationale: "  Watch the performance budget  ",
  };

  it("sends the file as written and returns the pull request", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: OPENED });
    const result = await proposeAgent("acme", "core-platform", input);
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(kernelWrite).toHaveBeenCalledWith(CTX, agentPropose, {
      slug: "perf-watch",
      harness: "cursor",
      source: input.source,
      rationale: "Watch the performance budget",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullRequest.number).toBe(526);
    expect(result.value.agentKey).toBe("acme.core.perf-watch");
    expect(result.value).not.toHaveProperty("checks");
    expect(result.value).not.toHaveProperty("commitSha");
  });

  it("leaves an empty rationale out of the input (empty)", async () => {
    kernelWrite.mockResolvedValue({ ok: true, value: OPENED });
    await proposeAgent("acme", "core-platform", { ...input, rationale: " " });
    const sent: unknown = kernelWrite.mock.calls[0]?.[2];
    expect(sent).not.toHaveProperty("rationale");
  });

  it("hands a failed check back as the conflict it was (negative)", async () => {
    const refusal = { ok: false, reason: "conflict", code: "agent_check_key" };
    kernelWrite.mockResolvedValue(refusal);
    expect(await proposeAgent("acme", "core-platform", input)).toEqual(refusal);
  });
});
