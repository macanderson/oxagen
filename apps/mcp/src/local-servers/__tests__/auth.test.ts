// auth.test.ts: which machine a poll or reply speaks for, and each refusal
// on the way (#4773, #4554).
import type { ApiKeyResolution } from "@oxagen/auth";
import type { KeyScope } from "@oxagen/iam/machine-key-scope";
import { describe, expect, it, vi } from "vitest";
import { bearerOf, createMachineAuth, MACHINE_HEADER, type MachineAuthDeps, type MachineHostRow } from "../auth";

const PURPOSE = "tacho_gateway_v1";
const MACHINE = "tch_laptop01";
const NOW = Date.UTC(2026, 8, 29, 12, 0);
const HEADERS = { authorization: "Bearer ox_gateway_key", [MACHINE_HEADER]: MACHINE };
const KEY: ApiKeyResolution = { ok: true, apiKeyId: "key_1", orgId: "org_1", workspaceId: "ws_1", userId: null };
const SCOPE: KeyScope = { kind: "purpose", purpose: PURPOSE, hostEnrollmentId: MACHINE };
const ACTIVE: MachineHostRow = { status: "active", expiresAt: new Date(NOW + 86_400_000), revokedAt: null };

function deps(overrides: Partial<MachineAuthDeps> = {}): MachineAuthDeps {
  return {
    gatewayPurpose: PURPOSE,
    resolveKey: () => Promise.resolve(KEY),
    readScope: () => Promise.resolve(SCOPE),
    readHost: () => Promise.resolve(ACTIVE),
    now: () => NOW,
    ...overrides,
  };
}

function refusal(status: 401 | 403, code: "unauthorized" | "forbidden", message: string, reason?: string) {
  return {
    ok: false,
    status,
    body: { error: reason === undefined ? { code, message } : { code, message, reason } },
  };
}

describe("bearerOf", () => {
  it("reads the token after Bearer, from the first value of a repeated header", () => {
    expect(bearerOf({ authorization: "Bearer ox_one" })).toBe("ox_one");
    expect(bearerOf({ authorization: ["Bearer ox_first", "Bearer ox_second"] })).toBe("ox_first");
  });

  it("finds no token when the header is missing, another scheme, or empty", () => {
    expect(bearerOf({})).toBeNull();
    expect(bearerOf({ authorization: "Basic dXNlcjpwYXNz" })).toBeNull();
    expect(bearerOf({ authorization: "Bearer    " })).toBeNull();
  });
});

describe("createMachineAuth", () => {
  it("names the machine the gateway key was enrolled for", async () => {
    const readHost = vi.fn(() => Promise.resolve(ACTIVE));
    const readScope = vi.fn(() => Promise.resolve(SCOPE));
    const auth = createMachineAuth(deps({ readHost, readScope }));
    await expect(auth(HEADERS)).resolves.toEqual({ ok: true, machine: MACHINE });
    expect(readScope).toHaveBeenCalledWith("org_1", "key_1");
    expect(readHost).toHaveBeenCalledWith({ orgId: "org_1", workspaceId: "ws_1" }, MACHINE);
  });

  it("refuses a request with no bearer token before it reads the key", async () => {
    const resolveKey = vi.fn(() => Promise.resolve(KEY));
    const auth = createMachineAuth(deps({ resolveKey }));
    await expect(auth({ [MACHINE_HEADER]: MACHINE })).resolves.toEqual(
      refusal(401, "unauthorized", "Missing credentials"),
    );
    expect(resolveKey).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", "Malformed API key"],
    ["invalid", "Invalid API key"],
    ["expired", "API key expired"],
    ["purpose_locked", "API key is locked to a purpose this surface does not serve"],
    [
      "workspace_archived",
      "This API key's workspace is archived; restore the workspace or use a key in an active one",
    ],
  ] as const)("refuses a %s key with the API's 401 message", async (kind, message) => {
    const auth = createMachineAuth(deps({ resolveKey: () => Promise.resolve({ ok: false, kind }) }));
    await expect(auth(HEADERS)).resolves.toEqual(refusal(401, "unauthorized", message));
  });

  it("refuses a key whose organization requires single sign-on with 403", async () => {
    const auth = createMachineAuth(deps({ resolveKey: () => Promise.resolve({ ok: false, kind: "sso_required" }) }));
    const answer = await auth(HEADERS);
    expect(answer).toMatchObject({ ok: false, status: 403, body: { error: { code: "forbidden" } } });
  });

  it("refuses the key of a revoked host with reason host_revoked", async () => {
    const auth = createMachineAuth(deps({ resolveKey: () => Promise.resolve({ ok: false, kind: "host_revoked" }) }));
    await expect(auth(HEADERS)).resolves.toEqual(
      refusal(403, "forbidden", "Forbidden: Tacho host enrollment revoked", "host_revoked"),
    );
  });

  it.each<[string, KeyScope]>([
    ["a personal key", { kind: "personal" }],
    ["a key with no scope", { kind: "missing" }],
    ["a host key rather than a gateway key", { kind: "purpose", purpose: "tacho_host_v1", hostEnrollmentId: MACHINE }],
    ["a gateway key that names no enrollment", { kind: "purpose", purpose: PURPOSE }],
  ])("refuses %s", async (_name, scope) => {
    const readHost = vi.fn(() => Promise.resolve(ACTIVE));
    const auth = createMachineAuth(deps({ readScope: () => Promise.resolve(scope), readHost }));
    await expect(auth(HEADERS)).resolves.toEqual(
      refusal(403, "forbidden", "Forbidden: enrolled Tacho host gateway key required"),
    );
    expect(readHost).not.toHaveBeenCalled();
  });

  it("refuses a request that names another machine than the key's", async () => {
    const auth = createMachineAuth(deps());
    for (const headers of [
      { authorization: HEADERS.authorization },
      { authorization: HEADERS.authorization, [MACHINE_HEADER]: "tch_other" },
    ]) {
      await expect(auth(headers)).resolves.toEqual(refusal(403, "forbidden", "Forbidden: host enrollment mismatch"));
    }
  });

  it("refuses an enrollment with no host row in the key's workspace", async () => {
    const auth = createMachineAuth(deps({ readHost: () => Promise.resolve(undefined) }));
    await expect(auth(HEADERS)).resolves.toEqual(refusal(403, "forbidden", "Forbidden: unknown Tacho host"));
  });

  it("refuses a revoked host, by status or by revoked time", async () => {
    const revoked = [
      { ...ACTIVE, status: "revoked" },
      { ...ACTIVE, revokedAt: new Date(NOW - 1_000) },
    ];
    for (const host of revoked) {
      const auth = createMachineAuth(deps({ readHost: () => Promise.resolve(host) }));
      await expect(auth(HEADERS)).resolves.toEqual(
        refusal(403, "forbidden", "Forbidden: Tacho host enrollment revoked", "host_revoked"),
      );
    }
  });

  it("refuses a suspended host with reason host_suspended", async () => {
    const auth = createMachineAuth(deps({ readHost: () => Promise.resolve({ ...ACTIVE, status: "suspended" }) }));
    await expect(auth(HEADERS)).resolves.toEqual(
      refusal(403, "forbidden", "Forbidden: Tacho host suspended", "host_suspended"),
    );
  });

  it("refuses an enrollment that has expired", async () => {
    const auth = createMachineAuth(deps({ readHost: () => Promise.resolve({ ...ACTIVE, expiresAt: new Date(NOW) }) }));
    await expect(auth(HEADERS)).resolves.toEqual(refusal(403, "forbidden", "Forbidden: Tacho host enrollment expired"));
  });

  it("reads the clock when no now is given", async () => {
    const { now: _now, ...rest } = deps();
    const auth = createMachineAuth({ ...rest, readHost: () => Promise.resolve({ ...ACTIVE, expiresAt: new Date(0) }) });
    await expect(auth(HEADERS)).resolves.toEqual(refusal(403, "forbidden", "Forbidden: Tacho host enrollment expired"));
  });
});
