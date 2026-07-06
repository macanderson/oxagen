import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const h = vi.hoisted(() => ({
  resolveEnvironmentSecrets: vi.fn<
    (a: { orgId: string; workspaceId: string; environmentId: string }) => Promise<Record<string, string>>
  >(),
}));

vi.mock("@oxagen/plugins", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/plugins")>();
  return { ...real, resolveEnvironmentSecrets: h.resolveEnvironmentSecrets };
});

import { injectEnvironmentSecrets } from "./_environment-env";

beforeEach(() => {
  h.resolveEnvironmentSecrets.mockReset();
});

describe("injectEnvironmentSecrets", () => {
  it("sanitizes caller env and reports reserved keys as stripped (no environment)", async () => {
    const { env, strippedKeys, injectedKeys } = await injectEnvironmentSecrets(
      CTX,
      undefined,
      { API_BASE: "https://x", DATABASE_URL: "postgres://secret", PATH: "/evil" },
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
    const { env, strippedKeys } = await injectEnvironmentSecrets(CTX, undefined, {
      MODAL_TOKEN: "x",
    });
    expect(env).toBeUndefined();
    expect(strippedKeys).toEqual(["MODAL_TOKEN"]);
  });
});
