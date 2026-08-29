/**
 * resolve-sandbox-template.test.ts
 *
 * Covers the explicit-template branch of resolveSandboxTemplateForRun: when a
 * run pins a `sandboxTemplateId`, that exact template and its OWN environment
 * are resolved, and both must be active. The
 * env→binding→default chain is covered separately in
 * resolve-sandbox-template-chain.test.ts; here we prove the short-circuit and
 * its active-preflight errors.
 *
 * @oxagen/database withTenantDb runs the callback against a queue-driven fake tx;
 * the vault service is mocked since this branch never touches it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface State {
  selectQueue: unknown[][];
}
const state: State = { selectQueue: [] };

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async (n: number) => result.slice(0, n),
    orderBy: async () => result,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  });
  return chain;
}

function makeTx() {
  return {
    select: (_cols: unknown) => makeChain(state.selectQueue.shift() ?? []),
  };
}

const vaultMocks = vi.hoisted(() => ({
  listSecretKeys: vi.fn(),
  upsertSecretKey: vi.fn(),
}));
vi.mock("../vault/vault-secret-service", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../vault/vault-secret-service")>();
  return {
    ...real,
    listSecretKeys: vaultMocks.listSecretKeys,
    upsertSecretKey: vaultMocks.upsertSecretKey,
  };
});
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
});

import { resolveSandboxTemplateForRun } from "./sandbox-template-service";

const actor = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" };

function tplRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sbx-int",
    publicId: "sbx-pub",
    environmentInternalId: "env-int",
    environmentPublicId: "env-pub",
    environmentName: "Prod",
    environmentSlug: "prod",
    name: "SWE-bench prewarmed",
    slug: "swe-bench-prewarmed",
    description: null,
    isDefault: true,
    isActive: true,
    provider: "modal",
    runtime: "ghcr.io/x/y@sha256:abc",
    resources: { vcpu: 2 },
    network: { mode: "public" },
    secretSelection: "all",
    literalEnv: {},
    ...overrides,
  };
}

function envRow(isActive = true) {
  return { id: "env-int", name: "Prod", slug: "prod", isActive };
}

beforeEach(() => {
  state.selectQueue = [];
});

describe("resolveSandboxTemplateForRun — explicit sandboxTemplateId", () => {
  it("resolves the pinned template and its own environment", async () => {
    state.selectQueue = [
      [tplRow()], // loadTemplateRow
      [envRow(true)], // loadEnvironment
      [tplRow()], // loadTemplateWithTools → loadTemplateRow
      [], // loadToolsFor
    ];

    const result = await resolveSandboxTemplateForRun(actor, {
      sandboxTemplateId: "sbx-pub",
    });

    expect(result.environment).toEqual({
      id: "env-pub",
      name: "Prod",
      slug: "prod",
    });
    expect(result.template.id).toBe("sbx-pub");
    expect(result.template.provider).toBe("modal");
    expect(result.template.runtime).toBe("ghcr.io/x/y@sha256:abc");
    expect(result.template.environmentId).toBe("env-pub");
  });

  it("throws a clear error when the pinned template's environment is inactive", async () => {
    state.selectQueue = [[tplRow()], [envRow(false)]];
    await expect(
      resolveSandboxTemplateForRun(actor, { sandboxTemplateId: "sbx-pub" }),
    ).rejects.toThrow(/inactive/);
  });

  it("throws a clear error when the pinned template itself is inactive", async () => {
    state.selectQueue = [
      [tplRow({ isActive: false })],
      [envRow(true)],
      [tplRow({ isActive: false })],
      [],
    ];
    await expect(
      resolveSandboxTemplateForRun(actor, { sandboxTemplateId: "sbx-pub" }),
    ).rejects.toThrow(/inactive/);
  });
});
