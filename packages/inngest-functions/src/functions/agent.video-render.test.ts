import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  dbUpdateSet: vi.fn(),
  dbUpdateWhere: vi.fn(),
  dbUpdate: vi.fn(),
  generateVideoFor: vi.fn(),
  selectVideoModel: vi.fn(),
  storagePut: vi.fn(),
  inngestCreateFunction: vi.fn(),
}));

// DB UPDATE chain: .update().set().where()
mocks.dbUpdateWhere.mockResolvedValue(undefined);
mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });

const fakeDb = { update: mocks.dbUpdate };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeDb,
    // withTenantDb / withSystemDb pass-through: invokes the callback with the
    // same fake tx so handler assertions keep working without a real tx or GUC.
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
  };
});

vi.mock("@oxagen/tenancy", () => ({
  // runInTenantScope pass-through: executes fn() directly in unit tests so
  // the tenant scope is satisfied without a real ALS entry.
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

// Mock @oxagen/ai
const FAKE_BYTES = new Uint8Array([0x00, 0x01, 0x02]);
const FAKE_MODEL_OBJ = { modelId: "google/veo-3.0-fast-generate-001" };

mocks.selectVideoModel.mockReturnValue(FAKE_MODEL_OBJ);
mocks.generateVideoFor.mockResolvedValue({
  bytes: FAKE_BYTES,
  mimeType: "video/mp4",
  durationMs: 4200,
});

vi.mock("@oxagen/ai", () => ({
  generateVideoFor: mocks.generateVideoFor,
  selectVideoModel: mocks.selectVideoModel,
}));

// Mock @oxagen/storage
mocks.storagePut.mockResolvedValue({
  url: "https://blob.vercel.sh/generated/videos/org_1/asset_1.mp4",
  key: "generated/videos/org_1/asset_1.mp4",
  bytes: 1024,
});

// NOTE: generate-and-upload is ONE combined step. The step.run wrapper in the
// test calls fn() synchronously, so generateVideoFor + storagePut are both
// invoked inside that single step's closure.

vi.mock("@oxagen/storage", () => ({
  storage: () => ({ put: mocks.storagePut }),
}));

// Mock inngest client — capture handler
let capturedHandler:
  | ((ctx: {
      event: { data: Record<string, unknown> };
      step: {
        run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
      };
    }) => Promise<unknown>)
  | null = null;

let capturedOnFailureHandler:
  | ((ctx: {
      event: { data: Record<string, unknown> };
      step: {
        run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
      };
    }) => Promise<unknown>)
  | null = null;

mocks.inngestCreateFunction.mockImplementation(
  (
    opts: { id: string },
    _trigger: unknown,
    handler: typeof capturedHandler,
  ) => {
    if (opts.id === "agent.video-render") capturedHandler = handler;
    if (opts.id === "agent.video-render.on-failure")
      capturedOnFailureHandler = handler;
    return {};
  },
);

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ INNGEST_EVENT_KEY: "evt-test" }),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

// Import triggers createFunction() which populates capturedHandler
await import("./agent.video-render");

// ─────────────────────────────────────────────────────────────────────────────

function makeStep() {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

const BASE_EVENT = {
  data: {
    assetId: "asset_1",
    orgId: "org_1",
    workspaceId: "ws_1",
    userId: "user_1",
    prompt: "A sunset timelapse",
    model: "google/veo-3.0-fast-generate-001",
    mediaTier: "basic",
    durationSeconds: 5,
    aspectRatio: "16:9",
  },
};

describe("agentVideoRender Inngest handler", () => {
  beforeEach(() => {
    mocks.dbUpdate.mockClear();
    mocks.dbUpdateSet.mockClear();
    mocks.dbUpdateWhere.mockClear();
    mocks.generateVideoFor.mockClear();
    mocks.selectVideoModel.mockClear();
    mocks.storagePut.mockClear();
    // restore defaults
    mocks.dbUpdateWhere.mockResolvedValue(undefined);
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
    mocks.selectVideoModel.mockReturnValue(FAKE_MODEL_OBJ);
    mocks.generateVideoFor.mockResolvedValue({
      bytes: FAKE_BYTES,
      mimeType: "video/mp4",
      durationMs: 4200,
    });
    mocks.storagePut.mockResolvedValue({
      url: "https://blob.vercel.sh/generated/videos/org_1/asset_1.mp4",
      key: "generated/videos/org_1/asset_1.mp4",
      bytes: 1024,
    });
  });

  it("calls selectVideoModel with the model from the event", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    expect(mocks.selectVideoModel).toHaveBeenCalledTimes(1);
    const arg = mocks.selectVideoModel.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.model).toBe("google/veo-3.0-fast-generate-001");
  });

  it("calls generateVideoFor with the correct prompt and telemetry", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    expect(mocks.generateVideoFor).toHaveBeenCalledTimes(1);
    const arg = mocks.generateVideoFor.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.prompt).toBe("A sunset timelapse");
    expect(arg.durationSeconds).toBe(5);
    expect(arg.aspectRatio).toBe("16:9");
    const tel = arg.telemetry as Record<string, unknown>;
    expect(tel.orgId).toBe("org_1");
    expect(tel.workspaceId).toBe("ws_1");
    expect(tel.surface).toBe("app");
    expect(tel.executionStepId).toBe("asset_1");
  });

  it("uploads bytes to storage with the correct key and content type", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    expect(mocks.storagePut).toHaveBeenCalledTimes(1);
    const putArg = mocks.storagePut.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(putArg.key).toBe("generated/videos/org_1/asset_1.mp4");
    expect(putArg.body).toBe(FAKE_BYTES);
    expect(putArg.contentType).toBe("video/mp4");
    // Must be private — CDN URL must never be guessable; served via auth-gated proxy.
    expect(putArg.access).toBe("private");
  });

  it("updates the generated_assets row to ready with storage refs", async () => {
    await capturedHandler!({ event: BASE_EVENT, step: makeStep() });

    // db().update called once for mark-ready
    expect(mocks.dbUpdate.mock.calls.length).toBeGreaterThanOrEqual(1);
    const setCalls = mocks.dbUpdateSet.mock.calls as Array<
      [Record<string, unknown>]
    >;
    const readyCall = setCalls.find(([arg]) => arg.status === "ready");
    expect(readyCall).toBeTruthy();
    const setArg = readyCall![0] as Record<string, unknown>;
    expect(setArg.storageKey).toBe("generated/videos/org_1/asset_1.mp4");
    expect(setArg.storageUrl).toBe(
      "https://blob.vercel.sh/generated/videos/org_1/asset_1.mp4",
    );
    expect(setArg.sizeBytes).toBe(BigInt(1024));
  });

  it("returns the asset id, status, and storage refs on success", async () => {
    const result = await capturedHandler!({
      event: BASE_EVENT,
      step: makeStep(),
    });
    const r = result as Record<string, unknown>;
    expect(r.assetId).toBe("asset_1");
    expect(r.status).toBe("ready");
    expect(r.storageKey).toBe("generated/videos/org_1/asset_1.mp4");
  });

  it("rethrows when generateVideoFor fails (Inngest records failure)", async () => {
    mocks.generateVideoFor.mockRejectedValueOnce(
      new Error("veo provider error"),
    );

    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow("veo provider error");
  });

  it("rethrows when storage put fails", async () => {
    mocks.storagePut.mockRejectedValueOnce(new Error("blob upload failed"));

    await expect(
      capturedHandler!({ event: BASE_EVENT, step: makeStep() }),
    ).rejects.toThrow("blob upload failed");
  });
});

describe("agentVideoRenderOnFailure handler", () => {
  beforeEach(() => {
    mocks.dbUpdate.mockClear();
    mocks.dbUpdateSet.mockClear();
    mocks.dbUpdateWhere.mockClear();
    mocks.dbUpdateWhere.mockResolvedValue(undefined);
    mocks.dbUpdateSet.mockReturnValue({ where: mocks.dbUpdateWhere });
    mocks.dbUpdate.mockReturnValue({ set: mocks.dbUpdateSet });
  });

  it("marks the asset failed with the error message in metadata", async () => {
    const failureEvent = {
      data: {
        function_id: "agent.video-render",
        error: { message: "veo timed out" },
        event: { data: { assetId: "asset_2", orgId: "org_1" } },
      },
    };

    await capturedOnFailureHandler!({ event: failureEvent, step: makeStep() });

    const setCalls = mocks.dbUpdateSet.mock.calls as Array<
      [Record<string, unknown>]
    >;
    const failedCall = setCalls.find(([arg]) => arg.status === "failed");
    expect(failedCall).toBeTruthy();
    const setArg = failedCall![0] as Record<string, unknown>;
    expect((setArg.metadata as Record<string, unknown>).failureReason).toBe(
      "veo timed out",
    );
  });

  it("is a no-op when assetId is missing from the original event", async () => {
    const failureEventNoAsset = {
      data: {
        function_id: "agent.video-render",
        error: { message: "something went wrong" },
        event: { data: {} },
      },
    };

    // Should not throw
    await capturedOnFailureHandler!({
      event: failureEventNoAsset,
      step: makeStep(),
    });

    // DB should not have been called
    expect(mocks.dbUpdate.mock.calls.length).toBe(0);
  });
});
