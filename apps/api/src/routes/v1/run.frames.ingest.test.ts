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
const PATH = "/v1/run-ingest";
const VALID_BATCH = {
  events: [
    {
      attemptSeq: 1,
      eventType: "tool.completed",
      observedAt: "2026-09-20T00:00:00.000Z",
      payload: { ok: true },
    },
  ],
};
const OUTPUT = {
  expiresAt: "2026-09-20T00:15:00.000Z",
  lastAttemptSeq: 1,
  lastRunSeq: "1",
  events: [],
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
    apiKeyId: "key_run",
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

describe("POST /v1/run-ingest", () => {
  it("takes scope from the credential and dispatches through the kernel", async () => {
    const response = await post(VALID_BATCH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "ingest_run_frames",
      VALID_BATCH,
      expect.objectContaining({
        orgId: KEY_ORG_ID,
        workspaceId: KEY_WORKSPACE_ID,
        userId: null,
        apiKeyId: "key_run",
        surface: "api",
      }),
      { surface: "api" },
    );
  });
  it("refuses missing and invalid credentials before the kernel", async () => {
    expect((await post(VALID_BATCH, {})).status).toBe(401);
    mocks.resolveApiKey.mockResolvedValueOnce({ ok: false, reason: "invalid" });
    expect((await post(VALID_BATCH)).status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("refuses media, syntax, and caller-supplied run identity", async () => {
    expect(
      (
        await post(VALID_BATCH, {
          authorization: "Bearer ox_test_key",
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415);
    expect((await post("{bad json")).status).toBe(400);
    expect((await post({ ...VALID_BATCH, runId: "arun_other" })).status).toBe(
      400,
    );
    expect(
      (await post({ events: [{ ...VALID_BATCH.events[0], attemptSeq: 0 }] }))
        .status,
    ).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("refuses oversized bodies before the kernel", async () => {
    expect(
      (await post({ padding: "x".repeat(2 * 1024 * 1024 + 1) })).status,
    ).toBe(413);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
