// cost-frames.test.ts — the frame reads the spend rollup is rebuilt from,
// against a mocked ClickHouse client: the columns each store's query selects
// and the shape the rows come back in (docs/specs/tacho/data-model.md §2.7).
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
  readModelCallFrames,
  readObservedModels,
  readTachoToolCallFrames,
  readTachoToolCallObservations,
} from "./cost-frames";

const ORG = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-0000000000aa";

/**
 * The thinking figure the wrapped read prices a frame with: the transcript
 * row joined back after the duplicate filter dropped it (`t`), and the
 * priced row's own column only when no transcript row joins (`c`).
 */
const REASONING =
  "toInt64(if(coalesce(t.thinking, 0) > 0, coalesce(t.thinking, 0), coalesce(c.thinking_tokens, 0)))";

function answer(rows: unknown[]): void {
  queryMock.mockResolvedValueOnce({ json: async () => rows });
}

function lastQuery(): QueryCall {
  return queryMock.mock.calls.at(-1)![0];
}

/**
 * One `AS alias` per selected column of the OUTER select, in select order.
 * The text is cut at the outer `FROM` so a subquery's own aliases, and the
 * aliases the joined reads give their tables, cannot be read as columns the
 * caller receives.
 */
function selectedColumns(sql: string): string[] {
  const from = sql.search(/^\s*FROM /m);
  const projection = from === -1 ? sql : sql.slice(0, from);
  return [...projection.matchAll(/^\s*(.+?)\s+AS\s+(\w+),?$/gm)].map(
    (m) => m[2]!,
  );
}

beforeEach(() => queryMock.mockReset());

describe("readModelCallFrames", () => {
  it("reads a wrapped run's token-bearing sources and prices OTel cache creation as 5m writes", async () => {
    // The OTel log, collector and hook sources carry `cache_creation_tokens`
    // and no 5m/1h split, which is a transcript column, so a wrapped run's
    // cache writes come from the one column every admitted source populates.
    answer([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "firstParty",
        input_uncached: "1000",
        cache_read: "200",
        cache_write_5m: "300",
        output: "50",
        reasoning: "0",
        cost_micros: "4125",
      },
      {
        at: "2026-09-14T10:00:01.000Z",
        model: "claude-sonnet-5",
        provider: "",
        input_uncached: "10",
        cache_read: "0",
        cache_write_5m: "0",
        output: "5",
        reasoning: "0",
        cost_micros: null,
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      run: { kind: "tacho", rootSessionUuid: RUN },
    });

    const { query, query_params } = lastQuery();
    expect(query).toContain("FROM tacho_events FINAL");
    expect(query).toContain("kind = 'llm_call'");
    expect(query).toContain(
      "coalesce(c.cache_creation_tokens, 0) AS cache_write_5m",
    );
    expect(query).not.toMatch(
      /cache_creation_5m_tokens|cache_creation_1h_tokens/,
    );
    expect(selectedColumns(query)).toEqual([
      "at",
      "model",
      "provider",
      "input_uncached",
      "cache_read",
      "cache_write_5m",
      "output",
      "reasoning",
      "cost_micros",
    ]);
    expect(query_params).toEqual({
      orgId: ORG,
      rootSessionUuid: RUN,
      sources: ["otel_log", "collector", "hook", "transcript"],
      duplicateAttr: "oxagen.llm_call_duplicate_of",
    });
    // A call seen twice (OTel and transcript) is priced once: the host
    // stamps the later sighting and the rollup skips stamped rows.
    expect(query).toContain("attrs[{duplicateAttr:String}] = ''");
    // Retargeted from the per-turn source pick this read used to carry, which
    // admitted one source per (session, turn). The property that rule existed
    // for — an OTel stream that stops mid-session must not take the
    // collector's later calls with it — is now held by the stamp being
    // written per call, on the vendor request id: a call only the collector
    // saw is a first sighting, carries no stamp, and counts. So the read must
    // admit a row on the absence of its OWN stamp and nothing else. Any
    // per-turn or per-source authority pick here would drop those
    // collector-only calls again and bill the run short.
    expect(query).not.toContain("argMin(source");
    expect(query).not.toContain("turn_seq");
    expect(query).not.toContain("toStartOfMinute(ts)");

    expect(frames).toEqual([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "firstParty",
        inputUncached: 1000,
        cacheRead: 200,
        cacheWrite5m: 300,
        cacheWrite1h: 0,
        output: 50,
        reasoning: 0,
        reportedCostMicros: "4125",
        basis: "client_attested",
      },
      {
        at: "2026-09-14T10:00:01.000Z",
        model: "claude-sonnet-5",
        provider: null,
        inputUncached: 10,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 5,
        reasoning: 0,
        reportedCostMicros: null,
        basis: "client_attested",
      },
    ]);
  });

  // Both vendors count thinking inside the output figure they publish, and
  // the book prices reasoning under its own class. Left in `output`, every
  // thinking token is charged at the output rate, which is wrong for any
  // model whose published reasoning rate differs from its output rate.
  it("splits a wrapped call's thinking tokens out of the inclusive output figure", async () => {
    answer([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "firstParty",
        input_uncached: "1000",
        cache_read: "0",
        cache_write_5m: "0",
        // The query has done the subtraction: a call that reported 900
        // output tokens of which 400 were thinking leaves 500 to price at
        // the output rate and 400 at the reasoning rate.
        output: "500",
        reasoning: "400",
        cost_micros: null,
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      run: { kind: "tacho", rootSessionUuid: RUN },
    });

    const { query } = lastQuery();
    // The same `greatest(0, …)` idiom the ledger branch uses on an inclusive
    // `input_tokens`: a source that reports more thinking than output must
    // not drive the output class negative.
    expect(query).toContain(
      `toInt64(greatest(0, toInt64(coalesce(c.output_tokens, 0)) - ${REASONING}))`,
    );
    expect(query).toContain(`${REASONING} AS reasoning`);
    // The same figure on both sides: one that subtracted a different number
    // from `output` than it reported as `reasoning` would price part of the
    // call twice, or lose part of it.
    expect(query.split(REASONING)).toHaveLength(3);
    expect(frames[0]).toMatchObject({ output: 500, reasoning: 400 });
  });

  // The finding this covers: when the host sealed the OTel or proxy sighting
  // of a call first, the duplicate stamp lands on the TRANSCRIPT row, this
  // read drops it, and the row left to price carries no `thinking_tokens` at
  // all. Priced off that row alone, every reasoning token of the call is
  // charged at the output rate and `reasoning` reports zero.
  it("takes the thinking split from the duplicate transcript row of the same call", async () => {
    answer([]);
    await readModelCallFrames({
      orgId: ORG,
      run: { kind: "tacho", rootSessionUuid: RUN },
    });
    const { query } = lastQuery();

    // The call is still priced from the unstamped row: one duplicate filter,
    // on the priced side, exactly as before.
    const priced = query.slice(0, query.indexOf("LEFT JOIN"));
    expect(priced).toContain("attrs[{duplicateAttr:String}] = ''");
    expect(query.match(/attrs\[\{duplicateAttr:String\}\] = ''/g)).toHaveLength(
      1,
    );

    // The joined side is `countsLlmCallSplit`: transcript rows that are not
    // continuation blocks, and NOT filtered by the duplicate stamp, because
    // the row it needs is usually the stamped one.
    const joined = query.slice(query.indexOf("LEFT JOIN"));
    expect(joined).toContain("source = 'transcript'");
    expect(joined).toContain("attrs[{duplicateAttr:String}] != 'transcript'");
    expect(joined).not.toContain("attrs[{duplicateAttr:String}] = ''");

    // Joined on the vendor request id, then the message id: the order
    // `llmCallKeys` in @oxagen/tacho joins two sightings of one call by.
    expect(query).toContain("concat('request:', request_id)");
    expect(query).toContain("concat('message:', message_id)");
    expect(query).toContain("ON t.call_key = c.call_key");

    // One joined row per call at most, and none for a row carrying neither
    // id: a fan-out here would turn one call into several priced frames.
    expect(joined).toContain("toInt64(max(coalesce(thinking_tokens, 0)))");
    expect(joined).toContain("GROUP BY call_key");
    expect(joined).toContain("HAVING call_key != ''");

    // The transcript's figure wins, and a call no transcript row joins keeps
    // its own, which is how a collector-only call still reports reasoning.
    expect(query).toContain(REASONING);
  });

  it("maps a joined frame's reasoning and output onto the row shape", async () => {
    answer([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "firstParty",
        input_uncached: "1000",
        cache_read: "0",
        cache_write_5m: "0",
        // The OTel row the call is priced from reported 900 output tokens;
        // the transcript row the filter dropped reported 400 of thinking.
        output: "500",
        reasoning: "400",
        cost_micros: "4125",
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      run: { kind: "tacho", rootSessionUuid: RUN },
    });
    expect(frames).toEqual([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "firstParty",
        inputUncached: 1000,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 500,
        reasoning: 400,
        reportedCostMicros: "4125",
        basis: "client_attested",
      },
    ]);
  });

  it("reads a ledger run's gateway-metered rows as gateway_observed", async () => {
    answer([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "anthropic",
        input_uncached: "700",
        cache_read: "200",
        cache_write_5m: "100",
        output: "50",
        cost_micros: "3000",
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      run: { kind: "ledger", runUuid: RUN },
    });
    const { query, query_params } = lastQuery();
    expect(query).toContain("FROM token_usage");
    expect(query).toContain("cache_write_tokens   AS cache_write_5m");
    // `token_usage` has no thinking column, so a gateway frame's reasoning
    // is zero from the mapping rather than from a read.
    expect(query).not.toContain("thinking_tokens");
    expect(query_params).toEqual({ orgId: ORG, runId: RUN });
    expect(frames).toEqual([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "anthropic",
        inputUncached: 700,
        cacheRead: 200,
        cacheWrite5m: 100,
        cacheWrite1h: 0,
        output: 50,
        reasoning: 0,
        reportedCostMicros: "3000",
        basis: "gateway_observed",
      },
    ]);
  });
});

describe("readTachoToolCallFrames", () => {
  it("reads the hook source's tool calls and hides an empty name", async () => {
    answer([{ name: "Bash" }, { name: "" }]);
    const frames = await readTachoToolCallFrames({
      orgId: ORG,
      rootSessionUuid: RUN,
    });
    const { query, query_params } = lastQuery();
    expect(query).toContain("kind = 'tool_call'");
    expect(query).toContain("source = 'hook'");
    expect(query_params).toEqual({ orgId: ORG, rootSessionUuid: RUN });
    expect(frames).toEqual([{ name: "Bash" }, { name: null }]);
  });
});

describe("readTachoToolCallObservations", () => {
  const WS = "00000000-0000-4000-8000-000000000002";

  it("reads a workspace's hook tool calls newest first over the window and joins the span's result tokens", async () => {
    answer([
      {
        root_session_uuid: RUN,
        at: "2026-09-14T10:00:02.000Z",
        seq: "7",
        tool: "Bash",
        input_digest: "sha256:in",
        output_digest: "sha256:out",
        is_mutating: true,
        result_tokens: 4100,
      },
      {
        root_session_uuid: RUN,
        at: "2026-09-14T10:00:01.000Z",
        seq: "6",
        tool: "Read",
        input_digest: "sha256:in2",
        output_digest: "",
        is_mutating: null,
        result_tokens: null,
      },
    ]);
    const rows = await readTachoToolCallObservations({
      orgId: ORG,
      workspaceId: WS,
      from: new Date("2026-08-15T00:00:00.000Z"),
      to: new Date("2026-09-14T12:00:00.000Z"),
      limit: 200_000,
    });

    const { query, query_params } = lastQuery();
    expect(query_params).toEqual({
      orgId: ORG,
      workspaceId: WS,
      from: "2026-08-15 00:00:00.000",
      to: "2026-09-14 12:00:00.000",
      limit: 200_000,
    });
    expect(query).toContain("source = 'hook'");
    expect(query).toContain("source = 'otel_span'");
    expect(query).toContain("workspace_id = {workspaceId:UUID}");
    expect(query).toContain("ORDER BY ts DESC, seq DESC");
    expect(query).toContain("ON r.tool_use_id = h.tool_use_id");
    expect(rows).toEqual([
      {
        rootSessionUuid: RUN,
        at: "2026-09-14T10:00:02.000Z",
        seq: 7,
        tool: "Bash",
        inputDigest: "sha256:in",
        outputDigest: "sha256:out",
        isMutating: true,
        resultTokens: 4100,
      },
      {
        rootSessionUuid: RUN,
        at: "2026-09-14T10:00:01.000Z",
        seq: 6,
        tool: "Read",
        inputDigest: "sha256:in2",
        outputDigest: "",
        isMutating: null,
        resultTokens: null,
      },
    ]);
  });

  it("lets a degraded store throw", async () => {
    queryMock.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(
      readTachoToolCallObservations({
        orgId: ORG,
        workspaceId: WS,
        from: new Date(0),
        to: new Date(1),
        limit: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("readObservedModels", () => {
  const WS = "00000000-0000-4000-8000-000000000002";
  const SINCE = new Date("2026-08-15T00:00:00.000Z");

  it("folds both frame stores by model id, heaviest first, and caps the list", async () => {
    answer([
      {
        model: "vendor/brand-new",
        provider: "vendor",
        calls: "12",
        tokens: "480000",
        first_seen: "2026-09-02T09:00:00.000Z",
        last_seen: "2026-09-13T21:30:00.000Z",
      },
      {
        model: "claude-sonnet-5",
        provider: "",
        calls: "3",
        tokens: "1500",
        first_seen: "2026-09-10T00:00:00.000Z",
        last_seen: "2026-09-11T00:00:00.000Z",
      },
    ]);
    const rows = await readObservedModels({ orgId: ORG, since: SINCE });

    const { query, query_params } = lastQuery();
    expect(query).toContain("FROM token_usage");
    expect(query).toContain("FROM tacho_events FINAL");
    expect(query).toContain("UNION ALL");
    expect(query).toContain("kind = 'llm_call'");
    expect(query).toContain("source IN {sources:Array(String)}");
    // Each call is priced once: a session that reports a call through the
    // OTel log AND a collector or hook event holds two rows for it under
    // different `seq`s, which FINAL does not collapse, so a plain count over
    // the admitted sources would bill the call twice and rank the model
    // above ones that need pricing more. The host stamps the later sighting
    // and this read skips stamped rows, the same rule the per-run read uses.
    expect(query).toContain("attrs[{duplicateAttr:String}] = ''");
    // Retargeted from the per-turn source pick, for the reason the per-run
    // read states: the stamp is per call, so a call only the collector saw
    // after the OTel stream dropped counts here too, and an authority pick
    // would discard it and under-rank its model.
    expect(query).not.toContain("argMin(source");
    expect(query).not.toContain("turn_seq");
    expect(query).toContain("GROUP BY model");
    expect(query).toContain("ORDER BY tokens DESC, model");
    expect(query).toContain("LIMIT {limit:UInt32}");
    // A gateway row's input_tokens is the inclusive input total, so adding it
    // to cache reads and writes again would double-count them.
    expect(query).toContain(
      "greatest(0, toInt64(input_tokens) - toInt64(cached_tokens) - toInt64(cache_write_tokens))",
    );
    expect(query_params).toEqual({
      orgId: ORG,
      since: "2026-08-15 00:00:00.000",
      sources: ["otel_log", "collector", "hook", "transcript"],
      duplicateAttr: "oxagen.llm_call_duplicate_of",
      limit: 500,
    });

    expect(rows).toEqual([
      {
        model: "vendor/brand-new",
        provider: "vendor",
        calls: 12,
        tokens: 480_000,
        firstSeen: "2026-09-02T09:00:00.000Z",
        lastSeen: "2026-09-13T21:30:00.000Z",
      },
      {
        model: "claude-sonnet-5",
        provider: null,
        calls: 3,
        tokens: 1_500,
        firstSeen: "2026-09-10T00:00:00.000Z",
        lastSeen: "2026-09-11T00:00:00.000Z",
      },
    ]);
  });

  it("reads the whole organization when no workspace is named", async () => {
    answer([]);
    await readObservedModels({ orgId: ORG, since: SINCE });
    const { query, query_params } = lastQuery();
    expect(query).not.toContain("workspace_id");
    expect(query_params).not.toHaveProperty("workspaceId");
  });

  // `list_unpriced_models` judges the book as of `at`; a model first run after
  // `at` would otherwise be reported against a snapshot from before it ran.
  it("bounds both stores above by `until` when one is given, and leaves them open-ended otherwise", async () => {
    answer([]);
    const UNTIL = new Date("2026-09-10T00:00:00.000Z");
    await readObservedModels({ orgId: ORG, since: SINCE, until: UNTIL });
    const bounded = lastQuery();
    expect(bounded.query).toContain("created_at <= {until:DateTime64(3)}");
    // Once, in the tacho branch: `ts` is that store's timestamp column and
    // the gateway branch is bounded on `created_at` instead.
    expect(
      bounded.query.match(/ts <= \{until:DateTime64\(3\)\}/g),
    ).toHaveLength(1);
    expect(bounded.query_params).toMatchObject({
      until: "2026-09-10 00:00:00.000",
    });

    answer([]);
    await readObservedModels({ orgId: ORG, since: SINCE });
    const open = lastQuery();
    expect(open.query).not.toContain("{until");
    expect(open.query_params).not.toHaveProperty("until");
  });

  it("fences both stores on the workspace when one is named", async () => {
    answer([]);
    await readObservedModels({ orgId: ORG, workspaceId: WS, since: SINCE });
    const { query, query_params } = lastQuery();
    // Once per store: a fence on only one of them would leak the other's
    // rows into a workspace-scoped list.
    expect(query.match(/workspace_id = \{workspaceId:UUID\}/g)).toHaveLength(2);
    expect(query_params).toMatchObject({ workspaceId: WS });
  });

  // The per-run read joins the transcript's thinking figure back because the
  // output and reasoning classes are priced at different rates. This list
  // ranks rather than prices, and its sum leaves thinking out on purpose, so
  // the same join would change no total here and the duplicate filter is the
  // whole rule.
  it("ranks on the row it counts, without the per-run read's transcript join", async () => {
    answer([]);
    await readObservedModels({ orgId: ORG, since: SINCE });
    const { query } = lastQuery();
    expect(query).toContain("attrs[{duplicateAttr:String}] = ''");
    expect(query).not.toContain("LEFT JOIN");
    expect(query).not.toContain("call_key");
    expect(query).not.toContain("thinking_tokens");
  });

  it("lets a degraded store throw", async () => {
    queryMock.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(
      readObservedModels({ orgId: ORG, since: SINCE }),
    ).rejects.toThrow();
  });
});
