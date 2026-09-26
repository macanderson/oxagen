// The runtimes port: `list` walks `list_tacho_hosts` to the end of its cursor
// under a bound and maps each enrollment, `agents` walks `list_agents` until
// every key asked for is found, and `named` reads `list_runtimes` (ADR-192). A
// refusal passes through, an unmappable record
// is reported once, and a tier looked up from a harness name is never mapped.
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
import { runtimeList } from "@oxagen/oxagen/contracts/runtime.list";
import { tachoHostList } from "@oxagen/oxagen/contracts/tacho.host.list";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { runtimes } = await import("./runtimes");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

function host(overrides: Record<string, unknown> = {}) {
  return {
    hostEnrollmentId: "tch_mbellmbp16aaaaaaaaaaaaa",
    agentKey: "acme.core.release-manager",
    hostname: "mbell-mbp-16",
    platform: "darwin",
    osVersion: "15.6",
    arch: "arm64",
    osUser: "mbell",
    status: "active",
    mode: "enforce",
    harnesses: ["claude-code"],
    tiers: { "claude-code": "harness" },
    modelBaseUrls: [
      {
        harness: "claude-code",
        key: "ANTHROPIC_BASE_URL",
        ours: true,
        shadowedBy: null,
      },
    ],
    claudeVersionAtEnroll: "2.1.4",
    wrapperVersion: "1.6.2",
    managed: false,
    lastSeenAt: "2026-09-23T09:12:44.000Z",
    lastIngestAt: null,
    hooksOk: true,
    otelOk: true,
    spoolDepth: 0,
    sessionsCount: 4,
    unobservedSessionsCount: 0,
    incidentsOpen: 0,
    expiresAt: "2099-09-01T10:00:00.000Z",
    revokedAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function agentItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "agt_releasemanager",
    slug: "release-manager",
    name: "Release manager",
    agentKey: "acme.core.release-manager",
    harness: "claude-code",
    principalId: "prn_91",
    operatorId: "usr_marcusbell",
    status: "enrolled",
    tier: null,
    beltSize: null,
    runs30d: 212,
    spend30d: null,
    proven30d: null,
    mandates: null,
    incidents: 0,
    credentials: 1,
    hosts: 1,
    registeredAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

const totals = {
  identities: 1,
  enrolled: 1,
  holdingMandate: null,
  tamperIncidents: 0,
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("runtimes.list", () => {
  it("maps an enrollment and never maps the tier looked up from a harness name", async () => {
    kernelRead.mockResolvedValueOnce(
      readOk({ hosts: [host()], nextCursor: null }),
    );
    const read = await runtimes.list(ctx);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: tachoHostList,
      input: { limit: 200 },
      page: "runtimes",
    });
    expect(read).toEqual(
      readOk({
        enrollments: [
          {
            id: "tch_mbellmbp16aaaaaaaaaaaaa",
            hostname: "mbell-mbp-16",
            platform: "darwin",
            osVersion: "15.6",
            arch: "arm64",
            osUser: "mbell",
            status: "active",
            mode: "enforce",
            harnesses: ["claude-code"],
            claudeVersionAtEnroll: "2.1.4",
            collectorVersion: "1.6.2",
            modelRoute: "loopback",
            shadowedBy: null,
            managed: false,
            hooksOk: true,
            lastSeenAt: "2026-09-23T09:12:44.000Z",
            createdAt: "2026-09-01T10:00:00.000Z",
            expiresAt: "2099-09-01T10:00:00.000Z",
            revokedAt: null,
            agentKey: "acme.core.release-manager",
          },
        ],
        more: false,
      }),
    );
  });

  it("reads a direct route with its shadowing file, and an empty report as not reported", async () => {
    kernelRead.mockResolvedValueOnce(
      readOk({
        hosts: [
          host({
            modelBaseUrls: [
              {
                harness: "codex",
                key: "base_url",
                ours: false,
                shadowedBy: "/etc/codex.toml",
              },
            ],
          }),
          host({
            hostEnrollmentId: "tch_otheraaaaaaaaaaaaaaaaaa",
            modelBaseUrls: [],
          }),
        ],
        nextCursor: null,
      }),
    );
    const read = await runtimes.list(ctx);
    if (!read.ok) throw new Error("expected a list");
    expect(
      read.value.enrollments.map((e) => [e.modelRoute, e.shadowedBy]),
    ).toEqual([
      ["direct", "/etc/codex.toml"],
      [null, null],
    ]);
  });

  it("reads loopback only when every harness report names the proxy, and a mixed host as mixed", async () => {
    const claude = {
      harness: "claude-code",
      key: "ANTHROPIC_BASE_URL",
      ours: true,
      shadowedBy: null,
    };
    const codex = {
      harness: "codex",
      key: "base_url",
      ours: false,
      shadowedBy: null,
    };
    kernelRead.mockResolvedValueOnce(
      readOk({
        hosts: [
          host({ modelBaseUrls: [claude, codex] }),
          host({
            hostEnrollmentId: "tch_bothaaaaaaaaaaaaaaaaaaa",
            modelBaseUrls: [claude, { ...claude, harness: "stella" }],
          }),
          host({
            hostEnrollmentId: "tch_neitheraaaaaaaaaaaaaaaa",
            modelBaseUrls: [codex],
          }),
        ],
        nextCursor: null,
      }),
    );
    const read = await runtimes.list(ctx);
    if (!read.ok) throw new Error("expected a list");
    expect(read.value.enrollments.map((e) => e.modelRoute)).toEqual([
      "mixed",
      "loopback",
      "direct",
    ]);
  });

  it("walks the cursor and says when the bound stopped the walk", async () => {
    for (let page = 0; page < 5; page++)
      kernelRead.mockResolvedValueOnce(
        readOk({
          hosts: [
            host({
              hostEnrollmentId: `tch_page${String(page)}aaaaaaaaaaaaaaaaa`,
            }),
          ],
          nextCursor: `c${String(page)}`,
        }),
      );
    const read = await runtimes.list(ctx);
    expect(kernelRead).toHaveBeenCalledTimes(5);
    expect(kernelRead).toHaveBeenLastCalledWith(ctx, {
      contract: tachoHostList,
      input: { limit: 200, cursor: "c3" },
      page: "runtimes",
    });
    if (!read.ok) throw new Error("expected a list");
    expect(read.value.enrollments).toHaveLength(5);
    expect(read.value.more).toBe(true);
  });

  it("passes a refusal through", async () => {
    const denied = { ok: false, reason: "denied", permission: "runtime.read" };
    kernelRead.mockResolvedValueOnce(denied);
    await expect(runtimes.list(ctx)).resolves.toEqual(denied);
  });

  it("reports an unmappable record once", async () => {
    kernelRead.mockResolvedValueOnce(
      readOk({
        hosts: [host({ hostEnrollmentId: "not a public id" })],
        nextCursor: null,
      }),
    );
    await expect(runtimes.list(ctx)).resolves.toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("runtimes.agents", () => {
  it("walks list_agents until every key asked for is found", async () => {
    kernelRead
      .mockResolvedValueOnce(
        readOk({
          items: [
            agentItem({ agentKey: null, id: "agt_unkeyed" }),
            agentItem({ agentKey: "acme.core.other", id: "agt_other" }),
          ],
          nextCursor: "n1",
          totals,
        }),
      )
      .mockResolvedValueOnce(
        readOk({ items: [agentItem()], nextCursor: "n2", totals }),
      );
    const read = await runtimes.agents(ctx, ["acme.core.release-manager"]);
    expect(kernelRead).toHaveBeenCalledTimes(2);
    expect(kernelRead).toHaveBeenLastCalledWith(ctx, {
      contract: agentList,
      input: { limit: 100, cursor: "n1" },
      page: "runtimes",
    });
    expect(read).toEqual(
      readOk({
        agents: [
          {
            id: "agt_releasemanager",
            slug: "release-manager",
            name: "Release manager",
            agentKey: "acme.core.release-manager",
            harness: "claude-code",
            operatorId: "usr_marcusbell",
            principalId: "prn_91",
            runs30d: 212,
          },
        ],
      }),
    );
  });

  it("reads nothing when no key is asked for, and passes a refusal through", async () => {
    await expect(runtimes.agents(ctx, [])).resolves.toEqual(
      readOk({ agents: [] }),
    );
    expect(kernelRead).not.toHaveBeenCalled();
    const error = readError("iam_principals_unavailable", 503);
    kernelRead.mockResolvedValueOnce(error);
    await expect(runtimes.agents(ctx, ["acme.core.x"])).resolves.toEqual(error);
  });
});

describe("runtimes.named (ADR-192)", () => {
  const item = {
    id: "rtm_macslaptop",
    name: "Mac's laptop",
    slug: "macs-laptop",
    createdAt: "2026-09-20T10:00:00.000Z",
    agents: [
      {
        id: "agt_macclaude",
        name: "Mac Claude",
        slug: "mac-claude",
        harness: "claude-code",
      },
    ],
    liveHosts: 1,
    lastSeenAt: null,
  };

  it("reads list_runtimes once and maps each runtime with its agents", async () => {
    kernelRead.mockResolvedValueOnce(readOk({ items: [item] }));
    const read = await runtimes.named(ctx);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: runtimeList,
      input: {},
      page: "runtimes",
    });
    expect(read).toEqual(readOk({ runtimes: [item] }));
  });

  it("passes a refusal through and reports a record it cannot map (negative)", async () => {
    const error = readError("runtimes_unavailable", 503);
    kernelRead.mockResolvedValueOnce(error);
    await expect(runtimes.named(ctx)).resolves.toEqual(error);
    kernelRead.mockResolvedValueOnce(
      readOk({ items: [{ ...item, id: "not an id" }] }),
    );
    await expect(runtimes.named(ctx)).resolves.toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});
