// The three API key writes through the real kernel seam (INV-19): the viewer
// resolution and the kernel's invoke() are the only fakes, so each case shows
// what the person gets back and whether the capability ran. Every refusal is
// classified by the code the handler threw, never by its message (§3.2).
//
// The last case in "create" is the one that matters most: the secret is in the
// action's answer and in nothing the page reads. It mints a key, then reads the
// organization's keys through the same seam from a control plane that tries to
// hand the secret and the hash back with the row, and shows the read carrying
// neither.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { org } = await import("@/data/live/org");
const { createApiKey, revokeApiKey, rotateApiKey } = await import(
  "./api-key-actions"
);

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7a000000-0000-4000-8000-0000000000c3",
  wsSlug: "core-platform",
  wsName: "Core platform",
});

/** The workspace the page named; a key names one (ADR-073). */
const WS = "core-platform";

/** A day well clear of any clock this suite runs on, and the instant it ends. */
const LAST_DAY = "2099-03-01";
const LAST_DAY_END = "2099-03-01T23:59:59.999Z";

/** The key id the roster prints, and the only id the page holds (INV-11). */
const KEY = "aky_7k2m9q4x8r1t5v3w6y0z2a";
/** The raw key a minting contract answers with once. */
const SECRET = "ox_3fa85f64571b4c62a0f5e8c9d1b2a3f4";
/**
 * The CapabilityContext these writes reach the kernel with: the workspace the
 * page named, never the org-only sentinel. `auth.api_keys` is policy class
 * `standard`, so a key minted under the sentinel names a workspace that does
 * not exist and the secret shown once authenticates into nothing (ADR-073).
 */
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};

/** What `create_api_key` and `rotate_api_key` answer with. */
const minted = {
  keyId: "7a000000-0000-4000-8000-0000000000b2",
  publicId: KEY,
  name: "CI runner",
  keyPrefix: "ox_3fa85f6457",
  rawKey: SECRET,
  expiresAt: null,
  createdAt: "2026-09-15T10:00:00.000Z",
};

/** The same key as `list_api_keys` records it once it exists. */
const listed = {
  publicId: KEY,
  name: "CI runner",
  prefix: "ox_3fa85f6457",
  createdAt: "2026-09-15T10:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  rotatable: true,
};

const shown = {
  id: KEY,
  name: "CI runner",
  prefix: "ox_3fa85f6457",
  secret: SECRET,
  expiresAt: null,
};

const denial = (capability: string) =>
  new kernel.CapabilityError(
    capability,
    "authz_denied",
    "Forbidden: only org Owners and Admins can manage API keys",
  );

const refusal = (reason: string) =>
  new kernel.HandlerError({ code: "not_found", reason });

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset().mockResolvedValue(ctx);
});

describe("createApiKey", () => {
  it("mints the key under the name given and answers with its secret", async () => {
    invoke.mockResolvedValue(minted);
    expect(await createApiKey("acme", WS, "CI runner", "")).toEqual({
      ok: true,
      value: shown,
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", WS);
    expect(invoke).toHaveBeenCalledWith(
      "create_api_key",
      { name: "CI runner" },
      expect.objectContaining(TENANT),
    );
  });

  it("sends the end of the chosen day, so a key expiring on it is not expired on arrival", async () => {
    invoke.mockResolvedValue({ ...minted, expiresAt: LAST_DAY_END });
    const created = await createApiKey("acme", WS, "  CI runner  ", LAST_DAY);
    expect(created).toEqual({
      ok: true,
      value: { ...shown, expiresAt: LAST_DAY_END },
    });
    expect(invoke).toHaveBeenCalledWith(
      "create_api_key",
      { name: "CI runner", expiresAt: LAST_DAY_END },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a day already over before the kernel runs, with the secret unspent (negative)", async () => {
    // `resolveApiKey` refuses an expired key, so minting one would spend the
    // one showing of a secret on a credential that never works.
    expect(await createApiKey("acme", WS, "CI runner", "2020-01-01")).toEqual({
      ok: false,
      reason: "invalid",
      code: "expiry_in_the_past",
      field: "expiresAt",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["", "   "])(
    "refuses %o, a key with no name, before the kernel runs (negative)",
    async (name) => {
      expect(await createApiKey("acme", WS, name, "")).toEqual({
        ok: false,
        reason: "invalid",
        code: "name_required",
        field: "name",
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it.each([
    "next tuesday",
    "2027-13-01",
    "2027-02-31",
    "01/03/2027",
    "2027-03-01T00:00:00Z",
  ])(
    "refuses %o, an expiry that is not a day, before the kernel runs (negative)",
    async (expiresOn) => {
      expect(await createApiKey("acme", WS, "CI runner", expiresOn)).toEqual({
        ok: false,
        reason: "invalid",
        code: "expiry_not_a_day",
        field: "expiresAt",
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("returns a role that may not mint keys as denied (negative)", async () => {
    invoke.mockRejectedValue(denial("create_api_key"));
    expect(await createApiKey("acme", WS, "CI runner", "")).toEqual({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
  });

  it("reports output the contract does not admit as unavailable (negative)", async () => {
    invoke.mockResolvedValue({ publicId: KEY });
    expect(await createApiKey("acme", WS, "CI runner", "")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "contract_output_mismatch",
    });
  });

  it("puts the secret in the action's answer and in no read of the keys (negative)", async () => {
    invoke.mockResolvedValue(minted);
    const created = await createApiKey("acme", WS, "CI runner", "");
    expect(created).toEqual({ ok: true, value: shown });

    invoke.mockResolvedValue({
      items: [{ ...listed, rawKey: SECRET, keyHash: `sha256:${SECRET}` }],
    });
    const read = await org.apiKeys(ctx);
    expect(read).toEqual({
      ok: true,
      value: [
        {
          id: KEY,
          name: "CI runner",
          prefix: "ox_3fa85f6457",
          createdAt: "2026-09-15T10:00:00.000Z",
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          rotatable: true,
        },
      ],
    });
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(JSON.stringify(read)).not.toContain("keyHash");
  });
});

describe("rotateApiKey", () => {
  it("replaces the key and answers with the replacement's secret", async () => {
    invoke.mockResolvedValue({
      ...minted,
      revokedKeyPublicId: "aky_9z8y7x6w5v4t3s2r1q0p9n",
      revokedAt: "2026-09-15T10:00:00.000Z",
    });
    expect(
      await rotateApiKey("acme", WS, "aky_9z8y7x6w5v4t3s2r1q0p9n"),
    ).toEqual({
      ok: true,
      value: shown,
    });
    expect(invoke).toHaveBeenCalledWith(
      "rotate_api_key",
      { keyPublicId: "aky_9z8y7x6w5v4t3s2r1q0p9n" },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty key id before the kernel runs (negative)", async () => {
    expect(await rotateApiKey("acme", WS, "")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "keyPublicId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a role that may not rotate keys as denied (negative)", async () => {
    invoke.mockRejectedValue(denial("rotate_api_key"));
    expect(await rotateApiKey("acme", WS, KEY)).toEqual({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
  });

  it("returns a key this organization does not hold as not_found (negative)", async () => {
    invoke.mockRejectedValue(refusal("api_key_not_found"));
    expect(await rotateApiKey("acme", WS, KEY)).toEqual({
      ok: false,
      reason: "not_found",
      code: "api_key_not_found",
    });
  });
});

describe("revokeApiKey", () => {
  it("ends the key the row named", async () => {
    invoke.mockResolvedValue({
      revoked: true,
      keyPublicId: KEY,
      revokedAt: "2026-09-15T11:00:00.000Z",
    });
    expect(await revokeApiKey("acme", WS, KEY)).toEqual({
      ok: true,
      value: { keyId: KEY },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", WS);
    expect(invoke).toHaveBeenCalledWith(
      "revoke_api_key",
      { keyPublicId: KEY },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty key id before the kernel runs (negative)", async () => {
    expect(await revokeApiKey("acme", WS, "")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "keyPublicId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a role that may not revoke keys as denied (negative)", async () => {
    invoke.mockRejectedValue(denial("revoke_api_key"));
    expect(await revokeApiKey("acme", WS, KEY)).toEqual({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
  });

  it("returns a key already revoked as not_found (negative)", async () => {
    invoke.mockRejectedValue(refusal("api_key_not_found"));
    expect(await revokeApiKey("acme", WS, KEY)).toEqual({
      ok: false,
      reason: "not_found",
      code: "api_key_not_found",
    });
  });
});

describe("a person the organization refuses", () => {
  it.each([
    ["createApiKey", () => createApiKey("acme", WS, "CI runner", "")],
    ["rotateApiKey", () => rotateApiKey("acme", WS, KEY)],
    ["revokeApiKey", () => revokeApiKey("acme", WS, KEY)],
  ])("%s runs nothing (negative)", async (_name, run) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(invoke).not.toHaveBeenCalled();
  });
});
