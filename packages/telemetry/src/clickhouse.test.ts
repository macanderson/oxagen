// clickhouse.test.ts
//
// Unit tests for the pure, I/O-free utility functions exported from clickhouse.ts.
// These functions are called by packages/ai (stream.ts, embed.ts) and must be
// stable across model id formats — hence dedicated coverage here rather than
// relying on consumer mocks.

import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPrompt, providerFromModelId } from "./clickhouse";

// ---------------------------------------------------------------------------
// hashPrompt
// ---------------------------------------------------------------------------

describe("hashPrompt", () => {
  it("returns a 32-character hex string", async () => {
    const result = await hashPrompt("hello world");
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic for the same input", async () => {
    const a = await hashPrompt("consistent input");
    const b = await hashPrompt("consistent input");
    expect(a).toBe(b);
  });

  it("returns different hashes for different inputs", async () => {
    const a = await hashPrompt("input-a");
    const b = await hashPrompt("input-b");
    expect(a).not.toBe(b);
  });

  it("handles an empty string without throwing", async () => {
    const result = await hashPrompt("");
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// providerFromModelId
// ---------------------------------------------------------------------------

describe("providerFromModelId", () => {
  it("maps a bare claude model id to 'anthropic'", () => {
    expect(providerFromModelId("claude-sonnet-4-6")).toBe("anthropic");
    expect(providerFromModelId("claude-3-haiku-20240307")).toBe("anthropic");
    expect(providerFromModelId("claude-opus-4")).toBe("anthropic");
  });

  it("maps a bare gpt model id to 'openai'", () => {
    expect(providerFromModelId("gpt-4o")).toBe("openai");
    expect(providerFromModelId("gpt-3.5-turbo")).toBe("openai");
  });

  it("maps o-series model ids to 'openai'", () => {
    expect(providerFromModelId("o1-preview")).toBe("openai");
    expect(providerFromModelId("o3-mini")).toBe("openai");
    expect(providerFromModelId("o4-mini")).toBe("openai");
  });

  it("maps text-embedding model ids to 'openai'", () => {
    expect(providerFromModelId("text-embedding-3-small")).toBe("openai");
    expect(providerFromModelId("text-embedding-ada-002")).toBe("openai");
  });

  it("maps the prefixed form 'anthropic:claude-3' to 'anthropic'", () => {
    expect(providerFromModelId("anthropic:claude-3-haiku-20240307")).toBe("anthropic");
    expect(providerFromModelId("anthropic:claude-sonnet-4-6")).toBe("anthropic");
  });

  it("maps the prefixed form 'openai:gpt-4o' to 'openai'", () => {
    expect(providerFromModelId("openai:gpt-4o")).toBe("openai");
  });

  it("returns '' for an unknown model id", () => {
    expect(providerFromModelId("unknown-model-xyz")).toBe("");
    expect(providerFromModelId("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// clickhouse() client construction
//
// Regression guard: every caller stamps timestamps with `Date.toISOString()`
// (ISO-8601 `T`/`Z` form). ClickHouse's default `basic` date_time_input_format
// rejects that against DateTime64 columns ("Cannot parse input ... created_at"),
// silently dropping all token/tool telemetry. The singleton must enable
// `best_effort` parsing so ISO timestamps ingest. This test fails if that
// setting is ever dropped from createClient.
// ---------------------------------------------------------------------------

const createClientMock = vi.hoisted(() =>
  vi.fn((_config: { clickhouse_settings?: { date_time_input_format?: string } }) => ({
    close: vi.fn(),
  })),
);

vi.mock("@clickhouse/client", () => ({
  createClient: createClientMock,
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    CLICKHOUSE_URL: "https://ch.example",
    CLICKHOUSE_USERNAME: "u",
    CLICKHOUSE_PASSWORD: "p",
    CLICKHOUSE_DATABASE: "db",
  }),
}));

describe("clickhouse client construction", () => {
  afterEach(() => {
    vi.resetModules();
    createClientMock.mockClear();
  });

  it("enables best_effort date_time_input_format so ISO-8601 timestamps ingest", async () => {
    // Re-import under the mocks with a fresh module registry so the singleton
    // is rebuilt and createClient is actually invoked.
    vi.resetModules();
    const { clickhouse, closeClickhouse } = await import("./clickhouse");
    await closeClickhouse();
    clickhouse();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    const config = createClientMock.mock.calls[0]![0];
    expect(config.clickhouse_settings?.date_time_input_format).toBe("best_effort");
  });
});
