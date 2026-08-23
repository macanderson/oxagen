import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  updateSet:
    vi.fn<
      (arg: { table: unknown; payload: Record<string, unknown> }) => void
    >(),
  selectCalls: [] as Array<{ cols: unknown; table: unknown }>,
  put: vi.fn(),
  zipSync: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  // Per-table row fixtures. A value that is an Error means "this read fails".
  rowsByTable: new Map<unknown, unknown[] | Error>(),
}));

// ── schema sentinels ──────────────────────────────────────────────────────────
// Each table is a distinct object (used as the rowsByTable key). Each column is
// a distinct string so projection assertions can detect a leaked column.
const schema = {
  privacyExportRequests: { id: "privacyExportRequests.id" },
  users: { id: "users.id" },
  conversations: {
    id: "conversations.id",
    publicId: "conversations.publicId",
    orgId: "conversations.orgId",
    userId: "conversations.userId",
  },
  messages: { conversationId: "messages.conversationId" },
  apiKeys: {
    publicId: "apiKeys.publicId",
    name: "apiKeys.name",
    keyPrefix: "apiKeys.keyPrefix",
    keyHash: "apiKeys.keyHash", // MUST NEVER appear in a projection
    createdAt: "apiKeys.createdAt",
    lastUsedAt: "apiKeys.lastUsedAt",
    scope: "apiKeys.scope",
    expiresAt: "apiKeys.expiresAt",
    orgId: "apiKeys.orgId",
    createdByUserId: "apiKeys.createdByUserId",
  },
  securityEvents: {
    orgId: "securityEvents.orgId",
    actorUserId: "securityEvents.actorUserId",
  },
  generatedAssets: {
    publicId: "generatedAssets.publicId",
    kind: "generatedAssets.kind",
    accessPolicy: "generatedAssets.accessPolicy",
    status: "generatedAssets.status",
    mimeType: "generatedAssets.mimeType",
    sizeBytes: "generatedAssets.sizeBytes",
    storageProvider: "generatedAssets.storageProvider",
    storageUrl: "generatedAssets.storageUrl",
    prompt: "generatedAssets.prompt",
    model: "generatedAssets.model",
    conversationId: "generatedAssets.conversationId",
    createdAt: "generatedAssets.createdAt",
    orgId: "generatedAssets.orgId",
    userId: "generatedAssets.userId",
  },
  orgUsers: {
    publicId: "orgUsers.publicId",
    userId: "orgUsers.userId",
    role: "orgUsers.role",
    joinedAt: "orgUsers.joinedAt",
    orgId: "orgUsers.orgId",
  },
  workspaces: {
    publicId: "workspaces.publicId",
    name: "workspaces.name",
    slug: "workspaces.slug",
    createdAt: "workspaces.createdAt",
    orgId: "workspaces.orgId",
  },
};

function rowsFor(table: unknown): Promise<unknown[]> {
  const value = mocks.rowsByTable.get(table);
  if (value instanceof Error) return Promise.reject(value);
  return Promise.resolve(value ?? []);
}

function makeTx() {
  return {
    select(cols?: unknown) {
      const call: { cols: unknown; table: unknown } = {
        cols,
        table: undefined,
      };
      mocks.selectCalls.push(call);
      return {
        from(table: unknown) {
          call.table = table;
          return { where: (_cond?: unknown) => rowsFor(table) };
        },
      };
    },
    update(table: unknown) {
      return {
        set(payload: Record<string, unknown>) {
          mocks.updateSet({ table, payload });
          return { where: () => Promise.resolve(undefined) };
        },
      };
    },
  };
}
const fakeTx = makeTx();

vi.mock("@oxagen/database", () => ({
  withSystemDb: async (fn: (tx: typeof fakeTx) => unknown) => fn(fakeTx),
  schema,
}));

vi.mock("@oxagen/storage", () => ({
  storage: () => ({ put: mocks.put }),
}));

vi.mock("fflate", () => ({ zipSync: mocks.zipSync }));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ col, val }),
    inArray: (col: unknown, vals: unknown) => ({ col, vals }),
  };
});

vi.mock("../logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock("../inngest", () => ({
  inngest: { createFunction: mocks.inngestCreateFunction },
}));

type Handler = (ctx: {
  event: { data: unknown };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;

const handlers: Record<string, Handler> = {};
mocks.inngestCreateFunction.mockImplementation(
  (opts: { id: string }, _trigger: unknown, handler: Handler) => {
    handlers[opts.id] = handler;
    return {};
  },
);

await import("./privacy.export.process");

function getHandler(id: string): Handler {
  const handler = handlers[id];
  if (!handler) throw new Error(`handler not registered: ${id}`);
  return handler;
}

function makeStep() {
  return { run: async (_name: string, fn: () => Promise<unknown>) => fn() };
}

// The entries map passed to the first zipSync call.
function firstZipEntries(): Record<string, Uint8Array> {
  const call = mocks.zipSync.mock.calls[0];
  if (!call) throw new Error("zipSync was not called");
  return call[0] as Record<string, Uint8Array>;
}

// The input passed to the first storage().put call.
function firstPutInput(): { key: string; access: string; contentType: string } {
  const call = mocks.put.mock.calls[0];
  if (!call) throw new Error("storage put was not called");
  return call[0] as { key: string; access: string; contentType: string };
}

// Decode a captured ZIP entry (Uint8Array of UTF-8 JSON) back to an object.
function decodeEntry(
  entries: Record<string, Uint8Array>,
  name: string,
): unknown {
  const bytes = entries[name];
  if (!bytes) throw new Error(`zip entry not found: ${name}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Seed the happy-path fixtures for a user-scope export.
function seedUserScopeRows() {
  mocks.rowsByTable.set(schema.users, [
    { id: "user-1", email: "subject@example.com", displayName: "Subject" },
  ]);
  mocks.rowsByTable.set(schema.conversations, [
    { id: "conv-uuid-1", publicId: "cnv_1", userId: "user-1", orgId: "org-1" },
  ]);
  mocks.rowsByTable.set(schema.messages, [
    { id: "msg-1", conversationId: "conv-uuid-1", role: "user", content: "hi" },
  ]);
  // api-keys projection returns metadata only (no keyHash column selected).
  mocks.rowsByTable.set(schema.apiKeys, [
    {
      id: "aky_1",
      name: "ci key",
      prefix: "ox_live_ab",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      scopes: ["read"],
      expiresAt: null,
    },
  ]);
  mocks.rowsByTable.set(schema.securityEvents, [
    { id: "sec-1", eventType: "auth.sign_in", actorUserId: "user-1" },
  ]);
  mocks.rowsByTable.set(schema.generatedAssets, [
    { id: "gen_1", kind: "image", sizeBytes: 1234n, mimeType: "image/png" },
  ]);
}

const baseEvent = {
  exportId: "exp-1",
  userId: "user-1",
  orgId: "org-1",
  scope: "user" as const,
};

describe("privacyExportProcess Inngest handler", () => {
  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.put.mockClear();
    mocks.zipSync.mockClear();
    mocks.loggerInfo.mockClear();
    mocks.loggerError.mockClear();
    mocks.selectCalls.length = 0;
    mocks.rowsByTable.clear();

    mocks.zipSync.mockImplementation(
      () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    );
    mocks.put.mockImplementation(
      async (input: { key: string; access?: string }) => ({
        url: `blob-private://${input.key}`,
        key: input.key,
        bytes: 4,
        access: input.access ?? "private",
      }),
    );
  });

  it("assembles the ZIP, uploads it privately, and marks the request ready with the URL", async () => {
    seedUserScopeRows();
    const handler = getHandler("privacy.export-process");

    await handler({ event: { data: baseEvent }, step: makeStep() });

    // Marked processing first, then ready with the stored URL.
    const setCalls = mocks.updateSet.mock.calls.map((c) => c[0].payload);
    expect(setCalls.some((p) => p.status === "processing")).toBe(true);
    const readyCall = setCalls.find((p) => p.status === "ready");
    expect(readyCall).toBeDefined();
    expect(readyCall?.exportUrl).toBe(
      "blob-private://privacy-exports/org-1/exp-1.zip",
    );
    expect(readyCall?.completedAt).toBeInstanceOf(Date);
    expect(setCalls.some((p) => p.status === "failed")).toBe(false);

    // The ZIP was built and uploaded as a PRIVATE blob.
    expect(mocks.zipSync).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledTimes(1);
    const putInput = firstPutInput();
    expect(putInput.access).toBe("private");
    expect(putInput.contentType).toBe("application/zip");
    expect(putInput.key).toBe("privacy-exports/org-1/exp-1.zip");

    // Expected artifacts present.
    const entries = firstZipEntries();
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([
        "user-profile.json",
        "conversations/cnv_1.json",
        "api-keys.json",
        "audit-log.json",
        "generated-assets.json",
      ]),
    );
    // User scope must NOT include org-only artifacts.
    expect(entries["members.json"]).toBeUndefined();
    expect(entries["workspaces.json"]).toBeUndefined();

    // Conversation file nests its messages.
    const conv = decodeEntry(entries, "conversations/cnv_1.json") as {
      conversation: { publicId: string };
      messages: unknown[];
    };
    expect(conv.conversation.publicId).toBe("cnv_1");
    expect(conv.messages).toHaveLength(1);

    // bigint sizeBytes coerced to a JSON-safe number.
    const assets = decodeEntry(entries, "generated-assets.json") as Array<{
      sizeBytes: number;
    }>;
    expect(assets[0]?.sizeBytes).toBe(1234);
  });

  it("api-keys.json contains only metadata — never key material", async () => {
    seedUserScopeRows();
    const handler = getHandler("privacy.export-process");
    await handler({ event: { data: baseEvent }, step: makeStep() });

    const entries = firstZipEntries();
    const apiKeys = decodeEntry(entries, "api-keys.json") as Array<
      Record<string, unknown>
    >;
    expect(apiKeys).toHaveLength(1);
    const keys = Object.keys(apiKeys[0] ?? {}).sort();
    expect(keys).toEqual(
      [
        "createdAt",
        "expiresAt",
        "id",
        "lastUsedAt",
        "name",
        "prefix",
        "scopes",
      ].sort(),
    );
    // No hashed/plaintext key material in the serialized entry.
    const raw = new TextDecoder().decode(entries["api-keys.json"]);
    expect(raw).not.toContain("keyHash");
    expect(raw).not.toContain("key_hash");

    // The api-keys SELECT projection must never have selected the keyHash column.
    const projectedValues = mocks.selectCalls
      .filter((c) => c.table === schema.apiKeys)
      .flatMap((c) => Object.values((c.cols ?? {}) as Record<string, unknown>));
    expect(projectedValues).not.toContain(schema.apiKeys.keyHash);
  });

  it("a single optional-artifact read failure still yields a ZIP (logged, not thrown)", async () => {
    seedUserScopeRows();
    // Audit read fails; every other artifact still succeeds.
    mocks.rowsByTable.set(
      schema.securityEvents,
      new Error("clickhouse timeout"),
    );
    const handler = getHandler("privacy.export-process");

    await expect(
      handler({ event: { data: baseEvent }, step: makeStep() }),
    ).resolves.toBeUndefined();

    // ZIP still assembled and uploaded, request still marked ready.
    expect(mocks.zipSync).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledTimes(1);
    const readyCall = mocks.updateSet.mock.calls
      .map((c) => c[0].payload)
      .find((p) => p.status === "ready");
    expect(readyCall).toBeDefined();

    // The failing artifact is absent; the rest are present; the failure is logged.
    const entries = firstZipEntries();
    expect(entries["audit-log.json"]).toBeUndefined();
    expect(entries["user-profile.json"]).toBeDefined();
    expect(entries["api-keys.json"]).toBeDefined();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ artifact: "audit-log.json" }),
      expect.stringContaining("optional artifact read failed"),
    );
  });

  it("aborts the export when the CORE profile cannot be read (never marks ready)", async () => {
    // No users row seeded → profile not found → throw.
    mocks.rowsByTable.set(schema.users, []);
    const handler = getHandler("privacy.export-process");

    await expect(
      handler({ event: { data: baseEvent }, step: makeStep() }),
    ).rejects.toThrow(/user user-1 not found/);

    expect(mocks.put).not.toHaveBeenCalled();
    const setCalls = mocks.updateSet.mock.calls.map((c) => c[0].payload);
    expect(setCalls.some((p) => p.status === "ready")).toBe(false);
  });

  it("org scope adds members.json and workspaces.json and scopes reads to the org", async () => {
    seedUserScopeRows();
    mocks.rowsByTable.set(schema.orgUsers, [
      {
        id: "oru_1",
        userId: "user-1",
        role: "owner",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    mocks.rowsByTable.set(schema.workspaces, [
      {
        id: "wrk_1",
        name: "Main",
        slug: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const handler = getHandler("privacy.export-process");

    await handler({
      event: { data: { ...baseEvent, scope: "org" as const } },
      step: makeStep(),
    });

    const entries = firstZipEntries();
    expect(entries["members.json"]).toBeDefined();
    expect(entries["workspaces.json"]).toBeDefined();

    // Conversations were scoped by org, not user, in org mode.
    const convSelect = mocks.selectCalls.find(
      (c) => c.table === schema.conversations,
    );
    expect(convSelect).toBeDefined();
  });

  it("on-failure handler marks the export failed with the error message", async () => {
    const handler = getHandler("privacy.export-process.on-failure");
    await handler({
      event: {
        data: {
          event: { data: { exportId: "exp-1" } },
          error: { message: "kaboom" },
        },
      },
      step: makeStep(),
    });

    const calls = mocks.updateSet.mock.calls.map((c) => c[0].payload);
    expect(
      calls.some((p) => p.status === "failed" && p.errorMessage === "kaboom"),
    ).toBe(true);
  });

  it("on-failure handler is a no-op when exportId is missing", async () => {
    const handler = getHandler("privacy.export-process.on-failure");
    await handler({
      event: { data: { event: { data: {} }, error: "x" } },
      step: makeStep(),
    });
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});
