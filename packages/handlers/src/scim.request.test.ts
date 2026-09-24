/**
 * execute_scim_request's authorization and refusal mapping (#3734). The SCIM
 * protocol itself is proven in lib/scim/service.test.ts; this file proves who
 * may reach it and how a refusal leaves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerRemovalRefused } from "@oxagen/database/member-lifecycle";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  tokenRow: null as null | { orgId: string },
  serveScim: vi.fn(),
  entitled: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (mocks.tokenRow ? [mocks.tokenRow] : []),
        }),
      }),
    }),
  };
  return {
    ...real,
    withSystemDb: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
});
vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent: mocks.emit }));
vi.mock("./lib/sso", () => ({
  ssoEntitled: mocks.entitled,
  ssoAuthBaseUrl: () => "https://app.oxagen.sh",
}));
vi.mock("./lib/scim/pg-store", () => ({ createPgScimStore: () => ({}) }));
vi.mock("./lib/scim/service", () => ({ serveScim: mocks.serveScim }));

import { ScimError } from "./lib/scim/protocol";
import { scimRequestHandler } from "./scim.request";
import { makeCTX } from "./test-utils/fixtures";

const TOKEN_ID = "00000000-0000-4000-8000-000000000001";
const SCIM_CTX = makeCTX({ userId: null, apiKeyId: null, orgId: "org_1" });
const INPUT = {
  tokenId: TOKEN_ID,
  method: "DELETE" as const,
  path: "/Users/00000000-0000-4000-8000-0000000000aa",
  query: {},
};

beforeEach(() => {
  mocks.emit.mockReset();
  mocks.serveScim.mockReset();
  mocks.entitled.mockReset().mockResolvedValue(true);
  mocks.tokenRow = { orgId: "org_1" };
});

const denials = () =>
  mocks.emit.mock.calls
    .map((c) => c[0])
    .filter((e) => e.eventType === "scim.request_denied");

describe("execute_scim_request", () => {
  it("serves the request for the organization the token names", async () => {
    mocks.serveScim.mockResolvedValue({ status: 204, body: null });
    await expect(scimRequestHandler(INPUT, SCIM_CTX)).resolves.toEqual({
      status: 204,
      body: null,
    });
    expect(mocks.serveScim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "DELETE", path: INPUT.path }),
      "https://app.oxagen.sh/api/scim/v2",
    );
  });

  it("refuses a caller that carries a user or an API key", async () => {
    await expect(
      scimRequestHandler(INPUT, makeCTX({ userId: "u_1" })),
    ).rejects.toMatchObject({ code: "forbidden", reason: "scim_caller_only" });
    await expect(
      scimRequestHandler(INPUT, makeCTX({ userId: null, apiKeyId: "k_1" })),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.serveScim).not.toHaveBeenCalled();
  });

  it("refuses a token revoked since the route resolved it, and audits it", async () => {
    mocks.tokenRow = null;
    const out = await scimRequestHandler(INPUT, SCIM_CTX);
    expect(out.status).toBe(401);
    expect(denials()).toEqual([
      expect.objectContaining({
        orgId: "org_1",
        outcome: "deny",
        detail: { reason: "invalid_token", method: "DELETE", path: INPUT.path },
      }),
    ]);
    expect(mocks.serveScim).not.toHaveBeenCalled();
  });

  it("refuses a token from another organization", async () => {
    mocks.tokenRow = { orgId: "org_2" };
    const out = await scimRequestHandler(INPUT, SCIM_CTX);
    expect(out.status).toBe(401);
    expect(denials()[0]?.detail).toMatchObject({ reason: "cross_organization" });
    expect(mocks.serveScim).not.toHaveBeenCalled();
  });

  it("refuses an organization off the Enterprise plan", async () => {
    mocks.entitled.mockResolvedValue(false);
    const out = await scimRequestHandler(INPUT, SCIM_CTX);
    expect(out.status).toBe(403);
    expect(denials()[0]?.detail).toMatchObject({ reason: "not_entitled" });
  });

  it("answers an Owner refusal as a SCIM 403 that names the reason, and audits it", async () => {
    mocks.serveScim.mockRejectedValue(
      new ScimError(403, "This person is an Owner in Oxagen.", "mutability", "owner_protected"),
    );
    const out = await scimRequestHandler(INPUT, SCIM_CTX);
    expect(out).toEqual({
      status: 403,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "403",
        scimType: "mutability",
        detail: "This person is an Owner in Oxagen.",
      },
    });
    expect(denials()[0]?.detail).toMatchObject({ reason: "owner_protected" });
  });

  it("maps the removal transaction's own Owner refusal the same way", async () => {
    mocks.serveScim.mockRejectedValue(new OwnerRemovalRefused("u_owner"));
    const out = await scimRequestHandler(INPUT, SCIM_CTX);
    expect(out.status).toBe(403);
    expect(denials()[0]?.detail).toMatchObject({ reason: "owner_protected" });
  });

  it("answers a protocol error without an audit row", async () => {
    mocks.serveScim.mockRejectedValue(new ScimError(404, "User x not found"));
    const out = await scimRequestHandler(INPUT, SCIM_CTX);
    expect(out.status).toBe(404);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("answers a unique-key race as 409", async () => {
    mocks.serveScim.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    const out = await scimRequestHandler(INPUT, SCIM_CTX);
    expect(out).toMatchObject({ status: 409, body: { scimType: "uniqueness" } });
  });

  it("lets any other failure reach the kernel", async () => {
    mocks.serveScim.mockRejectedValue(new Error("db down"));
    await expect(scimRequestHandler(INPUT, SCIM_CTX)).rejects.toThrow("db down");
  });
});
