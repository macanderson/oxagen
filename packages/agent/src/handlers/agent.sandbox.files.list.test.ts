import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

// A fully-stubbed durable driver; isDurableSandboxDriver() is mocked to accept
// it so requireDurableDriver() narrows without the real capability check.
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

const fake = createFakeTx();
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

import {
  agentSandboxFilesListHandler,
  parseFindOutput,
} from "./agent.sandbox.files.list";

const ROW = {
  id: "uuid-1",
  publicId: "sbx_1",
  sandboxId: "sb-aaa",
  snapshotId: null as string | null,
  image: "agent",
  status: "running",
  metadata: { memoryMb: 2048, ttlSeconds: 86_400, idleTimeoutSeconds: 1_200, network: "allow" },
};

const okExec = (stdout: string) => ({
  exitCode: 0,
  stdout,
  stderr: "",
  durationMs: 5,
  timedOut: false,
  gone: false,
});

beforeEach(() => {
  fake.reset();
  h.isSandboxAvailable.mockReturnValue(true);
  h.isDurableSandboxDriver.mockReturnValue(true);
  for (const fn of [
    h.driver.execInSession,
    h.driver.restoreSession,
    h.driver.sessionStatus,
  ]) {
    fn.mockReset();
  }
});

describe("parseFindOutput", () => {
  it("parses type/size/path and strips the workspace root", () => {
    const out = parseFindOutput(
      "d\t4096\t/work/src\n" + "f\t1024\t/work/src/index.ts\n",
    );
    expect(out).toEqual([
      { path: "src", kind: "dir", sizeBytes: 4096 },
      { path: "src/index.ts", kind: "file", sizeBytes: 1024 },
    ]);
  });

  it("drops non-file/dir entries (symlinks) and blank lines", () => {
    const out = parseFindOutput("l\t12\t/work/link\n\nf\t3\t/work/a.txt\n");
    expect(out).toEqual([{ path: "a.txt", kind: "file", sizeBytes: 3 }]);
  });

  it("sorts entries by path deterministically", () => {
    const out = parseFindOutput(
      "f\t1\t/work/z.txt\n" + "f\t1\t/work/a.txt\n" + "d\t0\t/work/m\n",
    );
    expect(out.map((e) => e.path)).toEqual(["a.txt", "m", "z.txt"]);
  });

  it("coerces a non-numeric or negative size to 0", () => {
    const out = parseFindOutput("f\tNaN\t/work/x\n" + "f\t-5\t/work/y\n");
    expect(out).toEqual([
      { path: "x", kind: "file", sizeBytes: 0 },
      { path: "y", kind: "file", sizeBytes: 0 },
    ]);
  });
});

describe("agent.sandbox.files.list handler", () => {
  it("lists files by running one find command in the session", async () => {
    fake.enqueue([{ ...ROW }]); // getSessionByPublicId
    fake.enqueue([]); // touchSession update
    h.driver.execInSession.mockResolvedValue(
      okExec("d\t4096\t/work/src\nf\t1024\t/work/src/index.ts\n"),
    );

    const out = await agentSandboxFilesListHandler(
      { sessionId: "sbx_1", depth: 2 },
      CTX,
    );

    expect(out.entries).toEqual([
      { path: "src", kind: "dir", sizeBytes: 4096 },
      { path: "src/index.ts", kind: "file", sizeBytes: 1024 },
    ]);
    // Runs against the workspace root by default, bounded by depth.
    const call = h.driver.execInSession.mock.calls[0]![0] as { command: string };
    expect(call.command).toContain("'/work'");
    expect(call.command).toContain("-maxdepth 2");
  });

  it("scopes the find to a relative subdirectory when path is given", async () => {
    fake.enqueue([{ ...ROW }]);
    fake.enqueue([]);
    h.driver.execInSession.mockResolvedValue(okExec(""));

    await agentSandboxFilesListHandler(
      { sessionId: "sbx_1", path: "src/components", depth: 3 },
      CTX,
    );

    const call = h.driver.execInSession.mock.calls[0]![0] as { command: string };
    expect(call.command).toContain("'/work/src/components'");
    expect(call.command).toContain("-maxdepth 3");
  });

  it("throws for an unknown session", async () => {
    fake.enqueue([]); // getSessionByPublicId → empty
    await expect(
      agentSandboxFilesListHandler({ sessionId: "sbx_missing", depth: 2 }, CTX),
    ).rejects.toThrow(/was not found in this workspace/);
  });

  it("throws when no durable driver is available", async () => {
    h.isDurableSandboxDriver.mockReturnValue(false);
    await expect(
      agentSandboxFilesListHandler({ sessionId: "sbx_1", depth: 2 }, CTX),
    ).rejects.toThrow(/Durable sandbox sessions are not available/);
  });

  it("restores from snapshot and retries when the sandbox was reaped", async () => {
    fake.enqueue([{ ...ROW, snapshotId: "img-7" }]); // getSessionByPublicId
    fake.enqueue([]); // rebindSession update
    fake.enqueue([]); // touchSession update
    h.driver.execInSession
      .mockResolvedValueOnce({ ...okExec(""), gone: true })
      .mockResolvedValueOnce(okExec("f\t2\t/work/a.txt\n"));
    h.driver.restoreSession.mockResolvedValue({
      sandboxId: "sb-restored",
      status: "running",
      createdAt: "2026-06-28T03:00:00.000Z",
    });

    const out = await agentSandboxFilesListHandler(
      { sessionId: "sbx_1", depth: 2 },
      CTX,
    );

    expect(out.entries).toEqual([{ path: "a.txt", kind: "file", sizeBytes: 2 }]);
    expect(h.driver.restoreSession).toHaveBeenCalledWith("img-7", expect.any(Object));
    expect(h.driver.execInSession).toHaveBeenCalledTimes(2);
  });

  it("throws SandboxSessionGoneError when reaped with no snapshot", async () => {
    fake.enqueue([{ ...ROW, snapshotId: null }]); // getSessionByPublicId
    fake.enqueue([]); // markSessionStatus update
    h.driver.execInSession.mockResolvedValue({ ...okExec(""), gone: true });

    await expect(
      agentSandboxFilesListHandler({ sessionId: "sbx_1", depth: 2 }, CTX),
    ).rejects.toThrow(/was reaped and has no snapshot/);
  });
});
