import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

// setupCmd runs at CREATE time, before any agent.sandbox.exec, so the start
// handler must resolve the same trusted env (environment vault + template
// literal env) the exec path injects and hand it to the driver as setupEnv —
// otherwise a private-repo clone in setup has no credential channel and git
// dies trying to prompt for a username (the 2026-07-09 runner-422 shape).
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

import { agentSandboxStartHandler } from "./agent.sandbox.start";

const START_INPUT = {
  image: "agent" as const,
  memoryMb: 2048,
  ttlSeconds: 86_400,
  idleTimeoutSeconds: 1_200,
  network: "allow" as const,
};

beforeEach(() => {
  fake.reset();
  h.driver.createSession.mockReset().mockResolvedValue({
    sandboxId: "sb-new",
    status: "running",
    createdAt: "2026-07-10T00:00:00.000Z",
  });
  h.resolveEnvironmentSecrets.mockReset().mockResolvedValue({});
  h.listSecretKeys.mockReset().mockResolvedValue([]);
  h.insertEvents.mockClear();
});

describe("agent.sandbox.start — trusted env for setupCmd", () => {
  it("resolves the bound environment's vault and passes it as setupEnv", async () => {
    h.resolveEnvironmentSecrets.mockResolvedValue({ GITHUB_TOKEN: "ghs_x" });
    fake.enqueue([{ publicId: "sbx_new" }]); // insertSession().returning()

    await agentSandboxStartHandler(
      {
        ...START_INPUT,
        setupCmd:
          "git clone https://x-access-token:$GITHUB_TOKEN@github.com/o/r",
        environmentId: "env_7",
      },
      CTX,
    );

    expect(h.resolveEnvironmentSecrets).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
      environmentId: "env_7",
    });
    expect(h.driver.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        setupCmd: expect.stringContaining("git clone"),
        setupEnv: { GITHUB_TOKEN: "ghs_x" },
      }),
    );
  });

  it("does not touch the vault when there is no setupCmd", async () => {
    fake.enqueue([{ publicId: "sbx_new" }]);

    await agentSandboxStartHandler(
      { ...START_INPUT, environmentId: "env_7" },
      CTX,
    );

    expect(h.resolveEnvironmentSecrets).not.toHaveBeenCalled();
    expect(h.driver.createSession.mock.calls[0]![0].setupEnv).toBeUndefined();
  });

  it("omits setupEnv entirely when nothing resolves (no environment/template)", async () => {
    fake.enqueue([{ publicId: "sbx_new" }]);

    await agentSandboxStartHandler(
      { ...START_INPUT, setupCmd: "echo hi" },
      CTX,
    );

    expect(h.resolveEnvironmentSecrets).not.toHaveBeenCalled();
    const spec = h.driver.createSession.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect("setupEnv" in spec).toBe(false);
  });
});
