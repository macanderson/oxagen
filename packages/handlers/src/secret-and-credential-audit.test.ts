/**
 * Privileged secret and plugin-credential actions reach the MAIN audit log.
 *
 * Revealing and exporting a secret wrote only to `environments.secret_access_log`,
 * a table the main audit-log query, the audit-log UI and `SECURITY_EVENT_TYPES`
 * could not see. Setting, unsetting and deleting wrote nothing anywhere. Storing
 * or deleting a plugin's OAuth token or secret wrote nothing either, and both
 * handlers carried an `audit-exempt` comment saying no fitting event type
 * existed — which was true (oxagen#2527, oxagen#2533).
 *
 * Every case below fails on the old code: none of these handlers called an emit
 * helper at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emitSecurityEvent: vi.fn(),
  revealSecret: vi.fn(),
  exportSecrets: vi.fn(),
  setSecretValue: vi.fn(),
  unsetSecretValue: vi.fn(),
  deleteSecretKey: vi.fn(),
  upsertSecretKey: vi.fn(),
  listSecretKeys: vi.fn(),
  importEnv: vi.fn(),
  setWorkspaceSecret: vi.fn(),
  deleteWorkspaceSecret: vi.fn(),
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

vi.mock("@oxagen/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/plugins")>()),
  revealSecret: mocks.revealSecret,
  exportSecrets: mocks.exportSecrets,
  setSecretValue: mocks.setSecretValue,
  unsetSecretValue: mocks.unsetSecretValue,
  deleteSecretKey: mocks.deleteSecretKey,
  upsertSecretKey: mocks.upsertSecretKey,
  listSecretKeys: mocks.listSecretKeys,
  importEnv: mocks.importEnv,
  setWorkspaceSecret: mocks.setWorkspaceSecret,
  deleteWorkspaceSecret: mocks.deleteWorkspaceSecret,
}));

const listingRows: Array<Record<string, unknown>> = [];

// The caller's org membership, read by the handler-side role guard
// (lib/capability-role-guard). Owner by default so the audit cases above keep
// asserting what they were written to assert; the role-guard cases below
// override it per test.
const mockMembershipRows = vi.fn(
  (): Array<{ role: string }> => [{ role: "owner" }],
);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({ where: () => ({ limit: async () => listingRows }) }),
        }),
      }),
    withSystemDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => mockMembershipRows() }),
          }),
        }),
      }),
  };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { secretRevealHandler } from "./secret.reveal";
import { secretExportHandler } from "./secret.export";
import { secretValueSetHandler } from "./secret.value.set";
import { secretValueUnsetHandler } from "./secret.value.unset";
import { secretKeyDeleteHandler } from "./secret.key.delete";
import { secretKeyUpsertHandler } from "./secret.key.upsert";
import { secretKeyListHandler } from "./secret.key.list";
import { secretImportEnvHandler } from "./secret.import_env";
import { handler as pluginCredentialSetHandler } from "./plugin.credential.set_secret";
import { handler as pluginCredentialRevokeHandler } from "./plugin.credential.revoke";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

/** The single audit row a handler emitted. */
function onlyEvent() {
  expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
  return mocks.emitSecurityEvent.mock.calls[0]?.[0] as {
    eventType: string;
    capability: string;
    orgId: string;
    workspaceId: string | null;
    actorUserId: string | null;
    outcome: string;
    requestId: string | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks() does not drain a mockReturnValueOnce queue, so a test whose
  // once-value goes unconsumed would hand it to the next one. Reset the
  // membership mock outright and restore the Owner default every case starts
  // from.
  mockMembershipRows.mockReset();
  mockMembershipRows.mockReturnValue([{ role: "owner" }]);
  listingRows.length = 0;
  mocks.revealSecret.mockResolvedValue({
    key: "K",
    value: "v",
    source: "workspace",
  });
  mocks.exportSecrets.mockResolvedValue({ env: [], text: "" });
  mocks.setSecretValue.mockResolvedValue({ ok: true });
  mocks.unsetSecretValue.mockResolvedValue({ ok: true });
  mocks.deleteSecretKey.mockResolvedValue({ ok: true });
  mocks.upsertSecretKey.mockResolvedValue({ ok: true });
  mocks.listSecretKeys.mockResolvedValue([]);
  mocks.importEnv.mockResolvedValue({ rows: [{}], committed: true });
  mocks.setWorkspaceSecret.mockResolvedValue(undefined);
  mocks.deleteWorkspaceSecret.mockResolvedValue(true);
});

describe("secret lifecycle reaches the main audit log (#2527)", () => {
  it("reveal writes secret.revealed", async () => {
    await secretRevealHandler({ keyId: "k1" }, TEST_CTX);
    const e = onlyEvent();
    expect(e.eventType).toBe("secret.revealed");
    expect(e.capability).toBe("reveal_secret");
    expect(e.orgId).toBe(TEST_CTX.orgId);
    expect(e.workspaceId).toBe(TEST_CTX.workspaceId);
    expect(e.actorUserId).toBe(TEST_CTX.userId);
    expect(e.requestId).toBe(TEST_CTX.requestId);
  });

  it("export writes secret.exported", async () => {
    await secretExportHandler({}, TEST_CTX);
    expect(onlyEvent().eventType).toBe("secret.exported");
  });

  it("setting a value writes secret.value_changed", async () => {
    await secretValueSetHandler(
      { keyId: "k", environmentId: "e", value: "v" },
      TEST_CTX,
    );
    const e = onlyEvent();
    expect(e.eventType).toBe("secret.value_changed");
    expect(e.capability).toBe("set_secret_value");
  });

  it("unsetting a value writes the same type, told apart by capability", async () => {
    await secretValueUnsetHandler({ keyId: "k", environmentId: "e" }, TEST_CTX);
    const e = onlyEvent();
    expect(e.eventType).toBe("secret.value_changed");
    expect(e.capability).toBe("unset_secret_value");
  });

  it("deleting a key writes secret.key_deleted", async () => {
    await secretKeyDeleteHandler({ keyId: "k" }, TEST_CTX);
    expect(onlyEvent().eventType).toBe("secret.key_deleted");
  });

  it("upserting a key writes a value change, because it can carry a defaultValue", async () => {
    await secretKeyUpsertHandler({ key: "K", sensitive: true }, TEST_CTX);
    const e = onlyEvent();
    expect(e.eventType).toBe("secret.value_changed");
    expect(e.capability).toBe("upsert_secret_key");
  });

  it("a committed env import writes one row", async () => {
    await secretImportEnvHandler({ text: "A=1", commit: true }, TEST_CTX);
    expect(onlyEvent().capability).toBe("import_env_secrets");
  });

  it("a DRY RUN import writes nothing, because it changed no secret", async () => {
    // The reachability point of oxagen#2530: a shallow "does the file call
    // emit" check cannot tell this case from the one above.
    mocks.importEnv.mockResolvedValue({ rows: [{}], committed: false });
    await secretImportEnvHandler({ text: "A=1", commit: false }, TEST_CTX);
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("listing key names writes nothing, and says why in an audit-exempt comment", async () => {
    await secretKeyListHandler({}, TEST_CTX);
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});

describe("plugin credential lifecycle reaches the main audit log (#2533)", () => {
  it("setting a credential writes plugin.credential_set", async () => {
    await pluginCredentialSetHandler(
      { orgListingId: "ol_1", authKind: "secret", secret: "s" },
      TEST_CTX,
    );
    const e = onlyEvent();
    expect(e.eventType).toBe("plugin.credential_set");
    expect(e.capability).toBe("set_plugin_secret");
    expect(e.outcome).toBe("success");
  });

  it("revoking a credential writes plugin.credential_revoked", async () => {
    listingRows.push({ id: "ol_1" });
    await pluginCredentialRevokeHandler({ orgListingId: "ol_1" }, TEST_CTX);
    const e = onlyEvent();
    expect(e.eventType).toBe("plugin.credential_revoked");
    expect(e.capability).toBe("revoke_plugin_credential");
  });

  it("a failed credential write audits nothing, so a row means it happened", async () => {
    mocks.setWorkspaceSecret.mockRejectedValue(new Error("kms down"));
    await expect(
      pluginCredentialSetHandler(
        { orgListingId: "ol_1", authKind: "secret", secret: "s" },
        TEST_CTX,
      ),
    ).rejects.toThrow("kms down");
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});

// ── The handler-side role guard (oxagen#2819) ───────────────────────────────
//
// checkIAM returns tier_gate -> allow for every org below the enterprise tier,
// so the contract's `defaultEffect: "deny"` and its Owner/Admin `defaultRoles`
// were never read and any member of the org could call these three. Each case
// below asserts BOTH halves: the call is refused, and the side effect it exists
// to cause never happens.

describe("secret and plugin-credential writes require an org Owner or Admin", () => {
  it("a viewer cannot export the workspace's secrets", async () => {
    mockMembershipRows.mockReturnValue([{ role: "viewer" }]);
    await expect(secretExportHandler({}, TEST_CTX)).rejects.toThrow(
      "Forbidden: export_secrets requires org Owner or Admin",
    );
    expect(mocks.exportSecrets).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("a viewer cannot reveal a secret", async () => {
    mockMembershipRows.mockReturnValue([{ role: "viewer" }]);
    await expect(
      secretRevealHandler({ keyId: "k", environmentId: "e" }, TEST_CTX),
    ).rejects.toThrow("Forbidden: reveal_secret requires org Owner or Admin");
    expect(mocks.revealSecret).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("a member cannot overwrite a secret's value", async () => {
    mockMembershipRows.mockReturnValue([{ role: "member" }]);
    await expect(
      secretValueSetHandler(
        { keyId: "k", environmentId: "e", value: "attacker" },
        TEST_CTX,
      ),
    ).rejects.toThrow(
      "Forbidden: set_secret_value requires org Owner or Admin",
    );
    expect(mocks.setSecretValue).not.toHaveBeenCalled();
  });

  it("a member cannot store a plugin credential", async () => {
    mockMembershipRows.mockReturnValue([{ role: "member" }]);
    await expect(
      pluginCredentialSetHandler(
        { orgListingId: "ol_1", authKind: "secret", secret: "s" },
        TEST_CTX,
      ),
    ).rejects.toThrow(
      "Forbidden: set_plugin_secret requires org Owner or Admin",
    );
    expect(mocks.setWorkspaceSecret).not.toHaveBeenCalled();
  });

  it("a caller with no membership row at all is refused", async () => {
    mockMembershipRows.mockReturnValue([]);
    await expect(secretExportHandler({}, TEST_CTX)).rejects.toThrow(
      "Forbidden: export_secrets requires org Owner or Admin",
    );
    expect(mocks.exportSecrets).not.toHaveBeenCalled();
  });

  it("accepts a TitleCase membership role — the column carries both casings", async () => {
    mockMembershipRows.mockReturnValue([{ role: "Admin" }]);
    await secretExportHandler({}, TEST_CTX);
    expect(mocks.exportSecrets).toHaveBeenCalledTimes(1);
  });

  it("refuses a caller with no authenticated principal", async () => {
    await expect(
      secretExportHandler({}, makeCTX({ userId: null, apiKeyId: null })),
    ).rejects.toThrow(
      "Unauthorized: export_secrets requires an authenticated principal",
    );
    expect(mocks.exportSecrets).not.toHaveBeenCalled();
  });

  it("lets an api-key principal through — it has no org_users row to read, and its authority is the key's scope", async () => {
    await secretExportHandler(
      {},
      makeCTX({ userId: null, apiKeyId: "aky_ci" }),
    );
    expect(mocks.exportSecrets).toHaveBeenCalledTimes(1);
    expect(mockMembershipRows).not.toHaveBeenCalled();
  });
});
