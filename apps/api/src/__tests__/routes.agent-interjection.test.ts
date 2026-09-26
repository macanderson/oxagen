/**
 * The interjection routes (#3839): POST /agent/interjections/list and
 * /agent/interjections/answer. The adapter seams are mocked as in
 * routes.agent.test.ts. Each route parses its body against the contract,
 * calls invoke once with the contract name and surface "api", and returns
 * what invoke returned. A handler's conflict reaches the client as a 409 with
 * its reason.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen/handler-error";

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
  return { ...real, invoke: mocks.invoke, clearHandlersForTests: vi.fn() };
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

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import { bearerHeader, makeApiKeyOk, makeRequest } from "./_helpers";

const BASE = "/v1/test-org/test-ws";

function post(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
});

describe("agent.interjection.list route", () => {
  const PATH = "/agent/interjections/list";

  it("returns the page invoke returned", async () => {
    const page = { items: [], nextCursor: null };
    mocks.invoke.mockResolvedValue(page);
    const res = await app.fetch(post(PATH, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(page);
  });

  it("calls invoke once with 'list_interjections', the parsed input with defaults, and surface 'api'", async () => {
    mocks.invoke.mockResolvedValue({ items: [], nextCursor: null });
    await app.fetch(post(PATH, { runId: "tse_0123456789abcdefghjkmn" }));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("list_interjections");
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({
      runId: "tse_0123456789abcdefghjkmn",
      open: true,
      limit: 50,
    });
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("refuses a page size past 100 and an unknown field before invoke (negative)", async () => {
    expect((await app.fetch(post(PATH, { limit: 101 }))).status).toBe(400);
    expect((await app.fetch(post(PATH, { status: "open" }))).status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("agent.interjection.answer route", () => {
  const PATH = "/agent/interjections/answer";
  const body = {
    interjectionId: "inj_0123456789abcdefghjkmn",
    answer: "Cut it from main.",
  };

  it("calls invoke once with 'answer_interjection' and returns the receipt", async () => {
    const receipt = {
      interjectionId: body.interjectionId,
      runId: "tse_0123456789abcdefghjkmn",
      answeredAt: "2026-09-25T09:10:00.000Z",
      commandIds: ["tcm_1"],
    };
    mocks.invoke.mockResolvedValue(receipt);
    const res = await app.fetch(post(PATH, body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(receipt);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("answer_interjection");
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual(body);
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });

  it("refuses an empty answer and an id of the wrong kind before invoke (negative)", async () => {
    expect(
      (await app.fetch(post(PATH, { ...body, answer: "  " }))).status,
    ).toBe(400);
    expect(
      (await app.fetch(post(PATH, { ...body, interjectionId: "apr_x" })))
        .status,
    ).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers a question someone already answered with 409 and its reason (negative)", async () => {
    mocks.invoke.mockRejectedValue(
      new HandlerError({
        code: "conflict",
        reason: "interjection_answered",
        message: "Someone already answered this question.",
      }),
    );
    const res = await app.fetch(post(PATH, body));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("interjection_answered");
  });
});
