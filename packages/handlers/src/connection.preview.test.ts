/**
 * connection.preview handler tests.
 *
 * Strategy: mock @oxagen/database (withTenantDb), @oxagen/crypto (decrypt,
 * resolveIngestionCryptoAdapterForKeyId), and @oxagen/ingestion/connectors (getConnector).
 * Assert:
 *   - connection not found → throws HTTPException 404
 *   - decrypts auth credentials and calls connector.previewRecordTypes
 *   - maps RecordTypeSample[] to contract output shape
 *   - caps sampleRecords at 3
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  selectRows: vi.fn(),
  decrypt: vi.fn(),
  previewRecordTypes: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => mocks.selectRows(),
              }),
            }),
          }),
        }),
      }),
  };
});

vi.mock("@oxagen/crypto", () => ({
  resolveIngestionCryptoAdapterForKeyId: (keyId: string) => ({
    adapter: {},
    keyId,
  }),
  decrypt: mocks.decrypt,
  encrypt: vi.fn(),
}));

vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: () => ({
    previewRecordTypes: mocks.previewRecordTypes,
  }),
}));

import { connectionPreviewHandler } from "./connection.preview";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const FAKE_ROW = {
  id: "conn-uuid-1",
  connectorId: "github",
  deliveryConfig: { owner: "acme", repo: "app" },
  orgId: CTX.orgId,
  workspaceId: CTX.workspaceId,
  encryptedPayload: { keyId: "test-key-id", ciphertext: Buffer.from("{}").toString("base64") },
};

const SAMPLE_RECORDS = [
  { id: 1, name: "Alpha" },
  { id: 2, name: "Beta" },
  { id: 3, name: "Gamma" },
  { id: 4, name: "Delta" }, // should be trimmed to 3
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectRows.mockResolvedValue([FAKE_ROW]);
  mocks.decrypt.mockResolvedValue(JSON.stringify({ scheme: "oauth2", _marker: "oauth2" }));
  mocks.previewRecordTypes.mockResolvedValue([
    {
      sourceRecordType: "pull_request",
      displayName: "Pull Requests",
      sampleRecords: SAMPLE_RECORDS,
      fieldSchema: { id: "number", title: "string", state: "string" },
    },
  ]);
});

describe("connectionPreviewHandler — not found", () => {
  it("throws 404 when connection is not found", async () => {
    mocks.selectRows.mockResolvedValueOnce([]);
    await expect(
      connectionPreviewHandler({ connectionId: "missing-id" }, CTX),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("connectionPreviewHandler — happy path", () => {
  it("calls previewRecordTypes with decrypted credentials", async () => {
    await connectionPreviewHandler({ connectionId: "conn-public-id" }, CTX);
    expect(mocks.decrypt).toHaveBeenCalledTimes(1);
    expect(mocks.previewRecordTypes).toHaveBeenCalledWith(
      { scheme: "oauth2", _marker: "oauth2" },
      FAKE_ROW.deliveryConfig,
    );
  });

  it("maps samples to contract output shape", async () => {
    const result = await connectionPreviewHandler({ connectionId: "conn-public-id" }, CTX);
    expect(result.recordTypes).toHaveLength(1);
    const rt = result.recordTypes[0]!;
    expect(rt.sourceRecordType).toBe("pull_request");
    expect(rt.displayName).toBe("Pull Requests");
    expect(rt.sampleCount).toBe(4); // total records in the sample, not capped
    expect(rt.sampleFields).toEqual(["id", "title", "state"]);
  });

  it("caps sampleRecords at 3", async () => {
    const result = await connectionPreviewHandler({ connectionId: "conn-public-id" }, CTX);
    expect(result.recordTypes[0]!.sampleRecords).toHaveLength(3);
  });

  it("handles empty deliveryConfig gracefully", async () => {
    mocks.selectRows.mockResolvedValueOnce([{ ...FAKE_ROW, deliveryConfig: null }]);
    await expect(
      connectionPreviewHandler({ connectionId: "conn-public-id" }, CTX),
    ).resolves.toBeDefined();
    expect(mocks.previewRecordTypes).toHaveBeenCalledWith(
      expect.anything(),
      {},
    );
  });
});

describe("connectionPreviewHandler — multiple record types", () => {
  it("returns all record types from connector", async () => {
    mocks.previewRecordTypes.mockResolvedValueOnce([
      {
        sourceRecordType: "pull_request",
        displayName: "Pull Requests",
        sampleRecords: [{ id: 1 }],
        fieldSchema: { id: "number" },
      },
      {
        sourceRecordType: "issue",
        displayName: "Issues",
        sampleRecords: [],
        fieldSchema: { id: "number", body: "string" },
      },
    ]);

    const result = await connectionPreviewHandler({ connectionId: "conn-public-id" }, CTX);
    expect(result.recordTypes).toHaveLength(2);
    expect(result.recordTypes[1]!.sourceRecordType).toBe("issue");
    expect(result.recordTypes[1]!.sampleCount).toBe(0);
  });
});
