/**
 * Unit tests for the policy-enforcement seam in getSandbox().
 *
 * `getSandbox()` is the single chokepoint every one-shot run/stream caller
 * funnels through, so it wraps the resolved driver and runs `applyPolicy`
 * against every SandboxRequest before any driver sees it. These tests inject a
 * recording stub via `setSandboxForTests` and assert the four security-critical
 * behaviours plus the template interplay:
 *
 *   1. A valid request passes through untouched (no-op).
 *   2. An over-ceiling request is clamped to the policy (never raised).
 *   3. A disallowed language / network is rejected with SandboxPolicyError.
 *   4. A template-derived policy lets resources above DEFAULT_POLICY through
 *      unclamped (the trusted, contract-bounded override path).
 *
 * The wrapper must also stay transparent — driver `.name` and the durable
 * session surface forward verbatim so isDurableSandboxDriver() still works.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { getSandbox, setSandboxForTests } from "./index";
import {
  DEFAULT_POLICY,
  SandboxPolicyError,
  type SandboxPolicy,
} from "./policy";
import type { SandboxDriver, SandboxRequest, SandboxResult } from "./types";

const RESULT: SandboxResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  oomKilled: false,
};

function recordingDriver(): {
  driver: SandboxDriver;
  runReqs: SandboxRequest[];
} {
  const runReqs: SandboxRequest[] = [];
  const driver: SandboxDriver = {
    name: "recording",
    run: vi.fn(async (req: SandboxRequest): Promise<SandboxResult> => {
      runReqs.push(req);
      return RESULT;
    }),
    async *stream(req: SandboxRequest) {
      runReqs.push(req);
    },
  };
  return { driver, runReqs };
}

function makeReq(overrides: Partial<SandboxRequest> = {}): SandboxRequest {
  return {
    language: "node",
    code: "x",
    timeoutMs: 5_000,
    memoryMb: 128,
    network: "deny",
    orgId: "org_test",
    workspaceId: "ws_test",
    ...overrides,
  };
}

afterEach(() => setSandboxForTests(null));

describe("getSandbox() policy seam", () => {
  it("passes an already-valid request through untouched (no-op)", async () => {
    const { driver, runReqs } = recordingDriver();
    setSandboxForTests(driver);

    await getSandbox().run(
      makeReq({
        timeoutMs: 10_000,
        memoryMb: 256,
        network: "deny",
        language: "python",
      }),
    );

    expect(runReqs[0]).toMatchObject({
      timeoutMs: 10_000,
      memoryMb: 256,
      network: "deny",
      language: "python",
    });
  });

  it("clamps an over-ceiling request down to DEFAULT_POLICY, never raising it", async () => {
    const { driver, runReqs } = recordingDriver();
    setSandboxForTests(driver);

    await getSandbox().run(makeReq({ timeoutMs: 999_999, memoryMb: 99_999 }));

    expect(runReqs[0]!.timeoutMs).toBe(DEFAULT_POLICY.maxTimeoutMs);
    expect(runReqs[0]!.memoryMb).toBe(DEFAULT_POLICY.maxMemoryMb);
  });

  it("rejects a request that asks for network when the policy forbids it", async () => {
    const { driver, runReqs } = recordingDriver();
    setSandboxForTests(driver);

    await expect(
      getSandbox().run(makeReq({ network: "allow" })),
    ).rejects.toBeInstanceOf(SandboxPolicyError);
    // The driver is never reached when the policy rejects.
    expect(runReqs).toHaveLength(0);
  });

  it("rejects a language absent from the effective policy's allowlist", async () => {
    const { driver } = recordingDriver();
    setSandboxForTests(driver);

    const policy: SandboxPolicy = {
      ...DEFAULT_POLICY,
      allowedLanguages: ["node", "python"],
    };

    await expect(
      getSandbox(undefined, policy).run(makeReq({ language: "shell" })),
    ).rejects.toBeInstanceOf(SandboxPolicyError);
  });

  it("threads a template-derived policy so resources above DEFAULT are NOT clamped", async () => {
    const { driver, runReqs } = recordingDriver();
    setSandboxForTests(driver);

    // A trusted template ceiling that exceeds DEFAULT_POLICY (30 s / 512 MB).
    const templatePolicy: SandboxPolicy = {
      allowedLanguages: DEFAULT_POLICY.allowedLanguages,
      maxTimeoutMs: 120_000,
      maxMemoryMb: 4_096,
      allowNetwork: true,
    };

    await getSandbox("docker", templatePolicy).run(
      makeReq({ timeoutMs: 120_000, memoryMb: 4_096, network: "allow" }),
    );

    expect(runReqs[0]).toMatchObject({
      timeoutMs: 120_000,
      memoryMb: 4_096,
      network: "allow",
    });
  });

  it("enforces the policy on stream() as well as run()", () => {
    const { driver } = recordingDriver();
    setSandboxForTests(driver);

    // applyPolicy throws synchronously when the stream is opened.
    expect(() => getSandbox().stream(makeReq({ network: "allow" }))).toThrow(
      SandboxPolicyError,
    );
  });

  it("keeps the driver surface transparent through the wrapper", () => {
    const { driver } = recordingDriver();
    setSandboxForTests(driver);

    const wrapped = getSandbox();
    expect(wrapped.name).toBe("recording");
    expect(typeof wrapped.run).toBe("function");
    expect(typeof wrapped.stream).toBe("function");
  });
});
