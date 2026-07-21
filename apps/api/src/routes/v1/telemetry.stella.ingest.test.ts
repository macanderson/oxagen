import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveApiKey: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveSession: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
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

const PATH = "/v1/telemetry/stella/operational";
const KEY_ORG_ID = "11111111-1111-4111-8111-111111111111";
const KEY_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const MAX_BODY_BYTES = 256 * 1024;

const VALID_EVENT = {
  schema: "stella.operational.v1" as const,
  event_class: "execution_rollup" as const,
  event_id: `evt_${"a".repeat(64)}`,
  enrollment_id: "enrollment_from_signed_config",
  organization_id: "client_compat_org_label",
  workspace_id: "client_compat_workspace_label",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4",
  outcome: "completed" as const,
  duration_ms: 1_200,
  input_tokens: 200,
  output_tokens: 50,
  cost_microusd: 1_750,
  tool_call_count: 3,
  changed_file_count: 1,
  produced_output: true,
};

const VALID_BATCH = {
  schema: "stella.operational.batch.v1" as const,
  events: [VALID_EVENT],
};

const OUTPUT = {
  accepted: 1,
  event_ids: [VALID_EVENT.event_id],
};

async function post(
  body: unknown,
  headers: Record<string, string> = {
    authorization: "Bearer ox_test_key",
  },
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseSessionCookie.mockReturnValue(null);
  mocks.resolveApiKey.mockResolvedValue({
    ok: true,
    apiKeyId: "key_stella",
    orgId: KEY_ORG_ID,
    workspaceId: KEY_WORKSPACE_ID,
  });
  mocks.invoke.mockResolvedValue(OUTPUT);
});

describe("POST /v1/telemetry/stella/operational", () => {
  it("mounts the exact POST route and rejects other methods", async () => {
    const postResponse = await post(VALID_BATCH);
    expect(postResponse.status).toBe(200);

    mocks.invoke.mockClear();
    const getResponse = await app.fetch(
      new Request(`http://localhost${PATH}`, {
        headers: { authorization: "Bearer ox_test_key" },
      }),
    );

    expect(getResponse.status).toBe(404);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invokes the API capability with tenant scope exclusively from the API key", async () => {
    const response = await post(VALID_BATCH, {
      authorization: "Bearer ox_test_key",
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(OUTPUT);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "ingest_stella_operational_telemetry",
      VALID_BATCH,
      {
        orgId: KEY_ORG_ID,
        workspaceId: KEY_WORKSPACE_ID,
        userId: null,
        apiKeyId: "key_stella",
        requestId: REQUEST_ID,
        surface: "api",
        messageId: null,
        clientIp: "203.0.113.9",
      },
      { surface: "api" },
    );

    const invocationContext = mocks.invoke.mock.calls[0]?.[2] as {
      orgId: string;
      workspaceId: string;
    };
    expect(invocationContext.orgId).not.toBe(VALID_EVENT.organization_id);
    expect(invocationContext.workspaceId).not.toBe(VALID_EVENT.workspace_id);
  });

  it("returns a precise 401 for a cookie session before invoking", async () => {
    mocks.parseSessionCookie.mockReturnValue("session-token");
    mocks.resolveSession.mockResolvedValue({ userId: "user_session" });

    const response = await post(VALID_BATCH, {
      cookie: "oxagen.session_token=session-token.signature",
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "API key required" },
      requestId: REQUEST_ID,
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("preserves the existing unauthenticated 401 behavior", async () => {
    const response = await post(VALID_BATCH, {});

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "unauthorized", message: "Missing credentials" },
      requestId: REQUEST_ID,
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before invoking", async () => {
    const response = await app.fetch(
      new Request(`http://localhost${PATH}`, {
        method: "POST",
        headers: {
          authorization: "Bearer ox_test_key",
          "content-type": "application/json",
        },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", message: "Invalid JSON body" },
      requestId: REQUEST_ID,
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared-length payload before parsing or invoking", async () => {
    const rawBody = JSON.stringify({
      ...VALID_BATCH,
      events: [
        {
          ...VALID_EVENT,
          enrollment_id: "x".repeat(MAX_BODY_BYTES),
        },
      ],
    });

    const response = await app.fetch(
      new Request(`http://localhost${PATH}`, {
        method: "POST",
        headers: {
          authorization: "Bearer ox_test_key",
          "content-length": String(
            new TextEncoder().encode(rawBody).byteLength,
          ),
          "content-type": "application/json",
        },
        body: rawBody,
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", message: "Payload Too Large" },
      requestId: REQUEST_ID,
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed unknown field before parsing or invoking", async () => {
    const rawBody = JSON.stringify({
      ...VALID_BATCH,
      unknown_content: "x".repeat(MAX_BODY_BYTES),
    });
    const encoded = new TextEncoder().encode(rawBody);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, MAX_BODY_BYTES / 2));
        controller.enqueue(encoded.slice(MAX_BODY_BYTES / 2));
        controller.close();
      },
    });

    const response = await app.fetch(
      new Request(`http://localhost${PATH}`, {
        method: "POST",
        headers: {
          authorization: "Bearer ox_test_key",
          "content-type": "application/json",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", message: "Payload Too Large" },
      requestId: REQUEST_ID,
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed batch", { ...VALID_BATCH, events: [] }],
    [
      "unknown event field",
      {
        ...VALID_BATCH,
        events: [{ ...VALID_EVENT, prompt: "must not cross the boundary" }],
      },
    ],
    [
      "tenant-smuggling fields",
      {
        ...VALID_BATCH,
        orgId: "99999999-9999-4999-8999-999999999999",
        workspaceId: "88888888-8888-4888-8888-888888888888",
      },
    ],
  ])("rejects %s and never invokes", async (_name, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_error" },
      requestId: REQUEST_ID,
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
