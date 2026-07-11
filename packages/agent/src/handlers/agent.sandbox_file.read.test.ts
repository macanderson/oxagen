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
  agentSandboxFileReadHandler,
  decodeReadOutput,
} from "./agent.sandbox_file.read";

const ROW = {
  id: "uuid-1",
  publicId: "sbx_1",
  sandboxId: "sb-aaa",
  snapshotId: null as string | null,
  image: "agent",
  status: "running",
  metadata: {
    memoryMb: 2048,
    ttlSeconds: 86_400,
    idleTimeoutSeconds: 1_200,
    network: "allow",
  },
};

const okExec = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout,
  stderr: "",
  durationMs: 5,
  timedOut: false,
  gone: false,
});

/** stdout as the read command produces it: `size\n` + base64 of the bytes. */
const readStdout = (bytes: Buffer, sizeBytes = bytes.length) =>
  `${sizeBytes}\n${bytes.toString("base64")}\n`;

const MAX = 256 * 1024;

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

describe("decodeReadOutput", () => {
  it("returns valid UTF-8 text as encoding utf8", () => {
    const out = decodeReadOutput(
      "src/index.ts",
      MAX,
      readStdout(Buffer.from("export const x = 1;\n", "utf8")),
    );
    expect(out).toEqual({
      path: "src/index.ts",
      content: "export const x = 1;\n",
      encoding: "utf8",
      sizeBytes: 20,
      truncated: false,
    });
  });

  it("returns bytes containing NUL as base64 with the binary flag", () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]);
    const out = decodeReadOutput("logo.png", MAX, readStdout(bin));
    expect(out.encoding).toBe("base64");
    expect(Buffer.from(out.content, "base64")).toEqual(bin);
  });

  it("returns invalid UTF-8 (no NUL) as base64", () => {
    // 0xff is never valid in UTF-8.
    const bad = Buffer.from([0x68, 0x69, 0xff, 0xfe]);
    const out = decodeReadOutput("weird.txt", MAX, readStdout(bad));
    expect(out.encoding).toBe("base64");
    expect(Buffer.from(out.content, "base64")).toEqual(bad);
  });

  it("marks truncated when the on-disk size exceeds maxBytes", () => {
    const chunk = Buffer.from("a".repeat(8), "utf8");
    const out = decodeReadOutput("big.txt", 8, readStdout(chunk, 1_000));
    expect(out.truncated).toBe(true);
    expect(out.sizeBytes).toBe(1_000);
    expect(out.content).toBe("a".repeat(8));
  });

  it("handles base64 line wrapping (whitespace inside the payload)", () => {
    const text = "hello world";
    const b64 = Buffer.from(text).toString("base64");
    const wrapped = `${b64.slice(0, 6)}\n${b64.slice(6)}\n`;
    const out = decodeReadOutput("a.txt", MAX, `11\n${wrapped}`);
    expect(out.content).toBe(text);
    expect(out.encoding).toBe("utf8");
  });

  it("throws on a malformed size line", () => {
    expect(() => decodeReadOutput("a.txt", MAX, "garbage\nZm9v")).toThrow(
      /malformed size line/,
    );
  });
});

describe("agent.sandbox_file.read handler", () => {
  it("reads a utf8 file by running one head|base64 command in the session", async () => {
    fake.enqueue([{ ...ROW }]); // getSessionByPublicId
    fake.enqueue([]); // touchSession update
    h.driver.execInSession.mockResolvedValue(
      okExec(readStdout(Buffer.from("console.log(1);\n"))),
    );

    const out = await agentSandboxFileReadHandler(
      { sessionId: "sbx_1", path: "src/index.ts", maxBytes: MAX },
      CTX,
    );

    expect(out).toEqual({
      path: "src/index.ts",
      content: "console.log(1);\n",
      encoding: "utf8",
      sizeBytes: 16,
      truncated: false,
    });
    const call = h.driver.execInSession.mock.calls[0]![0] as {
      command: string;
    };
    // Quoted absolute target under the workspace root, bounded by maxBytes.
    expect(call.command).toContain("'/work/src/index.ts'");
    expect(call.command).toContain(`head -c ${MAX}`);
    expect(call.command).toContain("base64");
  });

  it("returns a binary file as base64", async () => {
    fake.enqueue([{ ...ROW }]);
    fake.enqueue([]);
    const bin = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    h.driver.execInSession.mockResolvedValue(okExec(readStdout(bin)));

    const out = await agentSandboxFileReadHandler(
      { sessionId: "sbx_1", path: "bin/blob", maxBytes: MAX },
      CTX,
    );

    expect(out.encoding).toBe("base64");
    expect(Buffer.from(out.content, "base64")).toEqual(bin);
    expect(out.truncated).toBe(false);
  });

  it("truncates a file larger than maxBytes and flags it", async () => {
    fake.enqueue([{ ...ROW }]);
    fake.enqueue([]);
    // File is 100 bytes on disk; only 10 came back.
    h.driver.execInSession.mockResolvedValue(
      okExec(readStdout(Buffer.from("0123456789"), 100)),
    );

    const out = await agentSandboxFileReadHandler(
      { sessionId: "sbx_1", path: "big.log", maxBytes: 10 },
      CTX,
    );

    expect(out.truncated).toBe(true);
    expect(out.sizeBytes).toBe(100);
    expect(out.content).toBe("0123456789");
  });

  it("rejects an unsafe path before any shell command runs", async () => {
    fake.enqueue([{ ...ROW }]);
    await expect(
      agentSandboxFileReadHandler(
        { sessionId: "sbx_1", path: "../etc/passwd", maxBytes: MAX },
        CTX,
      ),
    ).rejects.toThrow(/unsafe path/);
    expect(h.driver.execInSession).not.toHaveBeenCalled();
  });

  it("throws when no durable driver is available (fails closed)", async () => {
    fake.enqueue([{ ...ROW }]); // getSessionByPublicId — driver is resolved per-row
    h.isDurableSandboxDriver.mockReturnValue(false);
    await expect(
      agentSandboxFileReadHandler(
        { sessionId: "sbx_1", path: "a.txt", maxBytes: MAX },
        CTX,
      ),
    ).rejects.toThrow(/Durable sandbox sessions are not available/);
  });

  it("throws for an unknown session", async () => {
    fake.enqueue([]); // getSessionByPublicId → empty
    await expect(
      agentSandboxFileReadHandler(
        { sessionId: "sbx_missing", path: "a.txt", maxBytes: MAX },
        CTX,
      ),
    ).rejects.toThrow(/was not found in this workspace/);
  });

  it("throws a clear error when the file does not exist (sentinel exit 44)", async () => {
    fake.enqueue([{ ...ROW }]);
    fake.enqueue([]); // touchSession update
    h.driver.execInSession.mockResolvedValue(okExec("", 44));

    await expect(
      agentSandboxFileReadHandler(
        { sessionId: "sbx_1", path: "missing.txt", maxBytes: MAX },
        CTX,
      ),
    ).rejects.toThrow(/no such file in the workspace: missing.txt/);
  });

  it("throws a clear error when the path is a directory (sentinel exit 45)", async () => {
    fake.enqueue([{ ...ROW }]);
    fake.enqueue([]);
    h.driver.execInSession.mockResolvedValue(okExec("", 45));

    await expect(
      agentSandboxFileReadHandler(
        { sessionId: "sbx_1", path: "src", maxBytes: MAX },
        CTX,
      ),
    ).rejects.toThrow(/not a regular file/);
  });

  it("surfaces stderr for an unexpected nonzero exit", async () => {
    fake.enqueue([{ ...ROW }]);
    fake.enqueue([]);
    h.driver.execInSession.mockResolvedValue({
      ...okExec("", 1),
      stderr: "head: cannot open",
    });

    await expect(
      agentSandboxFileReadHandler(
        { sessionId: "sbx_1", path: "a.txt", maxBytes: MAX },
        CTX,
      ),
    ).rejects.toThrow(/read failed \(exit 1\): head: cannot open/);
  });

  it("restores from snapshot and retries when the sandbox was reaped", async () => {
    fake.enqueue([{ ...ROW, snapshotId: "img-7" }]); // getSessionByPublicId
    fake.enqueue([]); // rebindSession update
    fake.enqueue([]); // touchSession update
    h.driver.execInSession
      .mockResolvedValueOnce({ ...okExec(""), gone: true })
      .mockResolvedValueOnce(okExec(readStdout(Buffer.from("hi"))));
    h.driver.restoreSession.mockResolvedValue({
      sandboxId: "sb-restored",
      status: "running",
      createdAt: "2026-06-28T03:00:00.000Z",
    });

    const out = await agentSandboxFileReadHandler(
      { sessionId: "sbx_1", path: "a.txt", maxBytes: MAX },
      CTX,
    );

    expect(out.content).toBe("hi");
    expect(h.driver.restoreSession).toHaveBeenCalledWith(
      "img-7",
      expect.any(Object),
    );
    expect(h.driver.execInSession).toHaveBeenCalledTimes(2);
  });

  it("throws SandboxSessionGoneError when reaped with no snapshot", async () => {
    fake.enqueue([{ ...ROW, snapshotId: null }]); // getSessionByPublicId
    fake.enqueue([]); // markSessionStatus update
    h.driver.execInSession.mockResolvedValue({ ...okExec(""), gone: true });

    await expect(
      agentSandboxFileReadHandler(
        { sessionId: "sbx_1", path: "a.txt", maxBytes: MAX },
        CTX,
      ),
    ).rejects.toThrow(/was reaped and has no snapshot/);
  });

  it("shell-quotes a path containing a single quote", async () => {
    fake.enqueue([{ ...ROW }]);
    fake.enqueue([]);
    h.driver.execInSession.mockResolvedValue(
      okExec(readStdout(Buffer.from("x"))),
    );

    await agentSandboxFileReadHandler(
      { sessionId: "sbx_1", path: "it's.txt", maxBytes: MAX },
      CTX,
    );

    const call = h.driver.execInSession.mock.calls[0]![0] as {
      command: string;
    };
    expect(call.command).toContain(`'/work/it'\\''s.txt'`);
  });
});
