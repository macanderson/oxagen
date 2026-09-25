// secret.value.unset handler: the role gate (#4194).
//
// The contract grants org Owner or Admin, the same roles set_secret_value
// enforces. The kernel's IAM check allows every capability for a
// non-enterprise org, so the handler is the only gate there, and it runs
// before the value is cleared or the security event is written.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({
  unsetSecretValue: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/plugins", () => ({
  unsetSecretValue: mocks.unsetSecretValue,
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

import { secretValueUnsetHandler } from "./secret.value.unset";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { keyId: "sk_1", environmentId: "env_1" };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  mocks.unsetSecretValue.mockResolvedValue({ ok: true });
});

describe("secretValueUnsetHandler role gate", () => {
  it("refuses a workspace Member as forbidden and clears nothing", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(secretValueUnsetHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.unsetSecretValue).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("refuses a context with no user and no key", async () => {
    await expect(
      secretValueUnsetHandler(INPUT, { ...CTX, userId: null, apiKeyId: null }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
    expect(mocks.unsetSecretValue).not.toHaveBeenCalled();
  });

  it("allows an org Admin and records the change", async () => {
    roleGate.roles = { org: "Admin" };
    await expect(secretValueUnsetHandler(INPUT, CTX)).resolves.toEqual({
      ok: true,
    });
    expect(mocks.unsetSecretValue).toHaveBeenCalledTimes(1);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "secret.value_changed",
        capability: "unset_secret_value",
      }),
    );
  });
});
