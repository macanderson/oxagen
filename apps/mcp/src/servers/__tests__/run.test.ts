// run.test.ts: the run one MCP request belongs to, and where its operator
// and their role come from (lane M15).
import type { CapabilityContext } from "@oxagen/oxagen/types";
import { describe, expect, it } from "vitest";
import { resolveServedRun, type RunSources, type ServedHost, type ServedSession } from "../run";

const SESSION = "0b8f5c1e-7d2a-4f3b-9c6e-1a2b3c4d5e6f";

function context(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    orgId: "org_1",
    workspaceId: "ws_1",
    userId: null,
    apiKeyId: "key_1",
    requestId: "req_1",
    surface: "mcp",
    messageId: null,
    gatewaySessionUuid: SESSION,
    ...overrides,
  };
}

const ENROLLER = "5a8e2c41-9b7d-4f16-8c3e-0d2f6a1b7e94";

const HOST: ServedHost = {
  id: "host_1",
  publicId: "tch_1",
  runtime: "ci-linux-01",
  operator: ENROLLER,
  operatorRole: "member",
};

interface Asked {
  sessions: Array<{ hostId: string; sessionUuid: string }>;
}

function sources(host: ServedHost | null = HOST, session: ServedSession | null = { publicId: "tse_1", harness: "claude-code" }) {
  const asked: Asked = { sessions: [] };
  const read: RunSources = {
    host: () => Promise.resolve(host),
    session: (_scope, onHost, sessionUuid) => {
      asked.sessions.push({ hostId: onHost.id, sessionUuid });
      return Promise.resolve(session);
    },
  };
  return { read, asked };
}

describe("resolveServedRun", () => {
  it("takes the operator and their role from the key's host and the harness from the named session", async () => {
    const { read } = sources();
    expect(await resolveServedRun(context(), read)).toEqual({
      orgId: "org_1",
      workspaceId: "ws_1",
      requestId: "req_1",
      sessionId: SESSION,
      runtime: "ci-linux-01",
      harness: "claude-code",
      operator: ENROLLER,
      operatorRole: "member",
      machine: "tch_1",
      runPublicId: "tse_1",
    });
  });

  it("looks for the named session only on the key's own host", async () => {
    const { read, asked } = sources();
    await resolveServedRun(context(), read);
    expect(asked.sessions).toEqual([{ hostId: "host_1", sessionUuid: SESSION }]);
  });

  it("keeps the host's role when the header names no session on the host", async () => {
    const { read } = sources(HOST, null);
    const run = await resolveServedRun(context(), read);
    expect(run).toMatchObject({ sessionId: null, harness: null, runPublicId: null, operatorRole: "member" });
  });

  it("leaves the role out when the host's enroller holds none", async () => {
    const { read } = sources({ ...HOST, operatorRole: null });
    const run = await resolveServedRun(context(), read);
    expect(run).not.toBeNull();
    expect(run).not.toHaveProperty("operatorRole");
  });

  it("leaves the operator out when the host records no enroller", async () => {
    const { read } = sources({ ...HOST, operator: null, operatorRole: null });
    const run = await resolveServedRun(context(), read);
    expect(run).not.toBeNull();
    expect(run).not.toHaveProperty("operator");
  });

  it("reads no session for a header that is not a UUID", async () => {
    const { read, asked } = sources();
    const run = await resolveServedRun(context({ gatewaySessionUuid: "not-a-session" }), read);
    expect(asked.sessions).toEqual([]);
    expect(run).toMatchObject({ sessionId: null, harness: null, operatorRole: "member" });
  });

  it("belongs to no run without an API key", async () => {
    const { read } = sources();
    expect(await resolveServedRun(context({ apiKeyId: null }), read)).toBeNull();
  });

  it("belongs to no run when the key names no host", async () => {
    const { read } = sources(null);
    expect(await resolveServedRun(context(), read)).toBeNull();
  });

  it("belongs to no run when the host bound no runtime", async () => {
    const { read } = sources({ ...HOST, runtime: null });
    expect(await resolveServedRun(context(), read)).toBeNull();
  });
});
