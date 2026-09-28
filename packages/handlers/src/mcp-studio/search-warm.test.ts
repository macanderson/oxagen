/**
 * warmSearch embeds a published version's search entries and sweeps the rows
 * search no longer reads (lane M15; ADR-217). These tests replace the
 * workspace lookup and the Postgres side of the index, so they show what is
 * embedded, what is swept, and that no failure reaches the publish.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SearchIndexError, contentHash, searchEntryTexts, toolManifestSchema, type ToolManifest } from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspace: vi.fn(),
  readEmbeddingSettings: vi.fn(),
  embedderFor: vi.fn(),
  postgresSearchStore: vi.fn(),
  searchIndexOf: vi.fn(),
  sweep: vi.fn(),
  warm: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("./project", () => ({
  PROJECT_CAPABILITY: "publish_steering_version",
  resolveWorkspace: mocks.resolveWorkspace,
}));

vi.mock("./search-index", () => ({
  readEmbeddingSettings: mocks.readEmbeddingSettings,
  embedderFor: mocks.embedderFor,
  postgresSearchStore: mocks.postgresSearchStore,
  searchIndexOf: mocks.searchIndexOf,
}));

vi.mock("../logger", () => ({ logger: { info: mocks.info, warn: mocks.warn } }));

import { warmSearch } from "./search-warm";

const manifest: ToolManifest = toolManifestSchema.parse(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../mcp-studio/fixtures/expected/tool-manifest.json", import.meta.url)), "utf8"),
  ),
);

/** The fixture manifest with billing in search mode. */
const SEARCH_BILLING: ToolManifest = {
  ...manifest,
  servers: manifest.servers.map((s): ToolManifest["servers"][number] => (s.name === "billing" ? { ...s, exposure: { ...s.exposure, mode: "search" } } : s)),
};

const IDS = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const SCOPE = { ...IDS, principalKind: "service", capabilityName: "publish_steering_version" };
const KEY = "a".repeat(32);
const EMBEDDER = { key: KEY, embed: () => Promise.resolve([]) };
const STORE = { read: vi.fn(), write: vi.fn(), sweep: mocks.sweep };

function bundle(tools: ToolManifest | null, overrides: Partial<Bundle> = {}): Bundle {
  return {
    schema: "bundle/v1",
    repository: "github.com/a-intel/oxagen-core-platform",
    scope: "workspace",
    organization: "a-intel",
    workspace: "core-platform",
    version: 2,
    commit: "b5518188b20ddf02f905fadeaa50d9976abdcc90",
    ledger: null,
    published_at: "2026-09-28T08:00:00Z",
    records: [],
    always_on: [],
    policies: null,
    agents: [],
    tools,
    ...overrides,
  };
}

/** A promise with its resolve and reject exposed. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.resolveWorkspace.mockResolvedValue(IDS);
  mocks.readEmbeddingSettings.mockResolvedValue(undefined);
  mocks.embedderFor.mockResolvedValue(EMBEDDER);
  mocks.postgresSearchStore.mockReturnValue(STORE);
  mocks.searchIndexOf.mockReturnValue({ key: KEY, warm: mocks.warm });
  mocks.sweep.mockResolvedValue(0);
  mocks.warm.mockResolvedValue(2);
});

describe("warmSearch", () => {
  it("embeds the search-mode entries and then sweeps the rows no search reads", async () => {
    const texts = searchEntryTexts(SEARCH_BILLING);
    const order: string[] = [];
    mocks.warm.mockImplementation(() => {
      order.push("warm");
      return Promise.resolve(2);
    });
    mocks.sweep.mockImplementation(() => {
      order.push("sweep");
      return Promise.resolve(3);
    });

    await warmSearch(bundle(SEARCH_BILLING));

    expect(texts).toHaveLength(2);
    expect(mocks.resolveWorkspace).toHaveBeenCalledWith("a-intel", "core-platform");
    expect(mocks.postgresSearchStore).toHaveBeenCalledWith(SCOPE);
    expect(mocks.embedderFor).toHaveBeenCalledWith(expect.objectContaining({ provider: "oxagen" }), SCOPE);
    expect(mocks.searchIndexOf).toHaveBeenCalledWith(EMBEDDER, SCOPE, STORE);
    expect(mocks.warm).toHaveBeenCalledWith(texts);
    expect(mocks.sweep).toHaveBeenCalledWith(KEY, texts.map(contentHash));
    expect(order).toEqual(["warm", "sweep"]);
    expect(mocks.info).toHaveBeenCalledWith(
      { workspaceId: IDS.workspaceId, count: 2, embedded: 2, swept: 3 },
      "Embedded the search entries.",
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("builds the embedder the workspace's [embeddings] setting names", async () => {
    mocks.readEmbeddingSettings.mockResolvedValueOnce({
      provider: "custom",
      url: "https://embed.example.com/v1/embeddings",
      model: "house-embed",
    });

    await warmSearch(bundle(SEARCH_BILLING));

    expect(mocks.readEmbeddingSettings).toHaveBeenCalledWith(SCOPE);
    expect(mocks.embedderFor).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "custom", url: "https://embed.example.com/v1/embeddings", model: "house-embed", credential: null }),
      SCOPE,
    );
  });

  it("sweeps every row and embeds nothing when the workspace ranks by keyword", async () => {
    mocks.readEmbeddingSettings.mockResolvedValueOnce({ provider: "keyword" });
    mocks.embedderFor.mockResolvedValueOnce(null);
    mocks.sweep.mockResolvedValueOnce(4);

    await warmSearch(bundle(SEARCH_BILLING));

    expect(mocks.embedderFor).toHaveBeenCalledWith({ provider: "keyword", invalid: false }, SCOPE);
    expect(mocks.sweep).toHaveBeenCalledWith(null);
    expect(mocks.searchIndexOf).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith({ workspaceId: IDS.workspaceId, swept: 4 }, "Deleted the search vectors no search reads.");
  });

  it("sweeps every row without reading the setting when no server is in search mode", async () => {
    await warmSearch(bundle(manifest));

    expect(mocks.readEmbeddingSettings).not.toHaveBeenCalled();
    expect(mocks.embedderFor).not.toHaveBeenCalled();
    expect(mocks.sweep).toHaveBeenCalledWith(null);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each([
    ["an organization bundle", bundle(SEARCH_BILLING, { scope: "organization", workspace: undefined })],
    ["a bundle whose tools did not compile", bundle(null)],
  ])("skips %s", async (_case, skipped) => {
    await warmSearch(skipped);

    expect(mocks.resolveWorkspace).not.toHaveBeenCalled();
    expect(mocks.postgresSearchStore).not.toHaveBeenCalled();
  });

  it("returns once the wait passes and logs the warm when it ends", async () => {
    const late = deferred<number>();
    mocks.warm.mockReturnValueOnce(late.promise);

    await warmSearch(bundle(SEARCH_BILLING), { waitMs: 1 });

    expect(mocks.info).toHaveBeenCalledWith(
      { workspaceId: IDS.workspaceId, count: 2 },
      "The search entries are still embedding after publish.",
    );
    expect(mocks.sweep).not.toHaveBeenCalled();

    late.resolve(2);

    await vi.waitFor(() => {
      expect(mocks.info).toHaveBeenCalledWith(
        { workspaceId: IDS.workspaceId, embedded: 2, swept: 0 },
        "Embedded the search entries after publish.",
      );
    });
  });

  it("logs a warm that fails after the wait by the error's name alone", async () => {
    const late = deferred<number>();
    mocks.warm.mockReturnValueOnce(late.promise);

    await warmSearch(bundle(SEARCH_BILLING), { waitMs: 1 });
    late.reject(new SearchIndexError("unreachable", "The embeddings endpoint answered HTTP 503.", 503));

    await vi.waitFor(() => {
      expect(mocks.warn).toHaveBeenCalledWith({ workspaceId: IDS.workspaceId, errorName: "SearchIndexError" }, expect.any(String));
    });
    expect(mocks.sweep).not.toHaveBeenCalled();
  });

  it("never fails the publish when the key is missing", async () => {
    mocks.embedderFor.mockRejectedValueOnce(new SearchIndexError("no_key", "VOYAGE_API_KEY is not set, so search ranks by keyword."));

    await expect(warmSearch(bundle(SEARCH_BILLING))).resolves.toBeUndefined();

    expect(mocks.warn).toHaveBeenCalledWith(
      { workspaceId: IDS.workspaceId, errorName: "SearchIndexError" },
      "The search entries were not embedded at publish, so search embeds them when it runs and ranks by keyword until then.",
    );
    expect(mocks.sweep).not.toHaveBeenCalled();
  });

  it("never fails the publish when the workspace lookup fails", async () => {
    mocks.resolveWorkspace.mockRejectedValueOnce(new Error("connection reset"));

    await expect(warmSearch(bundle(SEARCH_BILLING))).resolves.toBeUndefined();

    expect(mocks.warn).toHaveBeenCalledWith({ workspaceId: undefined, errorName: "Error" }, expect.any(String));
  });

  it("names a thrown value that is not an Error by its type", async () => {
    mocks.warm.mockRejectedValueOnce("socket hang up");

    await warmSearch(bundle(SEARCH_BILLING));

    expect(mocks.warn).toHaveBeenCalledWith({ workspaceId: IDS.workspaceId, errorName: "string" }, expect.any(String));
  });
});
