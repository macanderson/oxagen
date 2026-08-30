import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SandboxResult, SandboxDriver } from "@oxagen/sandbox";

const mockSandboxResult: SandboxResult = {
  exitCode: 0,
  stdout: "hello world\n",
  stderr: "",
  durationMs: 123,
  timedOut: false,
  oomKilled: false,
};

const mockRun = vi.fn(async (): Promise<SandboxResult> => mockSandboxResult);

const mockDriver: SandboxDriver = {
  name: "mock",
  run: mockRun,
  async *stream() {},
};

vi.mock("@oxagen/sandbox", () => ({
  isSandboxAvailable: vi.fn(() => true),
  getSandbox: vi.fn((): SandboxDriver => mockDriver),
  // The handler imports DEFAULT_POLICY to build a template-derived effective
  // policy; mirror the real conservative defaults here.
  DEFAULT_POLICY: {
    allowedLanguages: ["node", "python", "shell"],
    maxTimeoutMs: 30_000,
    maxMemoryMb: 512,
    allowNetwork: false,
  },
}));

const { mockInsertEvents } = vi.hoisted(() => ({
  mockInsertEvents: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("@oxagen/telemetry", () => ({
  insertEvents: mockInsertEvents,
}));

const { mockResolveEnvSecrets, mockResolveTemplate, mockListSecretKeys } =
  vi.hoisted(() => ({
    mockResolveEnvSecrets: vi.fn(
      async (): Promise<Record<string, string>> => ({}),
    ),
    mockResolveTemplate: vi.fn(),
    mockListSecretKeys: vi.fn(
      async (): Promise<
        Array<{
          id: string;
          key: string;
          sensitive: boolean;
          memo: string | null;
        }>
      > => [],
    ),
  }));
vi.mock("@oxagen/plugins", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/plugins")>();
  return {
    ...real,
    resolveEnvironmentSecrets: mockResolveEnvSecrets,
    resolveSandboxTemplateForRun: mockResolveTemplate,
    listSecretKeys: mockListSecretKeys,
  };
});

import { agentCodeExecuteHandler } from "./agent.code.execute";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { isSandboxAvailable, getSandbox } from "@oxagen/sandbox";
import type {
  ResolvedSandboxTemplate,
  SandboxTemplateSummary,
} from "@oxagen/plugins";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

function makeTemplate(
  overrides: Partial<SandboxTemplateSummary> = {},
): SandboxTemplateSummary {
  return {
    id: "sbx_1",
    environmentId: "env_tpl",
    name: "SWE-bench prewarmed",
    slug: "swe-bench-prewarmed",
    description: null,
    isDefault: true,
    isActive: true,
    provider: "docker",
    runtime: null,
    resources: {},
    network: { mode: "public" },
    secretSelection: "all",
    literalEnv: {},
    tools: [],
    ...overrides,
  } as SandboxTemplateSummary;
}

function makeResolved(
  template: SandboxTemplateSummary,
): ResolvedSandboxTemplate {
  return {
    environment: { id: template.environmentId, name: "Env", slug: "env" },
    template,
  };
}

describe("agent.code.execute handler", () => {
  beforeEach(() => {
    mockRun.mockClear();
    mockInsertEvents.mockClear();
    mockInsertEvents.mockResolvedValue(undefined);
    vi.mocked(isSandboxAvailable).mockReturnValue(true);
    vi.mocked(getSandbox).mockReset().mockReturnValue(mockDriver);
    mockResolveEnvSecrets.mockReset();
    mockResolveEnvSecrets.mockResolvedValue({});
    mockResolveTemplate.mockReset();
    mockListSecretKeys.mockReset().mockResolvedValue([]);
  });

  it("returns sandbox result mapped to contract output", async () => {
    const result = await agentCodeExecuteHandler(
      {
        language: "node",
        code: 'console.log("hello world")',
        timeoutMs: 10_000,
        memoryMb: 256,
        network: "deny",
      },
      CTX,
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: "hello world\n",
      stderr: "",
      executionMs: 123,
      timedOut: false,
      oomKilled: false,
    });

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "node",
        code: 'console.log("hello world")',
        orgId: "org_1",
        workspaceId: "ws_1",
      }),
    );
  });

  it("throws when sandbox is unavailable", async () => {
    vi.mocked(isSandboxAvailable).mockReturnValue(false);

    await expect(
      agentCodeExecuteHandler(
        {
          language: "python",
          code: "print('hi')",
          timeoutMs: 5_000,
          memoryMb: 128,
          network: "deny",
        },
        CTX,
      ),
    ).rejects.toThrow("Code execution is not available");
  });

  it("maps a SandboxPolicyError from the seam to an invalid_input CapabilityError", async () => {
    // The dispatch seam throws SandboxPolicyError on a hard boundary (disallowed
    // language / network). The handler must re-surface it as a structured
    // capability error (→ 400) rather than let it leak as an unclassified 500.
    class SandboxPolicyError extends Error {
      readonly code = "sandbox_policy_violation";
      constructor(message: string) {
        super(message);
        this.name = "SandboxPolicyError";
      }
    }
    mockRun.mockRejectedValueOnce(
      new SandboxPolicyError("network access not allowed by policy"),
    );

    const promise = agentCodeExecuteHandler(
      {
        language: "node",
        code: "fetch('http://x')",
        timeoutMs: 5_000,
        memoryMb: 128,
        network: "allow",
      },
      CTX,
    );

    await expect(promise).rejects.toBeInstanceOf(CapabilityError);
    await expect(promise).rejects.toMatchObject({
      code: "invalid_input",
      message: "network access not allowed by policy",
    });
  });

  it("passes env vars and stdin to sandbox", async () => {
    await agentCodeExecuteHandler(
      {
        language: "shell",
        code: "echo $GREETING",
        stdin: "ignored by shell",
        env: { GREETING: "hi" },
        timeoutMs: 5_000,
        memoryMb: 64,
        network: "deny",
      },
      CTX,
    );

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { GREETING: "hi" },
        stdin: "ignored by shell",
        network: "deny",
      }),
    );
  });

  it("surfaces timed-out and oom-killed flags from sandbox result", async () => {
    mockRun.mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "killed",
      durationMs: 30_001,
      timedOut: true,
      oomKilled: false,
    });

    const result = await agentCodeExecuteHandler(
      {
        language: "node",
        code: "while(true){}",
        timeoutMs: 30_000,
        memoryMb: 256,
        network: "deny",
      },
      CTX,
    );

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("meters the run to ClickHouse with language and duration", async () => {
    mockRun.mockResolvedValueOnce({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 4242,
      timedOut: false,
      oomKilled: false,
    });

    await agentCodeExecuteHandler(
      {
        language: "python",
        code: "print(1)",
        timeoutMs: 5_000,
        memoryMb: 128,
        network: "deny",
      },
      CTX,
    );

    expect(mockInsertEvents).toHaveBeenCalledTimes(1);
    const rows = mockInsertEvents.mock.calls[0]![0] as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.event_type).toBe("agent.code.execute.ran");
    expect(row.org_id).toBe("org_1");
    expect(row.workspace_id).toBe("ws_1");
    const payload = JSON.parse(row.payload as string) as Record<
      string,
      unknown
    >;
    expect(payload.language).toBe("python");
    expect(payload.durationMs).toBe(4242);
    expect(payload.exitCode).toBe(0);
  });

  it("never fails the run when telemetry throws", async () => {
    mockInsertEvents.mockRejectedValueOnce(new Error("clickhouse down"));
    const result = await agentCodeExecuteHandler(
      {
        language: "node",
        code: "x",
        timeoutMs: 5_000,
        memoryMb: 64,
        network: "deny",
      },
      CTX,
    );
    expect(result.exitCode).toBe(0);
  });

  it("strips reserved/host env keys before reaching the sandbox", async () => {
    await agentCodeExecuteHandler(
      {
        language: "shell",
        code: "echo hi",
        env: {
          SAFE_VALUE: "keep",
          PATH: "/evil/bin",
          LD_PRELOAD: "/evil.so",
          MODAL_TOKEN: "stolen",
          "bad-key": "dropped",
        },
        timeoutMs: 5_000,
        memoryMb: 64,
        network: "deny",
      },
      CTX,
    );

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ env: { SAFE_VALUE: "keep" } }),
    );
  });

  it("lands a multi-file workspace into the sandbox before running", async () => {
    await agentCodeExecuteHandler(
      {
        language: "node",
        code: "require('./util')",
        files: { "util.js": "module.exports = 1", "lib/a.js": "1" },
        timeoutMs: 5_000,
        memoryMb: 128,
        network: "deny",
      },
      CTX,
    );

    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        files: { "util.js": "module.exports = 1", "lib/a.js": "1" },
      }),
    );
  });

  it("rejects a path-traversal file at the sandbox boundary (defense in depth)", async () => {
    await expect(
      agentCodeExecuteHandler(
        {
          language: "node",
          code: "x",
          files: { "../escape.js": "evil" },
          timeoutMs: 5_000,
          memoryMb: 64,
          network: "deny",
        },
        CTX,
      ),
    ).rejects.toThrow(/unsafe workspace path/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("surfaces stripped reserved env keys as a run warning", async () => {
    const result = await agentCodeExecuteHandler(
      {
        language: "shell",
        code: "echo hi",
        env: { SAFE: "keep", DATABASE_URL: "leak", PATH: "/evil" },
        timeoutMs: 5_000,
        memoryMb: 64,
        network: "deny",
      },
      CTX,
    );
    expect(result.warnings).toEqual([
      "reserved env key stripped: DATABASE_URL, PATH",
    ]);
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ env: { SAFE: "keep" } }),
    );
  });

  it("omits warnings when the caller env is clean", async () => {
    const result = await agentCodeExecuteHandler(
      {
        language: "shell",
        code: "echo hi",
        env: { SAFE: "keep" },
        timeoutMs: 5_000,
        memoryMb: 64,
        network: "deny",
      },
      CTX,
    );
    expect(result.warnings).toBeUndefined();
  });

  it("injects environment vault secrets below the caller env (caller wins)", async () => {
    mockResolveEnvSecrets.mockResolvedValue({ API_BASE: "vault", TOKEN: "t" });
    await agentCodeExecuteHandler(
      {
        language: "shell",
        code: "echo hi",
        environmentId: "env_1",
        env: { API_BASE: "caller" },
        timeoutMs: 5_000,
        memoryMb: 64,
        network: "deny",
      },
      CTX,
    );
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ env: { API_BASE: "caller", TOKEN: "t" } }),
    );
    expect(mockResolveEnvSecrets).toHaveBeenCalledWith({
      orgId: "org_1",
      workspaceId: "ws_1",
      environmentId: "env_1",
    });
  });
});

describe("agent.code.execute handler — sandbox template", () => {
  beforeEach(() => {
    mockRun.mockClear().mockResolvedValue(mockSandboxResult);
    mockInsertEvents.mockClear().mockResolvedValue(undefined);
    vi.mocked(isSandboxAvailable).mockReturnValue(true);
    vi.mocked(getSandbox).mockReset().mockReturnValue(mockDriver);
    mockResolveEnvSecrets.mockReset().mockResolvedValue({});
    mockResolveTemplate.mockReset();
    mockListSecretKeys.mockReset().mockResolvedValue([]);
  });

  it("applies the template provider, runtime image, resources, and network mode to the run", async () => {
    const template = makeTemplate({
      provider: "docker",
      runtime: "ghcr.io/acme/swe-bench@sha256:abc",
      resources: {
        vcpu: 2,
        memoryMb: 4096,
        timeoutMs: 120_000,
        diskMb: 10_240,
      },
      network: { mode: "public" },
    });
    mockResolveTemplate.mockResolvedValue(makeResolved(template));

    await agentCodeExecuteHandler(
      {
        language: "node",
        code: "console.log(1)",
        sandboxTemplateId: "sbx_1",
        timeoutMs: 30_000,
        memoryMb: 256,
        network: "deny",
      },
      CTX,
    );

    // The template's provider selects the driver per run, AND its trusted,
    // contract-bounded resources are threaded in as the effective policy ceiling
    // so the 4 GB / 120 s / network-allow run is NOT clamped to DEFAULT_POLICY.
    expect(vi.mocked(getSandbox)).toHaveBeenCalledWith(
      "docker",
      expect.objectContaining({
        maxMemoryMb: 4096,
        maxTimeoutMs: 120_000,
        allowNetwork: true,
      }),
    );
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        imageRef: "ghcr.io/acme/swe-bench@sha256:abc",
        memoryMb: 4096,
        timeoutMs: 120_000,
        network: "allow", // public → allow (overrides the caller's deny)
        vcpu: 2,
        diskMb: 10_240,
      }),
    );
  });

  it("resolves secrets from the template's environment with its selection + literal env", async () => {
    const template = makeTemplate({
      secretSelection: { keyPublicIds: ["sk_1"] },
      literalEnv: { SWEBENCH_SPLIT: "verified" },
      environmentId: "env_tpl",
    });
    mockResolveTemplate.mockResolvedValue(makeResolved(template));
    mockResolveEnvSecrets.mockResolvedValue({ EVAL_API_KEY: "v" });
    mockListSecretKeys.mockResolvedValue([
      { id: "sk_1", key: "EVAL_API_KEY", sensitive: true, memo: null },
    ]);

    await agentCodeExecuteHandler(
      {
        language: "node",
        code: "x",
        sandboxTemplateId: "sbx_1",
        env: { CALLER: "c" },
        timeoutMs: 30_000,
        memoryMb: 256,
        network: "deny",
      },
      CTX,
    );

    expect(mockResolveEnvSecrets).toHaveBeenCalledWith({
      orgId: "org_1",
      workspaceId: "ws_1",
      environmentId: "env_tpl",
      selection: { keyPublicIds: ["sk_1"] },
    });
    // literal (lowest) + vault + caller (highest).
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { SWEBENCH_SPLIT: "verified", EVAL_API_KEY: "v", CALLER: "c" },
      }),
    );
  });

  it("fails fast BEFORE provisioning on a not-yet-implemented network mode", async () => {
    const template = makeTemplate({ network: { mode: "aws_privatelink" } });
    mockResolveTemplate.mockResolvedValue(makeResolved(template));

    await expect(
      agentCodeExecuteHandler(
        {
          language: "node",
          code: "x",
          sandboxTemplateId: "sbx_1",
          timeoutMs: 30_000,
          memoryMb: 256,
          network: "deny",
        },
        CTX,
      ),
    ).rejects.toThrow(/Phase 2\/3/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("surfaces a required-but-unset template secret as a run warning (not a fail)", async () => {
    const template = makeTemplate({
      secretSelection: { keyPublicIds: ["sk_missing"] },
    });
    mockResolveTemplate.mockResolvedValue(makeResolved(template));
    mockResolveEnvSecrets.mockResolvedValue({}); // EVAL_API_KEY unset
    mockListSecretKeys.mockResolvedValue([
      { id: "sk_missing", key: "EVAL_API_KEY", sensitive: true, memo: null },
    ]);

    const result = await agentCodeExecuteHandler(
      {
        language: "node",
        code: "x",
        sandboxTemplateId: "sbx_1",
        timeoutMs: 30_000,
        memoryMb: 256,
        network: "deny",
      },
      CTX,
    );

    expect(result.warnings).toContain(
      "required template secret(s) unset in the vault: EVAL_API_KEY",
    );
    expect(mockRun).toHaveBeenCalled(); // still ran
  });
});
