import {
  GENESIS_CURSOR,
  type UnsealedTachoEvent,
  sealEvent,
  sessionUuid,
} from "@oxagen/tacho";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveApiKey: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveSession: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  requireEnv: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/config/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/config/env")>();
  return {
    ...original,
    requireEnv: (keys: readonly string[]) =>
      keys.includes("RATE_LIMIT_AGENT_EXEC_PER_MIN")
        ? mocks.requireEnv(keys)
        : original.requireEnv(keys as never),
  };
});

vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withSystemDb: mocks.withSystemDb,
}));

vi.mock("@oxagen/auth", () => ({
  parseSessionCookie: mocks.parseSessionCookie,
  resolveApiKey: mocks.resolveApiKey,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveSession: mocks.resolveSession,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen/kernel")>()),
  invoke: mocks.invoke,
}));

vi.mock("@oxagen/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/billing")>()),
  bootstrapBillingRuntime: vi.fn(),
  processStripeEvent: vi.fn(),
  verifyStripeSignature: vi.fn(),
}));

vi.mock("@oxagen/handlers", () => ({
  FileForbiddenError: class FileForbiddenError extends Error {},
  FileNotFoundError: class FileNotFoundError extends Error {},
  serveFile: vi.fn(),
}));

vi.mock("../../middleware/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  requestLogger: vi.fn(
    async (
      c: { set: (key: "requestId", value: string) => void },
      next: () => Promise<void>,
    ) => {
      c.set("requestId", "33333333-3333-4333-8333-333333333333");
      await next();
    },
  ),
}));

import { app } from "../../app";

const KEY_ORG_ID = "00000000-0000-0000-0000-000000000001";
const KEY_WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const HOST = "tch_0123456789abcdefghjkmn";
const PATH = "/v1/tacho/events";
const SESSION = sessionUuid(HOST, "sess-1");

function sealedGenesis() {
  const unsealed = {
    v: "tacho/1.0",
    event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "sess-1",
    session_uuid: SESSION,
    root_session_uuid: SESSION,
    ts: "2026-09-08T10:06:03.000Z",
    fidelity: "sdk",
    source: "hook",
    agent: {
      agent_key: "acme.core.cc-laptop",
      fleet_id: "wrk_1",
      runtime: "claude-code",
      harness: "claude-code",
      wrapper_version: "2.1.1",
      host_enrollment_id: HOST,
    },
    kind: "agent_start",
    body: { session_start_source: "startup" },
  } satisfies UnsealedTachoEvent;
  return sealEvent(unsealed, GENESIS_CURSOR).event;
}

const VALID_BATCH = {
  schema: "tacho.batch.v1",
  host_enrollment_id: HOST,
  events: [sealedGenesis()],
};

const OUTPUT = {
  accepted: 1,
  event_ids: [VALID_BATCH.events[0]?.event_id_idem],
  chain_breaks: [],
  control: {
    host_status: "active",
    deny_generation: { org: 1, workspace: 1 },
    bundle_etag: "etag",
    commands: [],
  },
};

async function post(
  body: unknown,
  headers: Record<string, string> = { authorization: "Bearer ox_test_key" },
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vercel-forwarded-for": "203.0.113.9",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  mocks.parseSessionCookie.mockReturnValue(null);
  mocks.resolveApiKey.mockResolvedValue({
    ok: true,
    apiKeyId: "key_tacho",
    orgId: KEY_ORG_ID,
    workspaceId: KEY_WORKSPACE_ID,
  });
  mocks.requireEnv.mockReturnValue({
    RATE_LIMIT_CHAT_PER_MIN: 60,
    RATE_LIMIT_AGENT_EXEC_PER_MIN: 30,
  });
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: vi.fn().mockResolvedValue([{ count: 1 }]) }),
  );
  mocks.invoke.mockResolvedValue(OUTPUT);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /v1/tacho/events", () => {
  it("dispatches a valid batch with tenant scope taken only from the API key", async () => {
    const response = await post(VALID_BATCH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "ingest_tacho_events",
      expect.objectContaining({
        schema: "tacho.batch.v1",
        host_enrollment_id: HOST,
      }),
      expect.objectContaining({
        orgId: KEY_ORG_ID,
        workspaceId: KEY_WORKSPACE_ID,
        userId: null,
        apiKeyId: "key_tacho",
        surface: "api",
      }),
      { surface: "api" },
    );
  });

  it("rejects a missing key, a wrong media type, invalid JSON, and an invalid batch before the kernel", async () => {
    mocks.resolveApiKey.mockResolvedValueOnce({ ok: false, reason: "invalid" });
    expect((await post(VALID_BATCH)).status).toBe(401);
    expect(
      (
        await post(VALID_BATCH, {
          authorization: "Bearer ox_test_key",
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415);
    expect((await post("{not json")).status).toBe(400);
    const invalid = await post({
      ...VALID_BATCH,
      events: [{ ...VALID_BATCH.events[0], hash: "nope" }],
    });
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("refuses a body over the limit", async () => {
    const huge = { ...VALID_BATCH, padding: "x".repeat(1024 * 1024 + 1) };
    expect((await post(huge)).status).toBe(413);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
