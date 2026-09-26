/**
 * `oxagen agent …` output-discipline tests. Mocks the shared API client so no
 * network is needed; asserts each command posts the contract input to its
 * route, --json emits the exact payload, pretty mode prints the credential
 * once and the tables, a bad flag fails fast without a call (exit 2), and an
 * API failure routes to stderr (exit 1).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({
  apiPostOrThrow: vi.fn(),
  printTable: vi.fn(
    (
      headers: string[],
      rows: string[][],
      writer: { write(l: string): void },
    ) => {
      writer.write(headers.join(" | "));
      for (const row of rows) writer.write(row.join(" | "));
    },
  ),
}));

import {
  agentRegister,
  agentStatus,
  agentUnenroll,
  type AgentGetResult,
  type AgentRegisterResult,
} from "../agent.js";
import { apiPostOrThrow } from "../../lib/api.js";

function memoryWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => {
        out.push(line);
      },
      writeErr: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
}

const RUNTIME = {
  id: "rtm_0123456789abcdefghjkmn",
  name: "Mac's laptop",
  slug: "macs-laptop",
};
const BELT = {
  id: "tbt_0123456789abcdefghjkmn",
  name: "All tools",
  slug: "all-tools",
  kind: "all_tools" as const,
};

const REGISTERED: AgentRegisterResult = {
  agentId: "agt_0123456789abcdefghjkmn",
  slug: "release-bot",
  agentKey: "acme.core.release-bot",
  principalId: "prn_0123456789abcdefghjkmn",
  runtime: RUNTIME,
  toolbelt: BELT,
  version: 1,
  credential: {
    id: "aky_0123456789abcdefghjkmn",
    secret: "ox_supersecretvalue",
    expiresAt: "2027-03-13T00:00:00.000Z",
  },
};

const AGENT: AgentGetResult = {
  identity: {
    id: "agt_0123456789abcdefghjkmn",
    slug: "release-bot",
    name: "Release bot",
    agentKey: "acme.core.release-bot",
    harness: "stella",
    principalId: "prn_0123456789abcdefghjkmn",
    operatorId: "usr_0123456789abcdefghjkmn",
    status: "enrolled",
    registeredAt: "2026-09-13T10:00:00.000Z",
    firstFrameAt: null,
    costCenter: null,
  },
  credentials: [
    {
      id: "aky_0123456789abcdefghjkmn",
      name: "agent credential release-bot",
      prefix: "ox_abcdefghi",
      createdAt: "2026-09-13T10:00:00.000Z",
      expiresAt: "2027-03-13T00:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    },
  ],
  roles: [
    {
      id: "rol_1",
      name: "AgentDefault",
      scopeKind: "workspace",
      expiresAt: null,
    },
  ],
  hosts: [
    {
      hostEnrollmentId: "tch_live",
      hostname: "build-1",
      platform: "linux",
      status: "active",
      mode: "observe",
      harnesses: ["claude-code"],
      collectorVersion: "1.2.0",
      hooksOk: true,
      lastSeenAt: "2026-09-14T09:00:00.000Z",
      revokedAt: null,
    },
    {
      hostEnrollmentId: "tch_old",
      hostname: "laptop",
      platform: "darwin",
      status: "revoked",
      mode: "observe",
      harnesses: [],
      collectorVersion: null,
      hooksOk: null,
      lastSeenAt: null,
      revokedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  runtime: RUNTIME,
  toolbelt: BELT,
  versions: [
    {
      version: 1,
      changeKind: "registered",
      runtime: RUNTIME,
      toolbelt: BELT,
      createdAt: "2026-09-13T10:00:00.000Z",
    },
  ],
  limits: {
    perRun: null,
    perDay: null,
    containmentRequired: false,
    invalid: false,
  },
};

const postMock = apiPostOrThrow as unknown as Mock;

beforeEach(() => {
  postMock.mockReset();
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
});

describe("oxagen agent register", () => {
  it("posts the contract input and prints the credential once in pretty mode", async () => {
    postMock.mockResolvedValue(REGISTERED);
    const { writer, out } = memoryWriter();
    await agentRegister(
      {
        name: "Release bot",
        harness: "stella",
        runtime: RUNTIME.id,
        validityDays: "30",
      },
      writer,
    );
    // No --slug and no --toolbelt: the server derives the slug and gives the
    // agent the All tools belt (ADR-192).
    expect(postMock).toHaveBeenCalledWith("agents/register", {
      name: "Release bot",
      harness: "stella",
      runtimeId: RUNTIME.id,
      validityDays: 30,
    });
    const text = out.join("\n");
    expect(text).toContain("ox_supersecretvalue");
    expect(text).toContain("shown once");
    expect(text).toContain("Mac's laptop (macs-laptop)");
    expect(text).not.toContain(".toml");
    expect(process.exitCode).toBeUndefined();
  });

  it("forwards a typed slug and toolbelt", async () => {
    postMock.mockResolvedValue(REGISTERED);
    const { writer } = memoryWriter();
    await agentRegister(
      {
        name: "Release bot",
        harness: "stella",
        runtime: RUNTIME.id,
        slug: "release-bot",
        toolbelt: BELT.id,
      },
      writer,
    );
    expect(postMock).toHaveBeenCalledWith("agents/register", {
      name: "Release bot",
      harness: "stella",
      runtimeId: RUNTIME.id,
      slug: "release-bot",
      toolbeltId: BELT.id,
    });
  });

  it("--json emits the exact payload", async () => {
    postMock.mockResolvedValue(REGISTERED);
    const { writer, out } = memoryWriter();
    await agentRegister(
      {
        name: "Release bot",
        harness: "stella",
        runtime: RUNTIME.id,
        json: true,
      },
      writer,
    );
    expect(out).toEqual([JSON.stringify(REGISTERED)]);
  });

  const BASE = { name: "x", harness: "stella", runtime: RUNTIME.id };
  it.each([
    ["slug", { ...BASE, slug: "Release Bot" }],
    ["harness", { ...BASE, harness: "langchain" }],
    ["validity", { ...BASE, validityDays: "400" }],
    ["name", { harness: "stella", runtime: RUNTIME.id }],
    ["runtime", { name: "x", harness: "stella" }],
    ["runtime id", { ...BASE, runtime: "macs-laptop" }],
    ["toolbelt id", { ...BASE, toolbelt: "all-tools" }],
  ])("a bad %s fails fast without a call (exit 2)", async (_what, opts) => {
    const { writer, err } = memoryWriter();
    await agentRegister(opts, writer);
    expect(postMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(err.length).toBeGreaterThan(0);
  });

  it("an API failure goes to stderr with exit 1", async () => {
    postMock.mockRejectedValue(new Error("Forbidden: org role required"));
    const { writer, err, out } = memoryWriter();
    await agentRegister(
      { name: "x", harness: "stella", runtime: RUNTIME.id },
      writer,
    );
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("org role required");
    expect(process.exitCode).toBe(1);
  });
});

describe("oxagen agent status", () => {
  it("reads get_agent by id or slug and renders the identity with its tables", async () => {
    postMock.mockResolvedValue(AGENT);
    const { writer, out } = memoryWriter();
    await agentStatus("release-bot", {}, writer);
    expect(postMock).toHaveBeenCalledWith("agents/get", {
      agentId: "release-bot",
    });
    const text = out.join("\n");
    expect(text).toContain("Release bot (release-bot) — enrolled");
    expect(text).toContain("aky_0123456789abcdefghjkmn | ox_abcdefghi");
    expect(text).toContain("tch_live | build-1 | active | observe | ok");
    expect(text).toContain("runtime     Mac's laptop (macs-laptop)");
    expect(text).toContain("toolbelt    All tools");
    expect(text).toContain("1 | registered | macs-laptop | all-tools");
    // The secret never appears in a status read: the wire carries the prefix only.
    expect(text).not.toContain("ox_supersecretvalue");
  });

  it("--json emits the exact payload", async () => {
    postMock.mockResolvedValue(AGENT);
    const { writer, out } = memoryWriter();
    await agentStatus("agt_0123456789abcdefghjkmn", { json: true }, writer);
    expect(out).toEqual([JSON.stringify(AGENT)]);
  });
});

describe("oxagen agent unenroll", () => {
  it("revokes every live host of the agent through revoke_tacho_enrollment, skipping revoked ones", async () => {
    postMock.mockImplementation(
      async (path: string, body: { hostEnrollmentId?: string }) =>
        path === "agents/get"
          ? AGENT
          : {
              hostEnrollmentId: body.hostEnrollmentId,
              status: "revoked",
              revokedAt: "2026-09-14T10:00:00.000Z",
            },
    );
    const { writer, out } = memoryWriter();
    await agentUnenroll("release-bot", { reason: "laptop lost" }, writer);
    expect(postMock.mock.calls.map((c) => c[0])).toEqual([
      "agents/get",
      "tacho/enrollments/revoke",
    ]);
    expect(postMock.mock.calls[1]![1]).toEqual({
      hostEnrollmentId: "tch_live",
      reason: "laptop lost",
    });
    expect(out).toEqual(["Revoked tch_live at 2026-09-14T10:00:00.000Z."]);
  });

  it("--host narrows to one live host and refuses a host the agent does not hold", async () => {
    postMock.mockImplementation(async (path: string) =>
      path === "agents/get"
        ? AGENT
        : { hostEnrollmentId: "tch_live", status: "revoked", revokedAt: "t" },
    );
    const { writer, err } = memoryWriter();
    await agentUnenroll("release-bot", { host: "tch_old" }, writer);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(2);
    expect(err.join("\n")).toContain("not a live host");
  });

  it("--json emits the agent id and the revocations", async () => {
    postMock.mockImplementation(async (path: string) =>
      path === "agents/get"
        ? AGENT
        : { hostEnrollmentId: "tch_live", status: "revoked", revokedAt: "t" },
    );
    const { writer, out } = memoryWriter();
    await agentUnenroll("release-bot", { json: true }, writer);
    expect(JSON.parse(out[0]!)).toEqual({
      agentId: AGENT.identity.id,
      revoked: [
        { hostEnrollmentId: "tch_live", status: "revoked", revokedAt: "t" },
      ],
    });
  });

  it("an agent with no live host answers so without a revoke call", async () => {
    postMock.mockResolvedValue({ ...AGENT, hosts: [AGENT.hosts[1]] });
    const { writer, out } = memoryWriter();
    await agentUnenroll("release-bot", {}, writer);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(out).toEqual(["release-bot has no live host to unenroll."]);
  });
});
