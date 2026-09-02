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
    put: vi.fn(async () => ({
      key: "image/ws_1/fixed.png",
      url: "blob://fixed",
      bytes: 123,
      access: "private" as const,
    })),
  };
});

vi.mock("@oxagen/sandbox", () => ({
  getSandbox: () => h.driver,
  isSandboxAvailable: h.isSandboxAvailable,
  isDurableSandboxDriver: h.isDurableSandboxDriver,
}));

vi.mock("@oxagen/storage", () => ({
  storage: () => ({ put: h.put }),
  deriveAssetKey: (kind: string, owner: string, ext: string) =>
    `${kind}/${owner}/fixed.${ext}`,
}));

const fake = createFakeTx();
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

import {
  browserNavigateHandler,
  browserScreenshotHandler,
  browserFillHandler,
  browserSubmitHandler,
  browserClickHandler,
  browserRefreshHandler,
  browserReadHandler,
} from "./browser";

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

function execReturns(stdout: string, over: Record<string, unknown> = {}) {
  h.driver.execInSession.mockResolvedValueOnce({
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 5,
    timedOut: false,
    gone: false,
    ...over,
  });
}

beforeEach(() => {
  fake.reset();
  h.isSandboxAvailable.mockReturnValue(true);
  h.isDurableSandboxDriver.mockReturnValue(true);
  h.driver.execInSession.mockReset();
  h.put.mockClear();
});

describe("browser.* handlers — happy paths", () => {
  it("navigate returns url + title and drives browserctl over stdin", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true,"url":"http://localhost:3000/x","title":"X Page"}');

    const out = await browserNavigateHandler(
      { sessionId: "sbx_1", url: "http://localhost:3000/x", timeoutMs: 60_000 },
      CTX,
    );

    expect(out).toEqual({ url: "http://localhost:3000/x", title: "X Page" });
    expect(h.driver.execInSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sb-aaa",
        command: "browserctl",
        stdin: JSON.stringify({
          op: "navigate",
          url: "http://localhost:3000/x",
        }),
      }),
    );
  });

  it("screenshot stores a private PNG asset and returns its key/dims", async () => {
    fake.enqueue([{ ...ROW }]);
    const png = Buffer.from("fakepng").toString("base64");
    execReturns(`{"ok":true,"base64":"${png}","width":1280,"height":800}`);

    const out = await browserScreenshotHandler(
      { sessionId: "sbx_1", fullPage: true, timeoutMs: 60_000 },
      CTX,
    );

    expect(out).toEqual({
      key: "image/ws_1/fixed.png",
      url: "blob://fixed",
      width: 1280,
      height: 800,
      bytes: 123,
    });
    expect(h.put).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: "image/png", access: "private" }),
    );
  });

  it("fill returns ok and passes selector+value", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true}');

    const out = await browserFillHandler(
      {
        sessionId: "sbx_1",
        selector: "#email",
        value: "me@x.com",
        timeoutMs: 30_000,
      },
      CTX,
    );

    expect(out).toEqual({ ok: true });
    expect(h.driver.execInSession).toHaveBeenCalledWith(
      expect.objectContaining({
        stdin: JSON.stringify({
          op: "fill",
          selector: "#email",
          value: "me@x.com",
        }),
      }),
    );
  });

  it("submit returns ok + resulting url", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true,"url":"http://localhost:3000/dash"}');
    const out = await browserSubmitHandler(
      { sessionId: "sbx_1", timeoutMs: 60_000 },
      CTX,
    );
    expect(out).toEqual({ ok: true, url: "http://localhost:3000/dash" });
  });

  it("click returns ok + url", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true,"url":"http://localhost:3000/y"}');
    const out = await browserClickHandler(
      { sessionId: "sbx_1", selector: "button.next", timeoutMs: 60_000 },
      CTX,
    );
    expect(out).toEqual({ ok: true, url: "http://localhost:3000/y" });
  });

  it("refresh returns ok + url", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true,"url":"http://localhost:3000/x"}');
    const out = await browserRefreshHandler(
      { sessionId: "sbx_1", timeoutMs: 60_000 },
      CTX,
    );
    expect(out).toEqual({ ok: true, url: "http://localhost:3000/x" });
  });

  it("read returns visible text", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true,"text":"Welcome back"}');
    const out = await browserReadHandler(
      { sessionId: "sbx_1", selector: "h1", timeoutMs: 30_000 },
      CTX,
    );
    expect(out).toEqual({ text: "Welcome back" });
  });
});

describe("browser.* handlers — failure paths", () => {
  it("throws when the durable session is unknown", async () => {
    fake.enqueue([]); // getSessionByPublicId → empty
    await expect(
      browserNavigateHandler(
        { sessionId: "sbx_x", url: "http://x", timeoutMs: 60_000 },
        CTX,
      ),
    ).rejects.toThrow(/was not found/);
  });

  it("throws BrowserDriveError when the daemon reports an error", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":false,"error":"selector not found"}');
    await expect(
      browserClickHandler(
        { sessionId: "sbx_1", selector: "#missing", timeoutMs: 60_000 },
        CTX,
      ),
    ).rejects.toThrow(/selector not found/);
  });

  it("throws BrowserDriveError on non-JSON browserctl output", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns("Traceback: boom", { exitCode: 1 });
    await expect(
      browserReadHandler({ sessionId: "sbx_1", timeoutMs: 30_000 }, CTX),
    ).rejects.toThrow(/non-JSON/);
  });

  it("throws when the sandbox was reaped (gone)", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns("", { gone: true });
    await expect(
      browserNavigateHandler(
        { sessionId: "sbx_1", url: "http://x", timeoutMs: 60_000 },
        CTX,
      ),
    ).rejects.toThrow(/was reaped/);
  });

  it("throws when no durable driver is available", async () => {
    // Enqueue a row: driveBrowser now loads the session FIRST and resolves the
    // driver from that row's own `driver` column, so without a row this would
    // fail with SandboxSessionNotFoundError before reaching the driver check.
    fake.enqueue([{ ...ROW }]);
    h.isDurableSandboxDriver.mockReturnValue(false);
    await expect(
      browserReadHandler({ sessionId: "sbx_1", timeoutMs: 30_000 }, CTX),
    ).rejects.toThrow(/Durable sandbox sessions are not available/);
  });
});

// browserctl is allowed to answer `{"ok":true}` with no `url`/`text` (a submit
// that navigated nowhere, a read that matched an empty node). Each handler
// coerces the missing field to "" rather than emitting `undefined` into a
// typed output, so pin that fallback for every handler that has one.
describe("browser.* handlers — omitted-field fallbacks", () => {
  it("submit returns an empty url when the daemon omits one", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true}');
    await expect(
      browserSubmitHandler({ sessionId: "sbx_1", timeoutMs: 60_000 }, CTX),
    ).resolves.toEqual({ ok: true, url: "" });
  });

  it("click returns an empty url when the daemon omits one", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true}');
    await expect(
      browserClickHandler(
        { sessionId: "sbx_1", selector: "button.next", timeoutMs: 60_000 },
        CTX,
      ),
    ).resolves.toEqual({ ok: true, url: "" });
  });

  it("refresh returns an empty url when the daemon omits one", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true}');
    await expect(
      browserRefreshHandler({ sessionId: "sbx_1", timeoutMs: 60_000 }, CTX),
    ).resolves.toEqual({ ok: true, url: "" });
  });

  it("read returns empty text when the daemon omits it", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true}');
    await expect(
      browserReadHandler({ sessionId: "sbx_1", timeoutMs: 30_000 }, CTX),
    ).resolves.toEqual({ text: "" });
  });

  it("navigate echoes the requested url and blanks the title when omitted", async () => {
    fake.enqueue([{ ...ROW }]);
    execReturns('{"ok":true}');
    await expect(
      browserNavigateHandler(
        { sessionId: "sbx_1", url: "http://x", timeoutMs: 60_000 },
        CTX,
      ),
    ).resolves.toEqual({ url: "http://x", title: "" });
  });
});
