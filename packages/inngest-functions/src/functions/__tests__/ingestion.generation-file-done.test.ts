import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  activateGenerationIfComplete: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

type HandlerCtx = {
  event: { data: unknown };
  step: { run: (name: string, fn: () => unknown) => Promise<unknown> };
};
let capturedHandler: ((ctx: HandlerCtx) => unknown) | null = null;
let capturedCreateFunctionArgs: unknown[] | null = null;

mocks.createFunction.mockImplementation(
  (opts: unknown, trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
    capturedCreateFunctionArgs = [opts, trigger, handler];
    return {};
  },
);

vi.mock("../../inngest", () => ({
  inngest: { createFunction: mocks.createFunction },
}));

const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({
  strings,
  values,
});
Object.assign(sqlTag, {
  mapWith: () => sqlTag,
  raw: () => sqlTag,
  param: (v: unknown) => v,
});

vi.mock("drizzle-orm", () => ({ sql: sqlTag }));
vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  withTenantDb: mocks.withTenantDb,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  ),
}));
vi.mock("@oxagen/ontology", () => ({
  projectSnapshotToGraph: vi.fn(),
  pruneLegacySourceDetail: vi.fn(),
  removeCanonicalFiles: vi.fn(),
}));
vi.mock("@oxagen/crypto", () => ({
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("../../lib/github-projection", async (importActual) => {
  const actual =
    await importActual<typeof import("../../lib/github-projection")>();
  return {
    ...actual,
    activateGenerationIfComplete: mocks.activateGenerationIfComplete,
  };
});

vi.mock("../../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    debug: vi.fn(),
    error: vi.fn(),
    warn: mocks.loggerWarn,
  },
}));

await import("../ingestion.generation-file-done");

// ── Fixtures ─────────────────────────────────────────────────────────────────
const BASE_EVENT = {
  orgId: "org-1",
  workspaceId: "ws-1",
  generationId: "gen-1",
  skipped: false,
};

/** Post-increment counters the fake UPDATE … RETURNING hands back. */
let returning: Array<Record<string, number>>;
let executed: Array<{ text: string; values: unknown[] }>;

function sqlTextOf(q: unknown): string {
  return Array.from((q as { strings?: readonly string[] }).strings ?? []).join(
    " ",
  );
}

function setupDefaultMocks(): void {
  executed = [];
  returning = [{ files_total: 3, files_processed: 1, files_skipped: 0 }];

  mocks.withTenantDb.mockImplementation(
    async (
      fn: (tx: { execute: (q: unknown) => Promise<unknown> }) => unknown,
    ) =>
      fn({
        execute: async (q: unknown) => {
          executed.push({
            text: sqlTextOf(q),
            values: (q as { values: unknown[] }).values,
          });
          return returning;
        },
      }),
  );
  mocks.runInTenantScope.mockImplementation((_s: unknown, fn: () => unknown) =>
    fn(),
  );
  mocks.activateGenerationIfComplete.mockResolvedValue({
    activated: true,
    generationId: "gen-1",
    commitSha: "sha-after",
  });
}

function makeStep(): HandlerCtx["step"] {
  return { run: vi.fn(async (_name: string, fn: () => unknown) => fn()) };
}

async function run(overrides: Partial<typeof BASE_EVENT> = {}) {
  return (await capturedHandler!({
    event: { data: { ...BASE_EVENT, ...overrides } },
    step: makeStep(),
  })) as Record<string, unknown>;
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe("ingestion.generation-file-done", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  it("registers on the generation-file-done trigger", () => {
    const [opts, trigger] = capturedCreateFunctionArgs as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(opts).toMatchObject({
      id: "ingestion-generation-file-done",
      retries: 3,
    });
    expect(trigger).toMatchObject({
      event: "ingestion/github.generation-file-done",
    });
  });

  it("increments files_processed for a projected file", async () => {
    await run({ skipped: false });
    expect(executed).toHaveLength(1);
    expect(executed[0]!.text).toContain(
      "files_processed = files_processed + 1",
    );
    expect(executed[0]!.text).not.toContain(
      "files_skipped = files_skipped + 1",
    );
    expect(executed[0]!.values).toContain("gen-1");
  });

  it("increments files_skipped for a skipped file", async () => {
    await run({ skipped: true });
    expect(executed).toHaveLength(1);
    expect(executed[0]!.text).toContain("files_skipped = files_skipped + 1");
    expect(executed[0]!.text).not.toContain(
      "files_processed = files_processed + 1",
    );
  });

  it("advances the counter with a SINGLE atomic UPDATE … RETURNING, never a read-modify-write", async () => {
    await run();
    // One statement total: no SELECT of the current value before the UPDATE.
    expect(executed).toHaveLength(1);
    const { text } = executed[0]!;
    expect(text).toMatch(/UPDATE ingestion\.projection_generations/i);
    expect(text).toContain("RETURNING");
    expect(text).not.toMatch(/SELECT/i);
    // The increment is relative to the locked row, not to a value read earlier.
    expect(text).toMatch(/files_processed\s*=\s*files_processed \+ 1/);
  });

  it("does NOT activate while the generation is still incomplete", async () => {
    returning = [{ files_total: 3, files_processed: 1, files_skipped: 1 }];
    const result = await run();

    expect(mocks.activateGenerationIfComplete).not.toHaveBeenCalled();
    expect(result).toEqual({
      generationId: "gen-1",
      skipped: false,
      activated: false,
    });
  });

  it("activates when processed + skipped reaches files_total", async () => {
    returning = [{ files_total: 3, files_processed: 2, files_skipped: 1 }];
    const result = await run();

    expect(mocks.activateGenerationIfComplete).toHaveBeenCalledWith("gen-1");
    expect(result).toEqual({
      generationId: "gen-1",
      skipped: false,
      activated: true,
    });
  });

  it("counts a SKIPPED file toward completion too", async () => {
    returning = [{ files_total: 2, files_processed: 0, files_skipped: 2 }];
    const result = await run({ skipped: true });

    expect(mocks.activateGenerationIfComplete).toHaveBeenCalledWith("gen-1");
    expect(result).toMatchObject({ skipped: true, activated: true });
  });

  it("stands down when a concurrent completer already flipped the generation", async () => {
    // Its own increment closed the gate, but activateGenerationIfComplete's
    // under-lock recheck found the generation no longer 'building'.
    returning = [{ files_total: 1, files_processed: 1, files_skipped: 0 }];
    mocks.activateGenerationIfComplete.mockResolvedValue({
      activated: false,
      generationId: "gen-1",
    });
    const result = await run();

    expect(mocks.activateGenerationIfComplete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ activated: false });
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
  });

  it("activates on an overshoot (counters past files_total), not only on exact equality", async () => {
    returning = [{ files_total: 2, files_processed: 3, files_skipped: 0 }];
    await run();
    expect(mocks.activateGenerationIfComplete).toHaveBeenCalledWith("gen-1");
  });

  it("returns without activating when the generation row is gone", async () => {
    returning = [];
    const result = await run();

    expect(mocks.activateGenerationIfComplete).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalled();
    expect(result).toEqual({
      generationId: "gen-1",
      skipped: false,
      activated: false,
    });
  });
});
