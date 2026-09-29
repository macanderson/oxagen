/**
 * The Postgres side of a workspace's search index (lane M15; ADR-217). These
 * tests replace the transaction, the credential decrypt, and the HTTP
 * embedder, so they show which setting is read, which embedder each provider
 * gets, and that no key or credential error escapes. search-index.pg.test.ts
 * runs the store against Postgres.
 */
import { SearchIndex, SearchIndexError, type EmbeddingTarget } from "@oxagen/mcp-studio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  /** The rows each select returns, in order. */
  const selected: unknown[][] = [];
  const limit = () => Promise.resolve(selected.shift() ?? []);
  const tx = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) };
  return {
    selected,
    tx,
    scopes: [] as unknown[],
    resolveCredentialKms: vi.fn(),
    decryptCredentialSecrets: vi.fn(),
    httpEmbedder: vi.fn(),
    searchUsageMeter: vi.fn(),
    usageMeter: vi.fn(),
    warn: vi.fn(),
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.tx) };
});

vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return {
    ...real,
    runInTenantScope: (scope: unknown, fn: () => unknown) => {
      mocks.scopes.push(scope);
      return fn();
    },
  };
});

vi.mock("@oxagen/plugins", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/plugins")>();
  return {
    ...real,
    resolveCredentialKms: mocks.resolveCredentialKms,
    decryptCredentialSecrets: mocks.decryptCredentialSecrets,
  };
});

vi.mock("@oxagen/mcp-studio", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/mcp-studio")>();
  return { ...real, httpEmbedder: mocks.httpEmbedder };
});

vi.mock("./search-usage", () => ({ searchUsageMeter: mocks.searchUsageMeter }));

vi.mock("../logger", () => ({ logger: { warn: mocks.warn, info: vi.fn() } }));

import {
  decodeVector,
  embedderFor,
  encodeVector,
  readEmbeddingSettings,
  searchIndexFor,
  searchIndexLog,
  searchIndexOf,
  type SearchScope,
} from "./search-index";

const SCOPE: SearchScope = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  principalKind: "service",
};

const OXAGEN: EmbeddingTarget = {
  provider: "oxagen",
  url: "https://api.voyageai.com/v1/embeddings",
  model: "voyage-4-large",
  key: "a".repeat(32),
};

function custom(credential: string | null): EmbeddingTarget {
  return { provider: "custom", url: "https://embed.example.com/v1/embeddings", model: "house-embed", credential, key: "b".repeat(32) };
}

const ACTIVE_ROW = {
  status: "active",
  tokenKmsKeyId: "kms-key",
  accessTokenEnc: null,
  refreshTokenEnc: null,
  secretEnc: "ciphertext",
  oauthClientSecretEnc: null,
};

/** The error a promise rejects with, or null when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

beforeEach(() => {
  mocks.selected.length = 0;
  mocks.scopes.length = 0;
  mocks.resolveCredentialKms.mockReturnValue({ keyId: "kms-key" });
  mocks.decryptCredentialSecrets.mockResolvedValue({ accessToken: null, refreshToken: null, secret: "house-secret", oauthClientSecret: null });
  mocks.httpEmbedder.mockImplementation((options: { key: string }) => ({ key: options.key, embed: () => Promise.resolve([]) }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encodeVector and decodeVector", () => {
  it("round-trips a vector as little endian Float32 values", () => {
    const vector = new Float32Array([0.5, -1.25, 3]);

    const bytes = encodeVector(vector);

    expect(bytes.byteLength).toBe(12);
    expect(bytes.readFloatLE(4)).toBe(-1.25);
    expect(decodeVector(bytes, 3)).toEqual(vector);
  });

  it("reads no vector when the bytes do not hold the stored dimensions", () => {
    const bytes = encodeVector(new Float32Array([1, 2]));

    expect(decodeVector(bytes, 3)).toBeNull();
    expect(decodeVector(bytes, 0)).toBeNull();
    expect(decodeVector(bytes, 1.5)).toBeNull();
  });
});

describe("readEmbeddingSettings", () => {
  it("reads the workspace's [embeddings] value inside the workspace's scope", async () => {
    mocks.selected.push([{ settings: { embeddings: { provider: "keyword" }, theme: "dark" } }]);

    await expect(readEmbeddingSettings(SCOPE)).resolves.toEqual({ provider: "keyword" });
    expect(mocks.scopes).toEqual([SCOPE]);
  });

  it("reads nothing when the workspace has no settings object", async () => {
    mocks.selected.push([{ settings: null }]);
    await expect(readEmbeddingSettings(SCOPE)).resolves.toBeUndefined();

    mocks.selected.push([{ settings: ["embeddings"] }]);
    await expect(readEmbeddingSettings(SCOPE)).resolves.toBeUndefined();

    mocks.selected.push([]);
    await expect(readEmbeddingSettings(SCOPE)).resolves.toBeUndefined();
  });
});

describe("embedderFor", () => {
  it("builds no embedder for keyword", async () => {
    await expect(embedderFor({ provider: "keyword", invalid: false }, SCOPE)).resolves.toBeNull();
    expect(mocks.httpEmbedder).not.toHaveBeenCalled();
  });

  it("sends Oxagen's provider to Voyage with the deployment's key and an input type", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "voyage-test-key");
    mocks.searchUsageMeter.mockReturnValue(mocks.usageMeter);

    const embedder = await embedderFor(OXAGEN, SCOPE);

    expect(embedder?.key).toBe(OXAGEN.key);
    expect(mocks.httpEmbedder).toHaveBeenCalledWith({
      url: "https://api.voyageai.com/v1/embeddings",
      model: "voyage-4-large",
      key: OXAGEN.key,
      apiKey: "voyage-test-key",
      inputType: true,
      meter: mocks.usageMeter,
    });
    // Each request is metered under this workspace's scope.
    expect(mocks.searchUsageMeter).toHaveBeenCalledWith(SCOPE, "voyage-4-large");
  });

  it("throws no_key without quoting anything when the deployment has no Voyage key", async () => {
    vi.stubEnv("VOYAGE_API_KEY", undefined);
    const unset = await rejection(embedderFor(OXAGEN, SCOPE));

    vi.stubEnv("VOYAGE_API_KEY", "");
    const empty = await rejection(embedderFor(OXAGEN, SCOPE));

    for (const error of [unset, empty]) {
      expect(error).toBeInstanceOf(SearchIndexError);
      expect(error).toMatchObject({ code: "no_key" });
    }
    expect(mocks.httpEmbedder).not.toHaveBeenCalled();
  });

  it("sends a custom endpoint no key when [embeddings] names no credential", async () => {
    const embedder = await embedderFor(custom(null), SCOPE);

    expect(embedder?.key).toBe("b".repeat(32));
    expect(mocks.httpEmbedder).toHaveBeenCalledWith({
      url: "https://embed.example.com/v1/embeddings",
      model: "house-embed",
      key: "b".repeat(32),
      apiKey: null,
      inputType: false,
    });
    expect(mocks.decryptCredentialSecrets).not.toHaveBeenCalled();
  });

  it("sends a custom endpoint the secret its credential holds", async () => {
    mocks.selected.push([ACTIVE_ROW]);

    await embedderFor(custom("oxagen:credential/house-embeddings"), SCOPE);

    expect(mocks.decryptCredentialSecrets).toHaveBeenCalledWith(ACTIVE_ROW, { keyId: "kms-key" });
    expect(mocks.httpEmbedder).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "house-secret", inputType: false }));
    expect(mocks.scopes).toEqual([SCOPE]);
  });

  it("prefers a credential's access token over its secret", async () => {
    mocks.selected.push([ACTIVE_ROW]);
    mocks.decryptCredentialSecrets.mockResolvedValueOnce({
      accessToken: "oauth-token",
      refreshToken: null,
      secret: "house-secret",
      oauthClientSecret: null,
    });

    await embedderFor(custom("oxagen:credential/house-embeddings"), SCOPE);

    expect(mocks.httpEmbedder).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "oauth-token" }));
  });

  const UNREADABLE: Array<[string, string, () => void]> = [
    ["the reference is not an Oxagen credential", "vault:house-embeddings", () => undefined],
    [
      "no credential has the name",
      "oxagen:credential/missing",
      () => {
        mocks.selected.push([]);
      },
    ],
    [
      "the credential is revoked",
      "oxagen:credential/house-embeddings",
      () => {
        mocks.selected.push([{ ...ACTIVE_ROW, status: "revoked" }]);
      },
    ],
    [
      "the deployment has no credential key",
      "oxagen:credential/house-embeddings",
      () => {
        mocks.selected.push([ACTIVE_ROW]);
        mocks.resolveCredentialKms.mockReturnValueOnce(null);
      },
    ],
    [
      "the ciphertext does not decrypt",
      "oxagen:credential/house-embeddings",
      () => {
        mocks.selected.push([ACTIVE_ROW]);
        mocks.decryptCredentialSecrets.mockRejectedValueOnce(new Error("unsupported state or unable to authenticate data"));
      },
    ],
    [
      "the credential holds no secret",
      "oxagen:credential/house-embeddings",
      () => {
        mocks.selected.push([ACTIVE_ROW]);
        mocks.decryptCredentialSecrets.mockResolvedValueOnce({ accessToken: null, refreshToken: null, secret: null, oauthClientSecret: null });
      },
    ],
  ];

  it.each(UNREADABLE)("throws no_key when %s", async (_case, reference, arrange) => {
    arrange();

    const error = await rejection(embedderFor(custom(reference), SCOPE));

    expect(error).toBeInstanceOf(SearchIndexError);
    expect(error).toMatchObject({ code: "no_key" });
    expect((error as Error).message).not.toContain("unable to authenticate");
    expect(mocks.httpEmbedder).not.toHaveBeenCalled();
  });
});

describe("searchIndexFor", () => {
  it("finds no index for a workspace that ranks by keyword", async () => {
    mocks.selected.push([{ settings: { embeddings: { provider: "keyword" } } }]);

    await expect(searchIndexFor(SCOPE)).resolves.toBeNull();
  });

  it("builds an index under the target key of the workspace's setting", async () => {
    vi.stubEnv("VOYAGE_API_KEY", "voyage-test-key");
    mocks.selected.push([{ settings: {} }]);

    const index = await searchIndexFor(SCOPE);

    expect(index).toBeInstanceOf(SearchIndex);
    expect(index?.key).toMatch(/^[0-9a-f]{32}$/);
    expect(mocks.httpEmbedder).toHaveBeenCalledWith(expect.objectContaining({ model: "voyage-4-large", inputType: true }));
  });

  it("throws no_key for a custom setting whose credential is gone", async () => {
    mocks.selected.push([
      {
        settings: {
          embeddings: {
            provider: "custom",
            url: "https://embed.example.com/v1/embeddings",
            model: "house-embed",
            credential: "oxagen:credential/house-embeddings",
          },
        },
      },
    ]);
    mocks.selected.push([]);

    await expect(searchIndexFor(SCOPE)).rejects.toMatchObject({ code: "no_key" });
  });
});

describe("searchIndexOf and searchIndexLog", () => {
  it("builds an index over the embedder and the store it is given", () => {
    const embedder = { key: "c".repeat(32), embed: () => Promise.resolve([]) };
    const store = { read: () => Promise.resolve([]), write: () => Promise.resolve() };

    const index = searchIndexOf(embedder, SCOPE, store);

    expect(index.key).toBe("c".repeat(32));
  });

  it("shares the process's pending vectors, so a search during a warm embeds no line twice", async () => {
    const calls: string[] = [];
    const embedderOf = () => ({
      key: "e".repeat(32),
      embed: (texts: readonly string[], purpose: string) => {
        calls.push(purpose);
        return new Promise<Float32Array[]>((resolve) => {
          setTimeout(() => resolve(texts.map(() => new Float32Array([1, 0]))), 1);
        });
      },
    });
    const store = { read: () => Promise.resolve([]), write: () => Promise.resolve() };
    const texts = ["shared_pending_one: The first line.", "shared_pending_two: The second line."];

    const [embedded, found] = await Promise.all([
      searchIndexOf(embedderOf(), SCOPE, store).warm(texts),
      searchIndexOf(embedderOf(), SCOPE, store).vectors(texts),
    ]);

    expect(calls).toEqual(["document"]);
    expect(embedded).toBe(2);
    expect(found.size).toBe(2);
  });

  it("logs the index's warnings with their fields", () => {
    searchIndexLog("The search index could not store new vectors.", { errorName: "Error", count: 2 });

    expect(mocks.warn).toHaveBeenCalledWith({ errorName: "Error", count: 2 }, "The search index could not store new vectors.");
  });
});
