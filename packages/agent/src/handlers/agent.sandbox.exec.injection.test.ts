import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const h = vi.hoisted(() => {
  const driver = {
    name: "modal",
    supportsSessions: true,
    run: vi.fn(),
    stream: vi.fn(),
    createSession: vi.fn(),
    execInSession: vi.fn(),
    snapshotSession: vi.fn(),
    restoreSession: vi.fn(),
    stopSession: vi.fn(),
    sessionStatus: vi.fn(),
  };
  return {
    driver,
    isSandboxAvailable: vi.fn(() => true),
    isDurableSandboxDriver: vi.fn(() => true),
    resolveEnvironmentSecrets: vi.fn(
      async (): Promise<Record<string, string>> => ({}),
    ),
    listSecretKeys: vi.fn(
      async (): Promise<
        Array<{
          id: string;
          key: string;
          sensitive: boolean;
          memo: string | null;
        }>
      > => [],
    ),
    insertEvents: vi.fn(async () => undefined),
  };
});

vi.mock("@oxagen/sandbox", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/sandbox")>();
  return {
    ...real,
    getSandbox: () => h.driver,
    isSandboxAvailable: h.isSandboxAvailable,
    isDurableSandboxDriver: h.isDurableSandboxDriver,
  };
});
vi.mock("@oxagen/plugins", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/plugins")>();
  return {
    ...real,
    resolveEnvironmentSecrets: h.resolveEnvironmentSecrets,
    listSecretKeys: h.listSecretKeys,
  };
});
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...real, insertEvents: h.insertEvents };
});

const fake = createFakeTx();
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

import { agentSandboxExecHandler } from "./agent.sandbox.exec";

const okExec = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 5,
  timedOut: false,
  gone: false,
};

function row(meta: Record<string, unknown>) {
  return {
    id: "uuid-1",
    publicId: "sbx_1",
    sandboxId: "sb-aaa",
    snapshotId: null,
    image: "agent",
    status: "running",
    metadata: {
      memoryMb: 2048,
      ttlSeconds: 86_400,
      idleTimeoutSeconds: 1_200,
      network: "allow",
      ...meta,
    },
  };
}

beforeEach(() => {
  fake.reset();
  h.driver.execInSession.mockReset().mockResolvedValue(okExec);
  h.driver.restoreSession.mockReset();
  h.resolveEnvironmentSecrets.mockReset().mockResolvedValue({});
  h.listSecretKeys.mockReset().mockResolvedValue([]);
  h.insertEvents.mockClear();
});

describe("agent.sandbox.exec — environment secret injection", () => {
  it("injects the session's bound environment secrets below the caller env", async () => {
    fake.enqueue([row({ environmentId: "env_7" })]); // getSessionByPublicId
    fake.enqueue([]); // touchSession
    h.resolveEnvironmentSecrets.mockResolvedValue({
      API_BASE: "vault",
      TOKEN: "t",
    });

    await agentSandboxExecHandler(
      {
        sessionId: "sbx_1",
        command: "printenv",
        timeoutMs: 30_000,
        env: { API_BASE: "caller" },
      },
      CTX,
    );

    expect(h.resolveEnvironmentSecrets).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      environmentId: "env_7",
    });
    // Caller wins on collision; vault-only key present.
    expect(h.driver.execInSession.mock.calls[0]![0].env).toEqual({
      API_BASE: "caller",
      TOKEN: "t",
    });
  });

  it("does not resolve secrets when the session has no bound environment", async () => {
    fake.enqueue([row({})]); // no environmentId
    fake.enqueue([]);

    await agentSandboxExecHandler(
      {
        sessionId: "sbx_1",
        command: "ls",
        timeoutMs: 30_000,
        env: { SAFE: "x" },
      },
      CTX,
    );

    expect(h.resolveEnvironmentSecrets).not.toHaveBeenCalled();
    expect(h.driver.execInSession.mock.calls[0]![0].env).toEqual({ SAFE: "x" });
  });

  it("applies the session's frozen template selection + literal env", async () => {
    fake.enqueue([
      row({
        environmentId: "env_7",
        secretSelection: { keyPublicIds: ["sk_1"] },
        literalEnv: { SWEBENCH_SPLIT: "verified" },
      }),
    ]); // getSessionByPublicId
    fake.enqueue([]); // touchSession
    h.resolveEnvironmentSecrets.mockResolvedValue({ EVAL_API_KEY: "v" });
    h.listSecretKeys.mockResolvedValue([
      { id: "sk_1", key: "EVAL_API_KEY", sensitive: true, memo: null },
    ]);

    await agentSandboxExecHandler(
      {
        sessionId: "sbx_1",
        command: "printenv",
        timeoutMs: 30_000,
        env: { CALLER: "c" },
      },
      CTX,
    );

    expect(h.resolveEnvironmentSecrets).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      environmentId: "env_7",
      selection: { keyPublicIds: ["sk_1"] },
    });
    // literal (lowest) + vault + caller (highest).
    expect(h.driver.execInSession.mock.calls[0]![0].env).toEqual({
      SWEBENCH_SPLIT: "verified",
      EVAL_API_KEY: "v",
      CALLER: "c",
    });
  });

  it("reuses the INJECTED env (not the raw caller env) on a snapshot-restore retry", async () => {
    // snapshotId is a TOP-LEVEL column (not metadata), so build the row inline.
    fake.enqueue([
      {
        id: "uuid-1",
        publicId: "sbx_1",
        sandboxId: "sb-aaa",
        snapshotId: "snap-1",
        image: "agent",
        status: "running",
        metadata: {
          memoryMb: 2048,
          ttlSeconds: 86_400,
          idleTimeoutSeconds: 1_200,
          network: "allow",
          environmentId: "env_7",
        },
      },
    ]); // getSessionByPublicId
    fake.enqueue([]); // rebindSession
    fake.enqueue([]); // touchSession
    h.resolveEnvironmentSecrets.mockResolvedValue({ TOKEN: "vault" });
    // First exec reports the sandbox was reaped; restore then a clean retry.
    h.driver.execInSession
      .mockResolvedValueOnce({ ...okExec, gone: true })
      .mockResolvedValueOnce(okExec);
    h.driver.restoreSession.mockResolvedValue({
      sandboxId: "sb-restored",
      status: "running",
      createdAt: "t",
    });

    const out = await agentSandboxExecHandler(
      {
        sessionId: "sbx_1",
        command: "ls",
        timeoutMs: 30_000,
        env: { API_BASE: "caller" },
      },
      CTX,
    );

    expect(out.restored).toBe(true);
    // Both attempts see the same merged env (vault below caller) — the retry must
    // NOT fall back to the raw caller env and drop the vault secret.
    const injected = { TOKEN: "vault", API_BASE: "caller" };
    expect(h.driver.execInSession.mock.calls[0]![0].env).toEqual(injected);
    expect(h.driver.execInSession.mock.calls[1]![0].env).toEqual(injected);
    expect(h.driver.execInSession.mock.calls[1]![0].sandboxId).toBe(
      "sb-restored",
    );
  });
});
