// run-token-sources.test.ts — the sum the spend rollup writes into
// cost.run_totals for the three token sources (#4493), against a mocked
// ClickHouse client: the calls it sums over and how an absent source reads.
import { beforeEach, describe, expect, it, vi } from "vitest";

interface QueryCall {
  query: string;
  query_params: Record<string, unknown>;
}

const queryMock =
  vi.fn<(args: QueryCall) => Promise<{ json: () => Promise<unknown[]> }>>();

vi.mock("./clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clickhouse")>();
  return { ...actual, clickhouse: () => ({ query: queryMock }) };
});

import {
  LLM_CALL_DUPLICATE_OF_ATTR,
  LLM_CALL_TOKEN_SOURCES,
} from "@oxagen/tacho";
import {
  NO_RUN_TOKEN_SOURCES,
  readRunTokenSources,
} from "./run-token-sources";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const ROOT = "00000000-0000-4000-8000-0000000000aa";
const CHILD = "00000000-0000-4000-8000-0000000000bb";

function answer(rows: unknown[]): void {
  queryMock.mockResolvedValueOnce({ json: async () => rows });
}

function lastQuery(): QueryCall {
  return queryMock.mock.calls.at(-1)![0];
}

const tacho = (sessionUuids: readonly string[]) => ({
  orgId: ORG,
  workspaceId: WS,
  run: { kind: "tacho" as const, rootSessionUuid: ROOT, sessionUuids },
});

beforeEach(() => queryMock.mockReset());

describe("readRunTokenSources", () => {
  it("reads nothing for a ledger run, whose gateway does not measure the sources", async () => {
    const sources = await readRunTokenSources({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "ledger", runUuid: ROOT },
    });
    expect(sources).toEqual(NO_RUN_TOKEN_SOURCES);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("sums each source over the calls the rollup prices", async () => {
    // 64-bit figures come back quoted.
    answer([
      {
        tool_definition_tokens: "12400",
        tool_definition_tokens_calls: "3",
        context_frame_tokens: "0",
        context_frame_tokens_calls: "0",
        steering_tokens: "900",
        steering_tokens_calls: "3",
      },
    ]);
    const sources = await readRunTokenSources(tacho([ROOT, CHILD]));
    expect(sources).toEqual({
      toolDefinitionTokens: 12_400,
      contextFrameTokens: null,
      steeringTokens: 900,
    });
  });

  it("reads null, never zero, when no priced call carried a source", async () => {
    answer([
      {
        tool_definition_tokens: "0",
        tool_definition_tokens_calls: "0",
        context_frame_tokens: "0",
        context_frame_tokens_calls: "0",
        steering_tokens: "0",
        steering_tokens_calls: "0",
      },
    ]);
    expect(await readRunTokenSources(tacho([ROOT]))).toEqual(
      NO_RUN_TOKEN_SOURCES,
    );
  });

  it("keeps a measured zero as zero", async () => {
    answer([
      {
        tool_definition_tokens: 0,
        tool_definition_tokens_calls: 2,
        context_frame_tokens: 0,
        context_frame_tokens_calls: 0,
        steering_tokens: 0,
        steering_tokens_calls: 2,
      },
    ]);
    expect(await readRunTokenSources(tacho([ROOT]))).toEqual({
      toolDefinitionTokens: 0,
      contextFrameTokens: null,
      steeringTokens: 0,
    });
  });

  it("reads null for every source when the store returns no row", async () => {
    answer([]);
    expect(await readRunTokenSources(tacho([ROOT]))).toEqual(
      NO_RUN_TOKEN_SOURCES,
    );
  });

  it("sums over the priced rows of the run's own sessions and workspace", async () => {
    answer([]);
    await readRunTokenSources(tacho([ROOT, CHILD]));
    const { query, query_params } = lastQuery();
    expect(query).toContain("FROM tacho_events FINAL");
    expect(query).toContain("workspace_id = {workspaceId:UUID}");
    expect(query).toContain("root_session_uuid = {rootSessionUuid:UUID}");
    expect(query).toContain("session_uuid IN {sessionUuids:Array(UUID)}");
    expect(query).toContain("kind = 'llm_call'");
    expect(query).toContain("source IN {sources:Array(String)}");
    expect(query).toContain("attrs[{duplicateAttr:String}] = ''");
    expect(query).toContain("model != ''");
    for (const column of [
      "tool_definition_tokens",
      "context_frame_tokens",
      "steering_tokens",
    ]) {
      expect(query).toContain(
        `toUInt64(coalesce(sum(${column}), 0)) AS ${column}`,
      );
      expect(query).toContain(`count(${column}) AS ${column}_calls`);
    }
    expect(query_params).toEqual({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: ROOT,
      sessionUuids: [ROOT, CHILD],
      sources: LLM_CALL_TOKEN_SOURCES,
      duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
    });
  });

  it("names the root session even when the caller's list left it out", async () => {
    answer([]);
    await readRunTokenSources(tacho([CHILD]));
    expect(lastQuery().query_params.sessionUuids).toEqual([ROOT, CHILD]);
  });

  it("throws when the store fails, so the rollup retries", async () => {
    queryMock.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(readRunTokenSources(tacho([ROOT]))).rejects.toThrow(
      "clickhouse down",
    );
  });
});
