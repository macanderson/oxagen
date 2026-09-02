import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const h = vi.hoisted(() => ({
  resolveEnvironmentSecrets:
    vi.fn<
      (a: {
        orgId: string;
        workspaceId: string;
        environmentId: string;
        selection?: unknown;
      }) => Promise<Record<string, string>>
    >(),
  listSecretKeys:
    vi.fn<
      (a: { orgId: string; workspaceId: string }) => Promise<
        Array<{
          id: string;
          key: string;
          sensitive: boolean;
          memo: string | null;
        }>
      >
    >(),
}));

vi.mock("@oxagen/plugins", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/plugins")>();
  return {
    ...real,
    resolveEnvironmentSecrets: h.resolveEnvironmentSecrets,
    listSecretKeys: h.listSecretKeys,
  };
});

import { injectEnvironmentSecrets } from "./_environment-env";

beforeEach(() => {
  h.resolveEnvironmentSecrets.mockReset();
  h.listSecretKeys.mockReset().mockResolvedValue([]);
});

describe("injectEnvironmentSecrets", () => {
  it("sanitizes caller env and reports reserved keys as stripped (no environment)", async () => {
    const { env, strippedKeys, injectedKeys } = await injectEnvironmentSecrets(
      CTX,
      undefined,
      {
        API_BASE: "https://x",
        DATABASE_URL: "postgres://secret",
        PATH: "/evil",
      },
    );
    expect(env).toEqual({ API_BASE: "https://x" });
    expect(strippedKeys.sort()).toEqual(["DATABASE_URL", "PATH"]);
    expect(injectedKeys).toEqual([]);
    expect(h.resolveEnvironmentSecrets).not.toHaveBeenCalled();
  });

  it("merges trusted vault secrets BELOW the caller env (caller wins)", async () => {
    h.resolveEnvironmentSecrets.mockResolvedValue({
      API_BASE: "https://vault-default",
      SERVICE_KEY: "vault-key",
    });
    const { env, injectedKeys } = await injectEnvironmentSecrets(CTX, "env_1", {
      API_BASE: "https://caller-override",
    });
    // Caller value wins on collision; vault-only key is present.
    expect(env).toEqual({
      API_BASE: "https://caller-override",
      SERVICE_KEY: "vault-key",
    });
    expect(injectedKeys.sort()).toEqual(["API_BASE", "SERVICE_KEY"]);
    expect(h.resolveEnvironmentSecrets).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      environmentId: "env_1",
    });
  });

  it("does NOT strip reserved-shaped vault secrets (that is the point of the vault)", async () => {
    // A legitimately-named cloud credential would be denylisted if treated as
    // caller env, but the vault is trusted so it must survive.
    h.resolveEnvironmentSecrets.mockResolvedValue({
      AWS_ACCESS_KEY_ID: "AKIA...",
      DATABASE_URL: "postgres://prod",
    });
    const { env } = await injectEnvironmentSecrets(CTX, "env_1", undefined);
    expect(env).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA...",
      DATABASE_URL: "postgres://prod",
    });
  });

  it("returns undefined env when nothing safe remains", async () => {
    const { env, strippedKeys } = await injectEnvironmentSecrets(
      CTX,
      undefined,
      {
        MODAL_TOKEN: "x",
      },
    );
    expect(env).toBeUndefined();
    expect(strippedKeys).toEqual(["MODAL_TOKEN"]);
  });

  it("merges lowest→highest: literal_env < vault < caller (each layer wins over the one below)", async () => {
    h.resolveEnvironmentSecrets.mockResolvedValue({
      SHARED: "vault",
      VAULT_ONLY: "v",
      LITERAL_AND_VAULT: "vault-wins-over-literal",
    });
    const { env } = await injectEnvironmentSecrets(
      CTX,
      "env_1",
      { SHARED: "caller" },
      {
        literalEnv: {
          SHARED: "literal",
          LITERAL_ONLY: "l",
          LITERAL_AND_VAULT: "literal-loses",
        },
      },
    );
    expect(env).toEqual({
      SHARED: "caller", // caller beats vault beats literal
      VAULT_ONLY: "v",
      LITERAL_ONLY: "l",
      LITERAL_AND_VAULT: "vault-wins-over-literal", // vault beats literal
    });
  });

  it("literal_env is NOT subject to the reserved-key denylist (trusted config)", async () => {
    h.resolveEnvironmentSecrets.mockResolvedValue({});
    // A reserved-shaped key from the caller is stripped, but the same shape in
    // literal_env (authored config) survives.
    const { env, strippedKeys } = await injectEnvironmentSecrets(
      CTX,
      "env_1",
      { AWS_REGION: "caller-set" },
      { literalEnv: { AWS_DEFAULT_REGION: "us-east-1" } },
    );
    expect(env).toEqual({ AWS_DEFAULT_REGION: "us-east-1" });
    expect(strippedKeys).toEqual(["AWS_REGION"]);
  });

  it("passes the template's secret selection through to resolveEnvironmentSecrets", async () => {
    h.resolveEnvironmentSecrets.mockResolvedValue({ API_KEY: "v" });
    h.listSecretKeys.mockResolvedValue([
      { id: "sk_1", key: "API_KEY", sensitive: true, memo: null },
    ]);
    await injectEnvironmentSecrets(CTX, "env_1", undefined, {
      selection: { keyPublicIds: ["sk_1"] },
    });
    expect(h.resolveEnvironmentSecrets).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      environmentId: "env_1",
      selection: { keyPublicIds: ["sk_1"] },
    });
  });

  it("reports selected-but-unset keys as missingRequiredKeys (by name), never a hard fail", async () => {
    // EVAL_API_KEY is selected but resolved unset (absent from the vault result).
    h.resolveEnvironmentSecrets.mockResolvedValue({ PRESENT: "v" });
    h.listSecretKeys.mockResolvedValue([
      { id: "sk_present", key: "PRESENT", sensitive: true, memo: null },
      { id: "sk_missing", key: "EVAL_API_KEY", sensitive: true, memo: null },
    ]);
    const { env, missingRequiredKeys } = await injectEnvironmentSecrets(
      CTX,
      "env_1",
      undefined,
      { selection: { keyPublicIds: ["sk_present", "sk_missing"] } },
    );
    expect(env).toEqual({ PRESENT: "v" });
    expect(missingRequiredKeys).toEqual(["EVAL_API_KEY"]);
  });

  it("does not run the preflight for an 'all' selection (no specifically-required keys)", async () => {
    h.resolveEnvironmentSecrets.mockResolvedValue({ A: "1" });
    const { missingRequiredKeys } = await injectEnvironmentSecrets(
      CTX,
      "env_1",
      undefined,
      {
        selection: "all",
      },
    );
    expect(missingRequiredKeys).toEqual([]);
    expect(h.listSecretKeys).not.toHaveBeenCalled();
  });
});
