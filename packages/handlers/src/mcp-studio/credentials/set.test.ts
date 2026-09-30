// set.test.ts: set_mcp_credential over the in-memory credential store.
// store.pg.test.ts runs the same write against Postgres.
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import type { ToolStudioCredentialSetInput } from "@oxagen/oxagen/contracts/tool.studio.credential.set";
import { TEST_CTX } from "../../test-utils/fixtures";
import { createSetMcpCredentialHandler, type SetMcpCredentialDeps } from "./set";
import type { CredentialScope } from "./store";
import { MemoryCredentialStore, testKms } from "./test-support";

const mocks = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../../logger", () => ({ logger: { info: mocks.info, warn: vi.fn(), error: vi.fn() } }));

const KMS = testKms();
const SECRET = "sk_test_fake_1";
const CLIENT_SECRET = "cs_test_fake_2";

function forbidden(): HandlerError {
  return new HandlerError({ code: "forbidden", reason: "role_required", message: "You need the Admin role." });
}

/** One in-memory store per workspace, so a read in another workspace starts empty. */
function rig(overrides: Partial<SetMcpCredentialDeps> = {}) {
  const stores = new Map<string, MemoryCredentialStore>();
  const storeFor = (scope: CredentialScope): MemoryCredentialStore => {
    const key = `${scope.orgId}/${scope.workspaceId}`;
    let store = stores.get(key);
    if (store === undefined) {
      store = new MemoryCredentialStore(KMS);
      stores.set(key, store);
    }
    return store;
  };
  const deps: SetMcpCredentialDeps = {
    store: storeFor,
    kms: () => KMS,
    authorize: vi.fn(async () => "u_7"),
    emit: vi.fn(),
    ...overrides,
  };
  const handler = createSetMcpCredentialHandler(deps);
  const home = storeFor({ orgId: TEST_CTX.orgId, workspaceId: TEST_CTX.workspaceId });
  const set = (input: ToolStudioCredentialSetInput, ctx = TEST_CTX) => handler(input, ctx);
  return { deps, handler, home, storeFor, set };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("The handler did not refuse.");
}

afterEach(() => {
  mocks.info.mockClear();
});

describe("set_mcp_credential", () => {
  it("creates a service secret, sealed, and answers with the name and reference", async () => {
    const { home, set, deps } = rig();

    const out = await set({ name: "stripe-live", kind: "secret", secret: SECRET });

    expect(out).toEqual({ name: "stripe-live", reference: "oxagen:credential/stripe-live", created: true });
    const row = await home.credentialByName("stripe-live");
    expect(row).toMatchObject({ authKind: "secret", status: "active", oauthClientId: null, tokenKmsKeyId: KMS.keyId });
    expect(row?.secretEnc?.toString("utf8")).not.toContain(SECRET);
    await expect(home.openCredential(row?.id ?? "")).resolves.toMatchObject({ secret: SECRET, oauthClientSecret: null });
    expect(deps.authorize).toHaveBeenCalledOnce();
    expect(deps.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.credential_set",
        capability: "set_mcp_credential",
        actorUserId: "u_7",
        outcome: "success",
      }),
    );
  });

  it("creates an OAuth client with its id in the clear and its secret sealed", async () => {
    const { home, set } = rig();

    await set({ name: "github-app", kind: "oauth_client", clientId: "Iv1.abc", clientSecret: CLIENT_SECRET });

    const row = await home.credentialByName("github-app");
    expect(row).toMatchObject({ authKind: "oauth", oauthClientId: "Iv1.abc", secretEnc: null });
    await expect(home.openCredential(row?.id ?? "")).resolves.toMatchObject({ oauthClientSecret: CLIENT_SECRET, secret: null });
  });

  it("replaces the value behind a name and keeps the row", async () => {
    const { home, set } = rig();
    await set({ name: "stripe-live", kind: "secret", secret: SECRET });
    const first = await home.credentialByName("stripe-live");

    const out = await set({ name: "stripe-live", kind: "secret", secret: "sk_test_fake_3" });

    expect(out.created).toBe(false);
    const second = await home.credentialByName("stripe-live");
    expect(second?.id).toBe(first?.id);
    await expect(home.openCredential(second?.id ?? "")).resolves.toMatchObject({ secret: "sk_test_fake_3" });
  });

  it("clears the old kind's secret when a replace changes the kind", async () => {
    const { home, set } = rig();
    await set({ name: "partner-api", kind: "secret", secret: SECRET });

    await set({ name: "partner-api", kind: "oauth_client", clientId: "client-9", clientSecret: CLIENT_SECRET });

    const row = await home.credentialByName("partner-api");
    expect(row).toMatchObject({ authKind: "oauth", oauthClientId: "client-9", secretEnc: null });
    await expect(home.openCredential(row?.id ?? "")).resolves.toMatchObject({ secret: null, oauthClientSecret: CLIENT_SECRET });
  });

  it("stores the credential in the caller's workspace only", async () => {
    const { set, storeFor } = rig();
    await set({ name: "stripe-live", kind: "secret", secret: SECRET });

    const other = storeFor({ orgId: TEST_CTX.orgId, workspaceId: "ws_other" });
    await expect(other.credentialByName("stripe-live")).resolves.toBeNull();
  });

  it("refuses a caller without the role and writes nothing", async () => {
    const { home, set, deps } = rig({
      authorize: vi.fn(async () => {
        throw forbidden();
      }),
    });

    const err = await refusal(set({ name: "stripe-live", kind: "secret", secret: SECRET }));

    expect(err).toBeInstanceOf(HandlerError);
    expect((err as HandlerError).code).toBe("forbidden");
    expect(home.writes).toEqual([]);
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it("refuses to store a credential when the vault has no key", async () => {
    const { home, set } = rig({ kms: () => null });

    const err = await refusal(set({ name: "stripe-live", kind: "secret", secret: SECRET }));

    expect((err as Error).message).toContain("AUTH_TOKEN_ENCRYPTION_KEY");
    expect(home.writes).toEqual([]);
  });

  it("puts no secret in the response, the audit event, or the log", async () => {
    const { set, deps } = rig();

    const out = await set({ name: "github-app", kind: "oauth_client", clientId: "Iv1.abc", clientSecret: CLIENT_SECRET });
    await set({ name: "stripe-live", kind: "secret", secret: SECRET });

    const seen = JSON.stringify([out, vi.mocked(deps.emit).mock.calls, mocks.info.mock.calls]);
    expect(seen).not.toContain(SECRET);
    expect(seen).not.toContain(CLIENT_SECRET);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ name: "stripe-live", kind: "secret" }),
      "set_mcp_credential: stored",
    );
  });
});
