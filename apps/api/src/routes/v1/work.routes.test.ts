/**
 * The Work routes through the real `app`: the auth, org, and workspace
 * middleware, the route, and the error middleware (C-16). The other Work
 * route tests mount one route on a context that already holds a caller, so
 * they cannot show that a request with no credentials stops at 401, or that a
 * handler's refusal reaches the client as 403, 404, or 409.
 *
 * Pattern: mock at the adapter seam (@oxagen/auth, @oxagen/oxagen/kernel,
 * @oxagen/billing, @oxagen/handlers, middleware/logger), the way
 * __tests__/routes.run.test.ts does. No database or network is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return {
    ...real,
    invoke: mocks.invoke,
    clearHandlersForTests: vi.fn(),
  };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: vi.fn(),
    processStripeEvent: vi.fn(),
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {},
  FileForbiddenError: class FileForbiddenError extends Error {},
}));

vi.mock("../../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { HandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { app } from "../../app";
import {
  TEST_ORG_ID,
  TEST_WORKSPACE_ID,
  makeOrgScopeOk,
  makeRequest,
  makeSessionValid,
  makeWorkspaceNotMember,
  makeWorkspaceScopeOk,
} from "../../__tests__/_helpers";

const BASE = "/v1/test-org/test-ws";
const USER = "user-id-test";

interface WorkRoute {
  path: string;
  contract: string;
  /** An input the contract accepts. */
  input: Record<string, unknown>;
  /** What the route answers on success. */
  status: number;
}

const ROUTES: WorkRoute[] = [
  { path: "/work/items/list", contract: "list_work_items", input: { limit: 10 }, status: 200 },
  { path: "/work/items/get", contract: "get_work_item", input: { item: "WI-12" }, status: 200 },
  {
    path: "/work/items/close",
    contract: "close_work_item",
    input: { item_id: "wi_01", version: 4, resolution: "declined", reason: "Not planned." },
    status: 200,
  },
  { path: "/work/triage/retry", contract: "retry_work_triage", input: { item_id: "wi_01" }, status: 202 },
  { path: "/work/collectors/sync", contract: "sync_work_collector", input: { name: "github" }, status: 202 },
];

/** A signed-in person's request: a session cookie, no API key. */
function signedIn(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie: "oxagen.session_token=tok.sig", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The same request with no cookie and no key. */
function anonymous(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<{ code?: string; reason?: string }> {
  const body = (await res.json()) as { error: { code?: string; reason?: string } };
  return body.error;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseSessionCookie.mockImplementation((cookie: string | undefined) =>
    cookie ? "tok" : null,
  );
  mocks.resolveSession.mockResolvedValue(makeSessionValid(USER));
  mocks.resolveOrgScope.mockResolvedValue(makeOrgScopeOk());
  mocks.resolveWorkspaceScope.mockResolvedValue(makeWorkspaceScopeOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

describe.each(ROUTES)("POST $path", ({ path, contract, input, status }) => {
  it("answers 401 with no credentials, before it invokes", async () => {
    const res = await app.fetch(anonymous(path, input));
    expect(res.status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it(`invokes ${contract} as the signed-in person on the API surface`, async () => {
    const res = await app.fetch(signedIn(path, input));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith(
      contract,
      expect.objectContaining(input),
      expect.objectContaining({
        orgId: TEST_ORG_ID,
        workspaceId: TEST_WORKSPACE_ID,
        userId: USER,
        apiKeyId: null,
      }),
      { surface: "api" },
    );
  });

  it.each([
    [403, "forbidden", "person_required"],
    [404, "not_found", "work_item_not_found"],
    [409, "conflict", "stale_version"],
  ] as const)("answers %i when the handler refuses with %s", async (code, handlerCode, reason) => {
    mocks.invoke.mockRejectedValue(new HandlerError({ code: handlerCode, reason, message: "Refused." }));
    const res = await app.fetch(signedIn(path, input));
    expect(res.status).toBe(code);
    expect(await errorOf(res)).toMatchObject({ code: handlerCode, reason });
  });

  it("answers 400 when the handler refuses the input", async () => {
    mocks.invoke.mockRejectedValue(new CapabilityError(contract, "invalid_input", "Bad input."));
    const res = await app.fetch(signedIn(path, input));
    expect(res.status).toBe(400);
  });
});

describe("a Work route and a caller outside the workspace", () => {
  it("answers 403 for a person who is not a member, before it invokes", async () => {
    mocks.resolveWorkspaceScope.mockResolvedValue(makeWorkspaceNotMember());
    const res = await app.fetch(signedIn("/work/triage/retry", { item_id: "wi_01" }));
    expect(res.status).toBe(403);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
