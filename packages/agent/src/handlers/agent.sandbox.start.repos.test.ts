import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

// repos[] on start_sandbox composes a server-side clone script that is prepended
// to any user/preset setupCmd and runs once at create time. The workspace GitHub
// token is resolved server-side and delivered ONLY via setupEnv as $GITHUB_TOKEN
// (never in the script text, never persisted). The requested repos (owner/repo/
// branch only) are persisted into session metadata for list_sandboxes to surface.
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
    resolveGitHubToken: vi.fn(async (): Promise<string> => "ghs_repo_token"),
    insertSession: vi.fn(
      async (
        _ctx: unknown,
        _args: { metadata: Record<string, unknown> },
      ): Promise<string> => "sbx_new",
    ),
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
vi.mock("@oxagen/github/workspace-token", () => ({
  resolveGitHubToken: h.resolveGitHubToken,
}));
// Spy on the registry insert so we can assert the persisted metadata directly,
// while keeping requireDurableDriver and the rest of the session helpers real.
vi.mock("./_sandbox-session", async (importOriginal) => {
  const real = await importOriginal<typeof import("./_sandbox-session")>();
  return { ...real, insertSession: h.insertSession };
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

/** Grab the spec handed to driver.createSession on the fresh-provision path. */
function createdSpec(): Record<string, unknown> {
  return h.driver.createSession.mock.calls[0]![0] as Record<string, unknown>;
}
/** Grab the metadata persisted via insertSession. */
function persistedMetadata(): Record<string, unknown> {
  return h.insertSession.mock.calls[0]![1].metadata;
}

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
  h.resolveGitHubToken.mockReset().mockResolvedValue("ghs_repo_token");
  h.insertSession.mockReset().mockResolvedValue("sbx_new");
});

describe("agent.sandbox.start — repos[] cloning", () => {
  it("prepends the composed clone script and delivers GITHUB_TOKEN via setupEnv", async () => {
    await agentSandboxStartHandler(
      {
        ...START_INPUT,
        repos: [{ owner: "acme", repo: "api", branch: "main" }],
        setupCmd: "pnpm i",
      },
      CTX,
    );

    const spec = createdSpec();
    const setupCmd = spec.setupCmd as string;
    // The whole composed command runs inside WORKSPACE_ROOT (/work) first, then
    // the clone script, then the caller's setupCmd — all joined by &&.
    expect(
      setupCmd.startsWith(
        "mkdir -p /work && cd /work && mkdir -p /work && git clone",
      ),
    ).toBe(true);
    expect(setupCmd).toContain("--branch 'main' --single-branch");
    expect(setupCmd).toContain(
      "x-access-token:${GITHUB_TOKEN}@github.com/acme/api.git",
    );
    expect(setupCmd).toContain("'/work/api'");
    expect(setupCmd).not.toContain("/workspace");
    expect(setupCmd.endsWith(" && pnpm i")).toBe(true);
    // Token rides setupEnv, never the script text.
    expect(spec.setupEnv).toEqual({ GITHUB_TOKEN: "ghs_repo_token" });
    expect(setupCmd).not.toContain("ghs_repo_token");
  });

  it("persists repos (owner/repo/branch only) into session metadata", async () => {
    await agentSandboxStartHandler(
      {
        ...START_INPUT,
        repos: [
          { owner: "acme", repo: "api", branch: "main" },
          { owner: "globex", repo: "web" },
        ],
      },
      CTX,
    );

    expect(persistedMetadata().repos).toEqual([
      { owner: "acme", repo: "api", branch: "main" },
      { owner: "globex", repo: "web" },
    ]);
    // The token must never be persisted anywhere on the metadata blob.
    expect(JSON.stringify(persistedMetadata())).not.toContain("ghs_repo_token");
  });

  it("clones public repos anonymously (no GITHUB_TOKEN) when no connection resolves", async () => {
    h.resolveGitHubToken.mockRejectedValueOnce(
      new Error("No GitHub connection for this workspace"),
    );

    await agentSandboxStartHandler(
      { ...START_INPUT, repos: [{ owner: "acme", repo: "api" }] },
      CTX,
    );

    const spec = createdSpec();
    const setupCmd = spec.setupCmd as string;
    expect(setupCmd).toContain(
      "git clone 'https://github.com/acme/api.git' '/work/api'",
    );
    expect(setupCmd).not.toContain("GITHUB_TOKEN");
    // No token resolved → no setupEnv key added.
    expect("setupEnv" in spec).toBe(false);
  });

  it("still runs setupCmd in /work when repos[] is absent (no clone step, but same cwd guarantee)", async () => {
    await agentSandboxStartHandler(
      { ...START_INPUT, setupCmd: "echo hi" },
      CTX,
    );

    const spec = createdSpec();
    // No repos → no clone script, but the caller's setupCmd still runs inside
    // WORKSPACE_ROOT so its own relative paths land where list_sandbox_files
    // looks, on every driver (Modal's durable images set no WORKDIR).
    expect(spec.setupCmd).toBe("mkdir -p /work && cd /work && echo hi");
    expect(h.resolveGitHubToken).not.toHaveBeenCalled();
    expect("repos" in persistedMetadata()).toBe(false);
  });
});
