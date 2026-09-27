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
  OBSERVED_MODEL_READ_BOUND,
  OBSERVED_TOKEN_CLASSES,
  readModelCallFrames,
  readObservedModels,
  readTachoToolCallFrames,
  readTachoToolCallObservations,
} from "./cost-frames";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-0000000000aa";

/**
 * The thinking figure the wrapped read prices a frame with: the transcript
 * row joined back after the duplicate filter dropped it, on the request id
 * (`t`) or the message id (`m`), and the priced row's own column only when no
 * transcript row joins (`c`).
 */
const TRANSCRIPT = "greatest(coalesce(t.thinking, 0), coalesce(m.thinking, 0))";
const REASONING = `toInt64(if(${TRANSCRIPT} > 0, ${TRANSCRIPT}, coalesce(c.thinking_tokens, 0)))`;
const TRANSCRIPT_CACHE_1H =
  "greatest(coalesce(t.cache_1h, 0), coalesce(m.cache_1h, 0))";
const CACHE_WRITE = "toInt64(coalesce(c.cache_creation_tokens, 0))";
const CACHE_1H = `toInt64(least(${CACHE_WRITE}, if(${TRANSCRIPT_CACHE_1H} > 0, ${TRANSCRIPT_CACHE_1H}, coalesce(c.cache_creation_1h_tokens, 0))))`;
const CACHE_5M = `toInt64(greatest(0, ${CACHE_WRITE} - ${CACHE_1H}))`;

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

/** Each line of `sql` that bounds `received_at`, trimmed. */
function receivedBounds(sql: string): string[] {
  return (sql.match(/received_at[^\n]*/g) ?? []).map((line) => line.trim());
}

beforeEach(() => queryMock.mockReset());

describe("readModelCallFrames", () => {
  it("reads a wrapped run's token-bearing sources and splits cache writes by TTL", async () => {
    // OTel, collector and hook carry only the total `cache_creation_tokens`.
    // The 5m/1h split is a transcript column, joined back the same way as
    // thinking. With no transcript 1h figure the whole total prices as 5m.
    answer([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "firstParty",
        input_uncached: "1000",
        cache_read: "200",
        cache_write_5m: "300",
        cache_write_1h: "0",
        output: "50",
        reasoning: "0",
        server_tool_request: "0",
        cost_micros: "4125",
      },
      {
        at: "2026-09-14T10:00:01.000Z",
        model: "claude-sonnet-5",
        provider: "",
        input_uncached: "10",
        cache_read: "0",
        cache_write_5m: "0",
        cache_write_1h: "0",
        output: "5",
        reasoning: "0",
        server_tool_request: "0",
        cost_micros: null,
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [RUN] },
    });

    const { query, query_params } = lastQuery();
    expect(query).toContain("FROM tacho_events FINAL");
    expect(query).toContain("kind = 'llm_call'");
    expect(query).toContain(`${CACHE_5M} AS cache_write_5m`);
    expect(query).toContain(`${CACHE_1H} AS cache_write_1h`);
    expect(query).toContain("cache_creation_1h_tokens");
    expect(selectedColumns(query)).toEqual([
      "at",
      "model",
      "provider",
      "input_uncached",
      "cache_read",
      "cache_write_5m",
      "cache_write_1h",
      "output",
      "reasoning",
      "server_tool_request",
      "cost_micros",
    ]);
    expect(query_params).toEqual({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: RUN,
      sessionUuids: [RUN],
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
        serverToolRequests: 0,
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
        serverToolRequests: 0,
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
        cache_write_1h: "0",
        // The query has done the subtraction: a call that reported 900
        // output tokens of which 400 were thinking leaves 500 to price at
        // the output rate and 400 at the reasoning rate.
        output: "500",
        reasoning: "400",
        server_tool_request: "0",
        cost_micros: null,
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [RUN] },
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
      workspaceId: WS,
      run: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [RUN] },
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

    // Joined on the vendor request id and, separately, on the message id:
    // `llmCallKeys` in @oxagen/tacho matches two sightings on either, so a
    // proxy row carrying only the message id is stamped against a transcript
    // row carrying both. One key preferring the request id would give those
    // two rows different keys and drop the call's thinking figure.
    expect(query).toContain("request_id AS call_key");
    expect(query).toContain("ON t.call_key = c.request_id");
    expect(query).toContain("message_id AS call_key");
    expect(query).toContain("ON m.call_key = c.message_id");

    // One joined row per call at most, and none for a row carrying neither
    // id: a fan-out here would turn one call into several priced frames.
    expect(
      joined.match(/toInt64\(max\(coalesce\(thinking_tokens, 0\)\)\)/g),
    ).toHaveLength(2);
    expect(
      joined.match(
        /toInt64\(max\(coalesce\(cache_creation_1h_tokens, 0\)\)\)/g,
      ),
    ).toHaveLength(2);
    expect(joined.match(/GROUP BY call_key/g)).toHaveLength(2);
    expect(joined.match(/HAVING call_key != ''/g)).toHaveLength(2);

    // The transcript's figure wins, and a call no transcript row joins keeps
    // its own, which is how a collector-only call still reports reasoning.
    expect(query).toContain(REASONING);
    expect(query).toContain(CACHE_1H);
  });

  // The book prices one-hour cache writes at a premium over five-minute
  // writes. Left entirely in `cache_write_5m`, every 1h token is undercharged.
  it("takes the one-hour cache-write split from the duplicate transcript row", async () => {
    answer([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "firstParty",
        input_uncached: "1000",
        cache_read: "0",
        // Query already split: 2_000 total writes, 1_200 of them one-hour.
        cache_write_5m: "800",
        cache_write_1h: "1200",
        output: "50",
        reasoning: "0",
        server_tool_request: "0",
        cost_micros: null,
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [RUN] },
    });
    const { query } = lastQuery();
    expect(query).toContain(`${CACHE_5M} AS cache_write_5m`);
    expect(query).toContain(`${CACHE_1H} AS cache_write_1h`);
    // Cap at the priced row's total so a transcript over-report cannot invent
    // writes; the five-minute class is the remainder.
    expect(query).toContain(`least(${CACHE_WRITE}`);
    expect(frames[0]).toMatchObject({
      cacheWrite5m: 800,
      cacheWrite1h: 1200,
    });
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
        cache_write_1h: "0",
        // The OTel row the call is priced from reported 900 output tokens;
        // the transcript row the filter dropped reported 400 of thinking.
        output: "500",
        reasoning: "400",
        server_tool_request: "0",
        cost_micros: "4125",
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [RUN] },
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
        serverToolRequests: 0,
        reportedCostMicros: "4125",
        basis: "client_attested",
      },
    ]);
  });

  // #3721. A wrapped call's web searches are billed per request, and the
  // rollup priced none of them: the read never selected the column, so a run
  // that searched came back cheaper than its invoice. Fetches carry no
  // per-request charge and stay out.
  it("carries a wrapped call's web searches, and not its fetches, as server tool requests", async () => {
    answer([
      {
        at: "2026-09-14T10:00:00.000Z",
        model: "claude-sonnet-5",
        provider: "firstParty",
        input_uncached: "1000",
        cache_read: "0",
        cache_write_5m: "0",
        cache_write_1h: "0",
        output: "200",
        reasoning: "0",
        server_tool_request: "3",
        cost_micros: null,
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [RUN] },
    });
    const { query } = lastQuery();
    expect(query).toContain(
      "toInt64(greatest(coalesce(c.web_search_requests, 0), greatest(coalesce(t.searches, 0), coalesce(m.searches, 0)))) AS server_tool_request",
    );
    // An OTel or proxy sighting priced as the call carries no search count,
    // so both transcript joins bring the transcript row's count back.
    expect(
      query.match(
        /toInt64\(max\(coalesce\(web_search_requests, 0\)\)\) AS searches/g,
      ),
    ).toHaveLength(2);
    // The priced row selects the search column so the outer read can use it.
    // Up to the first join: `) AS c` alone first matches `) AS cache_write_5m`
    // in the outer select list.
    const priced = query.slice(query.indexOf("FROM ("), query.indexOf("LEFT JOIN"));
    expect(priced).toContain("web_search_requests");
    expect(query).not.toContain("web_fetch_requests");
    expect(frames[0]).toMatchObject({ serverToolRequests: 3 });
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
      workspaceId: WS,
      run: { kind: "ledger", runUuid: RUN },
    });
    const { query, query_params } = lastQuery();
    expect(query).toContain("FROM metered_token_usage");
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
        serverToolRequests: 0,
        reportedCostMicros: "3000",
        basis: "gateway_observed",
      },
    ]);
  });

  it("reads an assistant run's rows on the message that asked for it too (#4167)", async () => {
    // The in-app assistant meters every call of a turn on the person's
    // message id, so a read on the run's own uuid alone found none of them.
    const MESSAGE = "00000000-0000-4000-8000-0000000000bb";
    answer([
      {
        at: "2026-09-25T10:00:00.000Z",
        model: "anthropic/claude-sonnet-4.5",
        provider: "anthropic",
        input_uncached: "1200",
        cache_read: "0",
        cache_write_5m: "0",
        output: "300",
        cost_micros: "8100",
      },
    ]);
    const frames = await readModelCallFrames({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "ledger", runUuid: RUN, originMessageId: MESSAGE },
    });
    const { query, query_params } = lastQuery();
    expect(query).toContain(
      "execution_step_id IN ({runId:UUID}, {originMessageId:UUID})",
    );
    expect(query_params).toEqual({
      orgId: ORG,
      runId: RUN,
      originMessageId: MESSAGE,
    });
    expect(frames).toEqual([
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4.5",
        inputUncached: 1200,
        output: 300,
        basis: "gateway_observed",
      }),
    ]);
  });

  it("reads a ledger run with no origin message on its own uuid alone", async () => {
    answer([]);
    await readModelCallFrames({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "ledger", runUuid: RUN, originMessageId: null },
    });
    const { query, query_params } = lastQuery();
    expect(query).toContain("execution_step_id = {runId:UUID}");
    expect(query).not.toContain("originMessageId");
    expect(query_params).toEqual({ orgId: ORG, runId: RUN });
  });
});

describe("readTachoToolCallFrames", () => {
  /** A hook row as ClickHouse answers it, every column recorded. */
  const hookRow = (over: Record<string, unknown> = {}) => ({
    name: "Read",
    status: "ok",
    input_digest: "sha256:in",
    output_digest: "sha256:out",
    is_mutating: false,
    result_tokens: "812",
    ...over,
  });

  it("reads the hook source's tool calls with what the rollup grades them by", async () => {
    answer([hookRow(), hookRow({ name: "Bash", is_mutating: true })]);
    const frames = await readTachoToolCallFrames({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: RUN,
      sessionUuids: [RUN],
    });
    const { query, query_params } = lastQuery();
    expect(query).toContain("kind = 'tool_call'");
    expect(query).toContain("source = 'hook'");
    expect(query_params).toEqual({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: RUN,
      sessionUuids: [RUN],
    });
    expect(selectedColumns(query)).toEqual([
      "name",
      "status",
      "input_digest",
      "output_digest",
      "is_mutating",
      "result_tokens",
    ]);
    expect(frames).toEqual([
      {
        name: "Read",
        status: "ok",
        inputDigest: "sha256:in",
        outputDigest: "sha256:out",
        isMutating: false,
        resultTokens: 812,
      },
      {
        name: "Bash",
        status: "ok",
        inputDigest: "sha256:in",
        outputDigest: "sha256:out",
        isMutating: true,
        resultTokens: 812,
      },
    ]);
  });

  it("joins the OTel span's result tokens on the tool use, in the run's own tree, with a missing span read as null", async () => {
    answer([hookRow({ result_tokens: null })]);
    const [frame] = await readTachoToolCallFrames({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: RUN,
      sessionUuids: [RUN],
    });
    const { query } = lastQuery();
    expect(query).toContain("source = 'otel_span'");
    expect(query).toContain("ON r.tool_use_id = h.tool_use_id");
    // Without it an unmatched span answers 0, which would price the call's
    // result at nothing instead of leaving it unrecorded.
    expect(query).toContain("SETTINGS join_use_nulls = 1");
    // Both sides are bounded to the run's tree and its sessions, so a span of
    // another run with the same tool use id cannot join.
    expect(
      query.match(/root_session_uuid = \{rootSessionUuid:UUID\}/g),
    ).toHaveLength(2);
    expect(
      query.match(/session_uuid IN \{sessionUuids:Array\(UUID\)\}/g),
    ).toHaveLength(2);
    expect(query).toContain("ORDER BY h.ts, h.seq");
    expect(frame?.resultTokens).toBeNull();
  });

  it("reads an empty name, empty digests and an ungraded status as null", async () => {
    answer([
      hookRow({
        name: "",
        status: "",
        input_digest: "",
        output_digest: "",
        is_mutating: null,
      }),
      hookRow({ status: "cancelled" }),
      hookRow({ status: "error" }),
      hookRow({ status: "rejected" }),
    ]);
    const frames = await readTachoToolCallFrames({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: RUN,
      sessionUuids: [RUN],
    });
    expect(frames[0]).toEqual({
      name: null,
      status: null,
      inputDigest: null,
      outputDigest: null,
      isMutating: null,
      resultTokens: 812,
    });
    // A cancelled call did not fail: it is left ungraded rather than counted.
    expect(frames.map((f) => f.status)).toEqual([
      null,
      null,
      "error",
      "rejected",
    ]);
  });
});

describe("readTachoToolCallObservations", () => {
  const WS = "00000000-0000-4000-8000-000000000002";
  const SUBAGENT = "00000000-0000-4000-8000-0000000000bb";

  it("reads a workspace's hook tool calls newest first over the window and joins the span's result tokens", async () => {
    answer([
      {
        root_session_uuid: RUN,
        session_uuid: RUN,
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
        session_uuid: SUBAGENT,
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
    // The chain a call was recorded on, which its seq counts on (#4001).
    expect(selectedColumns(query)).toContain("session_uuid");
    expect(query).toContain("toString(h.session_uuid)");
    // The table partitions by the month of received_at (#4297). Each read
    // bounds it below, a day before the window for a host clock that runs
    // ahead, so it reads the months around the window, not every month.
    expect(receivedBounds(query)).toEqual([
      "received_at >= {from:DateTime64(3)} - INTERVAL 1 DAY",
      "received_at >= {from:DateTime64(3)} - INTERVAL 1 DAY",
    ]);
    expect(rows).toEqual([
      {
        rootSessionUuid: RUN,
        sessionUuid: RUN,
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
        sessionUuid: SUBAGENT,
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

  /** Answers the summary query, then the class-bucket query. */
  function answerBoth(summary: unknown[], classes: unknown[] = []): void {
    answer(summary);
    answer(classes);
  }

  /** One summary row per model, heaviest first. */
  function summaryOf(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      model: `model-${index}`,
      provider: "vendor",
      calls: "1",
      tokens: String(count - index),
      first_seen: "2026-09-02T09:00:00.000Z",
      last_seen: "2026-09-02T09:00:00.000Z",
    }));
  }

  // #4069: the usage breakdown prices its cache saving from this read, and
  // its token totals come from token_usage alone. A wrapped agent's calls
  // must not enter a figure printed beside totals that leave them out.
  it("reads token_usage alone when asked for the gateway store", async () => {
    answerBoth(summaryOf(1));
    await readObservedModels({
      orgId: ORG,
      since: SINCE,
      frameStores: "gateway",
    });
    const [summary, classes] = queryMock.mock.calls.map((c) => c[0].query);
    for (const sql of [summary!, classes!]) {
      expect(sql).toContain("FROM metered_token_usage");
      expect(sql).not.toContain("tacho_events");
      expect(sql).not.toContain("UNION ALL");
    }
    expect(classes).toContain("FROM gw");
    expect(classes).not.toMatch(/\btc\b/);
  });

  it("folds both frame stores by default", async () => {
    answerBoth(summaryOf(1));
    await readObservedModels({ orgId: ORG, since: SINCE });
    const [summary, classes] = queryMock.mock.calls.map((c) => c[0].query);
    for (const sql of [summary!, classes!]) {
      expect(sql).toContain("FROM metered_token_usage");
      expect(sql).toContain("FROM tacho_events FINAL");
      expect(sql).toContain("UNION ALL");
    }
    expect(classes).toContain("FROM tc");
    // Every read of tacho_events bounds received_at below as well as ts
    // (#4297): the summary once, the class read and its two joins once each.
    const since = "received_at >= {since:DateTime64(3)} - INTERVAL 1 DAY";
    expect(receivedBounds(summary!)).toEqual([since]);
    expect(receivedBounds(classes!)).toEqual([since, since, since]);
    for (const sql of [summary!, classes!])
      expect(sql.match(/FROM tacho_events FINAL/g)).toHaveLength(
        receivedBounds(sql).length,
      );
  });

  it("keeps low-volume models beyond 5000 for the price comparison", async () => {
    // #3629: a bound at 5000 let a low-volume unpriced model be outranked by
    // priced ones and never reach the comparison. The bound that replaced
    // the unbounded read sits well above that and above billing's 500 cap.
    answerBoth(summaryOf(5001));
    const rows = await readObservedModels({ orgId: ORG, since: SINCE });
    expect(rows).toHaveLength(5001);
    expect(rows.at(-1)?.model).toBe("model-5000");
    expect(OBSERVED_MODEL_READ_BOUND).toBeGreaterThan(5000);
    expect(queryMock.mock.calls[1]![0].query_params.models).toContain(
      "model-5000",
    );
  });

  it("bounds the summary read in SQL and says so when the bound is filled", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      answerBoth(summaryOf(OBSERVED_MODEL_READ_BOUND));
      await readObservedModels({ orgId: ORG, since: SINCE, workspaceId: WS });
      const summary = queryMock.mock.calls[0]![0];
      expect(summary.query).toMatch(/LIMIT \{limit:UInt32\}/);
      expect(summary.query_params.limit).toBe(OBSERVED_MODEL_READ_BOUND);
      const lines = stderr.mock.calls.map((call) => String(call[0]));
      const note = lines.find((line) =>
        line.includes("observed_model_read_bound"),
      );
      expect(note).toBeDefined();
      expect(JSON.parse(note!)).toMatchObject({
        level: "warn",
        alert: "observed_model_read_bound",
        bound: OBSERVED_MODEL_READ_BOUND,
        orgId: ORG,
        workspaceId: WS,
      });
    } finally {
      stderr.mockRestore();
    }
  });

  // #3281. The ranked read stops at OBSERVED_MODEL_READ_BOUND models by token
  // volume, so a low-volume unpriced model past it was never compared. A
  // caller that must see every model walks keyset pages in model-id order.
  it("reads one keyset page in model-id order when asked for a page", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      answerBoth(summaryOf(3));
      await readObservedModels({
        orgId: ORG,
        since: SINCE,
        page: { afterModel: "model-a", size: 3 },
      });
      const [summary, classes] = queryMock.mock.calls.map((c) => c[0]);
      expect(summary!.query).toContain("ORDER BY model\n");
      expect(summary!.query).not.toContain("ORDER BY tokens DESC");
      // The cursor filters both frame stores before they are folded.
      expect(
        summary!.query.match(/AND toString\(model\) > \{afterModel:String\}/g),
      ).toHaveLength(2);
      expect(summary!.query_params).toMatchObject({
        afterModel: "model-a",
        limit: 3,
      });
      expect(
        (classes!.query_params.models as string[]).length,
      ).toBeLessThanOrEqual(3);
      // A full page is how the caller knows to ask for the next one, not a
      // bound the read filled.
      expect(
        stderr.mock.calls.some((call) =>
          String(call[0]).includes("observed_model_read_bound"),
        ),
      ).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });

  it("reads the first page with no cursor", async () => {
    answerBoth(summaryOf(1));
    await readObservedModels({ orgId: ORG, since: SINCE, page: { size: 5 } });
    const summary = queryMock.mock.calls[0]![0];
    expect(summary.query).not.toContain("{afterModel:String}");
    expect(summary.query_params).not.toHaveProperty("afterModel");
    expect(summary.query_params.limit).toBe(5);
  });

  it("refuses a page size that is not a positive integer", async () => {
    await expect(
      readObservedModels({ orgId: ORG, since: SINCE, page: { size: 0 } }),
    ).rejects.toThrow(RangeError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("says nothing about the bound when the read sits under it", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      answerBoth(summaryOf(3));
      await readObservedModels({ orgId: ORG, since: SINCE });
      expect(
        stderr.mock.calls.some((call) =>
          String(call[0]).includes("observed_model_read_bound"),
        ),
      ).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });

  it("folds both frame stores by model id, heaviest first, and reads a per-class breakdown for what it found", async () => {
    answerBoth(
      [
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
      ],
      [
        {
          model: "vendor/brand-new",
          class: "input_uncached",
          bucket_index: "0",
          calls: "10",
          tokens: "400000",
          first_seen: "2026-09-02T09:00:00.000Z",
          last_seen: "2026-09-13T21:30:00.000Z",
        },
        {
          model: "claude-sonnet-5",
          class: "reasoning",
          bucket_index: "0",
          calls: "1",
          tokens: "200",
          first_seen: "2026-09-10T00:00:00.000Z",
          last_seen: "2026-09-10T00:00:00.000Z",
        },
      ],
    );
    const rows = await readObservedModels({ orgId: ORG, since: SINCE });

    expect(queryMock).toHaveBeenCalledTimes(2);
    const summaryCall = queryMock.mock.calls[0]![0];
    const classCall = queryMock.mock.calls[1]![0];

    expect(summaryCall.query).toContain("FROM metered_token_usage");
    expect(summaryCall.query).toContain("FROM tacho_events FINAL");
    expect(summaryCall.query).toContain("UNION ALL");
    expect(summaryCall.query).toContain("kind = 'llm_call'");
    expect(summaryCall.query).toContain("source IN {sources:Array(String)}");
    // Each call is priced once: a session that reports a call through the
    // OTel log AND a collector or hook event holds two rows for it under
    // different `seq`s, which FINAL does not collapse, so a plain count over
    // the admitted sources would bill the call twice and rank the model
    // above ones that need pricing more. The host stamps the later sighting
    // and this read skips stamped rows, the same rule the per-run read uses.
    expect(summaryCall.query).toContain("attrs[{duplicateAttr:String}] = ''");
    // Retargeted from the per-turn source pick, for the reason the per-run
    // read states: the stamp is per call, so a call only the collector saw
    // after the OTel stream dropped counts here too, and an authority pick
    // would discard it and under-rank its model.
    expect(summaryCall.query).not.toContain("argMin(source");
    expect(summaryCall.query).not.toContain("turn_seq");
    expect(summaryCall.query).toContain("GROUP BY model");
    expect(summaryCall.query).toContain("ORDER BY tokens DESC, model");
    // Bounded, and the bound is a parameter rather than a literal, so the
    // test above can read what was asked for.
    expect(summaryCall.query).toMatch(/LIMIT \{limit:UInt32\}\s*$/);
    // A gateway row's input_tokens is the inclusive input total, so adding it
    // to cache reads and writes again would double-count them.
    expect(summaryCall.query).toContain(
      "greatest(0, toInt64(input_tokens) - toInt64(cached_tokens) - toInt64(cache_write_tokens))",
    );
    expect(summaryCall.query_params).toEqual({
      orgId: ORG,
      since: "2026-08-15 00:00:00.000",
      sources: ["otel_log", "collector", "hook", "transcript"],
      duplicateAttr: "oxagen.llm_call_duplicate_of",
      limit: OBSERVED_MODEL_READ_BOUND,
    });

    // The class-bucket read is scoped to exactly the models the summary
    // named, so a store holding boundaries or rows for unrelated models
    // never widens it.
    expect(classCall.query).toContain("model IN {models:Array(String)}");
    expect(classCall.query_params).toMatchObject({
      models: ["vendor/brand-new", "claude-sonnet-5"],
      boundaries: [],
    });
    expect(classCall.query).toContain("ARRAY JOIN");
    // The array is an array of (class, tokens) tuples under ONE alias, read
    // with `tupleElement`. `AS (class, tok)` is not ClickHouse alias syntax —
    // an ARRAY JOIN expression takes a single identifier — and the server
    // refused the whole query, so every nonempty report failed.
    expect(classCall.query).toContain("] AS class_token");
    expect(classCall.query).not.toMatch(/AS\s*\(\s*class\s*,/);
    expect(classCall.query).toContain("tupleElement(class_token, 1)");
    expect(classCall.query).toContain("WHERE tupleElement(class_token, 2) > 0");
    expect(classCall.query).toContain("GROUP BY model, class, bucket_index");
    // Reasoning IS split out here, unlike the ranking total above: the
    // per-run read's transcript join is needed to attribute it correctly.
    expect(classCall.query).toContain("thinking_tokens");
    expect(classCall.query).toContain("LEFT JOIN");

    expect(rows).toEqual([
      {
        model: "vendor/brand-new",
        provider: "vendor",
        calls: 12,
        tokens: 480_000,
        firstSeen: "2026-09-02T09:00:00.000Z",
        lastSeen: "2026-09-13T21:30:00.000Z",
        classes: [
          {
            tokenClass: "input_uncached",
            calls: 10,
            tokens: 400_000,
            firstSeen: "2026-09-02T09:00:00.000Z",
            lastSeen: "2026-09-13T21:30:00.000Z",
          },
        ],
      },
      {
        model: "claude-sonnet-5",
        provider: null,
        calls: 3,
        tokens: 1_500,
        firstSeen: "2026-09-10T00:00:00.000Z",
        lastSeen: "2026-09-11T00:00:00.000Z",
        classes: [
          {
            tokenClass: "reasoning",
            calls: 1,
            tokens: 200,
            firstSeen: "2026-09-10T00:00:00.000Z",
            lastSeen: "2026-09-10T00:00:00.000Z",
          },
        ],
      },
    ]);
  });

  it("keys the transcript-split joins on the session family so a subagent call's root and child sightings meet", async () => {
    answerBoth([
      {
        model: "claude-sonnet-5",
        provider: "",
        calls: "1",
        tokens: "10",
        first_seen: "2026-09-10T00:00:00.000Z",
        last_seen: "2026-09-10T00:00:00.000Z",
      },
    ]);
    await readObservedModels({ orgId: ORG, since: SINCE });
    const classCall = queryMock.mock.calls[1]![0];

    // One ledger serves a session and its subagents (ADR-168). When the
    // proxy saw a subagent's call first, the priced row sits on the root
    // chain and the transcript row on the child chain. A session_uuid key
    // missed that pair and dropped the call's thinking, one-hour cache
    // split, and searches. The family key joins them and still keeps one
    // run's ids apart from another run's.
    expect(classCall.query).toContain(
      "GROUP BY call_key, workspace_id, root_session_uuid",
    );
    expect(classCall.query).toContain(
      "t.call_key = c.request_id AND t.workspace_id = c.workspace_id AND t.root_session_uuid = c.root_session_uuid",
    );
    expect(classCall.query).toContain(
      "m.call_key = c.message_id AND m.workspace_id = c.workspace_id AND m.root_session_uuid = c.root_session_uuid",
    );
    expect(classCall.query).not.toContain("session_uuid = c.session_uuid");
  });

  it("fences a workspace-scoped read's transcript joins to that workspace", async () => {
    answerBoth([
      {
        model: "claude-sonnet-5",
        provider: "",
        calls: "1",
        tokens: "10",
        first_seen: "2026-09-10T00:00:00.000Z",
        last_seen: "2026-09-10T00:00:00.000Z",
      },
    ]);
    await readObservedModels({ orgId: ORG, workspaceId: WS, since: SINCE });
    const classCall = queryMock.mock.calls[1]![0];
    // A host in another workspace can name the same root, so each transcript
    // subquery carries the workspace predicate the priced rows carry.
    const joins = classCall.query.split("LEFT JOIN (").slice(1);
    expect(joins).toHaveLength(2);
    for (const join of joins) {
      expect(join).toContain("AND workspace_id = {workspaceId:UUID}");
    }
    expect(classCall.query_params.workspaceId).toBe(WS);
  });

  // #3281. The unpriced-model report compares the class-bucket read against
  // the book, so it must count each wrapped call once, by the same stamp the
  // frame read and the summary read drop. The transcript joins are the one
  // place the stamped row is wanted, and they add no call.
  it("drops stamped duplicate rows from the class-bucket read's priced rows", async () => {
    answerBoth([
      {
        model: "claude-sonnet-5",
        provider: "",
        calls: "1",
        tokens: "10",
        first_seen: "2026-09-10T00:00:00.000Z",
        last_seen: "2026-09-10T00:00:00.000Z",
      },
    ]);
    await readObservedModels({ orgId: ORG, since: SINCE });
    const classCall = queryMock.mock.calls[1]![0];
    const tc = classCall.query.slice(classCall.query.indexOf("tc AS ("));
    const priced = tc.slice(0, tc.indexOf("LEFT JOIN"));
    expect(priced).toContain("attrs[{duplicateAttr:String}] = ''");
    expect(
      classCall.query.match(/attrs\[\{duplicateAttr:String\}\] = ''/g),
    ).toHaveLength(1);
    expect(classCall.query_params).toMatchObject({
      duplicateAttr: "oxagen.llm_call_duplicate_of",
    });
  });

  it("counts a wrapped call's provider-side web searches as server_tool_request usage", async () => {
    // #3281. `tacho_events` records the web searches a model made
    // (`web_search_requests`) and the book prices them as
    // `server_tool_request` at one rate per request. The class-bucket read
    // used to report six token classes and nothing else, so this usage was
    // observed by the recorder, stored in ClickHouse, and then dropped on the
    // floor: a model whose search rate nobody had stated was never named by
    // `list_unpriced_models`, and the one missing rate that made its runs
    // incomplete was the one the report stayed silent about.
    expect(OBSERVED_TOKEN_CLASSES).toContain("server_tool_request");

    answerBoth(
      [
        {
          model: "claude-sonnet-5",
          provider: "anthropic",
          calls: "1",
          tokens: "1200",
          first_seen: "2026-09-10T00:00:00.000Z",
          last_seen: "2026-09-10T00:00:00.000Z",
        },
      ],
      [
        {
          model: "claude-sonnet-5",
          class: "server_tool_request",
          bucket_index: "0",
          calls: "1",
          tokens: "3",
          first_seen: "2026-09-10T00:00:00.000Z",
          last_seen: "2026-09-10T00:00:00.000Z",
        },
      ],
    );
    const rows = await readObservedModels({ orgId: ORG, since: SINCE });
    const classCall = queryMock.mock.calls[1]![0];

    // Searches only. Anthropic bills a web search per request and does not
    // bill a web fetch per request, so a fetch counted here would report a
    // model whose calls only fetched as missing a request rate, and a model
    // priced for every class it used must not be reported.
    expect(classCall.query).toMatch(
      /toInt64\(greatest\(coalesce\(c\.web_search_requests, 0\), greatest\(coalesce\(t\.searches, 0\), coalesce\(m\.searches, 0\)\)\)\)\s+AS server_tool_request/,
    );
    expect(classCall.query).not.toContain("web_fetch_requests");
    expect(classCall.query).toContain(
      "('server_tool_request', server_tool_request)",
    );
    // The gateway store has no such column, so its half of the union
    // contributes zero rather than leaving the two halves mismatched.
    expect(classCall.query).toMatch(/toInt64\(0\)\s+AS server_tool_request/);
    expect(classCall.query).toContain("server_tool_request, ts FROM gw");
    expect(classCall.query).toContain("server_tool_request, ts FROM tc");

    // Requests are not tokens: they reach the caller as a class of their own
    // and never inflate the ranking total the summary read produces.
    expect(rows[0]?.tokens).toBe(1200);
    expect(rows[0]?.classes).toEqual([
      {
        tokenClass: "server_tool_request",
        calls: 1,
        tokens: 3,
        firstSeen: "2026-09-10T00:00:00.000Z",
        lastSeen: "2026-09-10T00:00:00.000Z",
      },
    ]);
  });

  it("skips the class-bucket read entirely when nothing was observed", async () => {
    answer([]);
    const rows = await readObservedModels({ orgId: ORG, since: SINCE });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([]);
  });

  it("passes the given price-boundary buckets through to the class read, empty by default", async () => {
    answerBoth([
      {
        model: "m",
        provider: "",
        calls: "1",
        tokens: "10",
        first_seen: "2026-09-10T00:00:00.000Z",
        last_seen: "2026-09-10T00:00:00.000Z",
      },
    ]);
    const b1 = new Date("2026-09-01T00:00:00.000Z");
    const b2 = new Date("2026-09-12T00:00:00.000Z");
    await readObservedModels({
      orgId: ORG,
      since: SINCE,
      boundaries: [b1, b2],
    });
    const classCall = queryMock.mock.calls[1]![0];
    expect(classCall.query).toContain("arrayCount(b -> b <=");
    expect(classCall.query_params).toMatchObject({
      boundaries: ["2026-09-01 00:00:00.000", "2026-09-12 00:00:00.000"],
    });
  });

  // The boundary array is scanned once per frame, so a caller that hands in
  // a whole price catalog's history pays for every model's rate changes on
  // every frame and splits the report into buckets that answer identically.
  // `boundariesFor` lets the caller narrow it to the models actually run.
  it("offers the observed model list to `boundariesFor` and buckets on what it returns", async () => {
    answerBoth([
      {
        model: "vendor/brand-new",
        provider: "vendor",
        calls: "1",
        tokens: "10",
        first_seen: "2026-09-10T00:00:00.000Z",
        last_seen: "2026-09-10T00:00:00.000Z",
      },
      {
        model: "claude-sonnet-5",
        provider: "",
        calls: "1",
        tokens: "5",
        first_seen: "2026-09-10T00:00:00.000Z",
        last_seen: "2026-09-10T00:00:00.000Z",
      },
    ]);
    const seen: string[][] = [];
    await readObservedModels({
      orgId: ORG,
      since: SINCE,
      // The unrelated boundary here must lose to the callback's answer.
      boundaries: [new Date("2026-01-01T00:00:00.000Z")],
      boundariesFor: (models) => {
        seen.push([...models]);
        return [new Date("2026-09-05T00:00:00.000Z")];
      },
    });

    expect(seen).toEqual([["vendor/brand-new", "claude-sonnet-5"]]);
    expect(queryMock.mock.calls[1]![0].query_params).toMatchObject({
      boundaries: ["2026-09-05 00:00:00.000"],
    });
  });

  // No models, no class read at all, so nothing asks for boundaries either:
  // the price book is never scanned for an organization that ran nothing.
  it("does not ask for boundaries when the summary found nothing", async () => {
    answer([]);
    const boundariesFor = vi.fn(() => []);
    const rows = await readObservedModels({
      orgId: ORG,
      since: SINCE,
      boundariesFor,
    });
    expect(rows).toEqual([]);
    expect(boundariesFor).not.toHaveBeenCalled();
  });

  it("reads the whole organization when no workspace is named", async () => {
    answerBoth([
      {
        model: "m",
        provider: "",
        calls: "1",
        tokens: "1",
        first_seen: SINCE.toISOString(),
        last_seen: SINCE.toISOString(),
      },
    ]);
    await readObservedModels({ orgId: ORG, since: SINCE });
    const summaryCall = queryMock.mock.calls[0]![0];
    const classCall = queryMock.mock.calls[1]![0];
    expect(summaryCall.query).not.toContain("workspace_id");
    expect(summaryCall.query_params).not.toHaveProperty("workspaceId");
    expect(classCall.query_params).not.toHaveProperty("workspaceId");
  });

  // `list_unpriced_models` judges the book as of `at`; a model first run after
  // `at` would otherwise be reported against a snapshot from before it ran.
  it("bounds both stores above by `until` when one is given, and leaves them open-ended otherwise", async () => {
    answerBoth([
      {
        model: "m",
        provider: "",
        calls: "1",
        tokens: "1",
        first_seen: SINCE.toISOString(),
        last_seen: SINCE.toISOString(),
      },
    ]);
    const UNTIL = new Date("2026-09-10T00:00:00.000Z");
    await readObservedModels({ orgId: ORG, since: SINCE, until: UNTIL });
    const summaryCall = queryMock.mock.calls[0]![0];
    const classCall = queryMock.mock.calls[1]![0];
    expect(summaryCall.query).toContain("created_at <= {until:DateTime64(3)}");
    // Once, in the tacho branch: `ts` is that store's timestamp column and
    // the gateway branch is bounded on `created_at` instead.
    expect(
      summaryCall.query.match(/ts <= \{until:DateTime64\(3\)\}/g),
    ).toHaveLength(1);
    expect(summaryCall.query_params).toMatchObject({
      until: "2026-09-10 00:00:00.000",
    });
    // The class-bucket read bounds both its own halves the same way.
    expect(classCall.query).toContain("created_at <= {until:DateTime64(3)}");
    expect(
      classCall.query.match(/ts <= \{until:DateTime64\(3\)\}/g)!.length,
    ).toBeGreaterThanOrEqual(1);

    answer([]);
    await readObservedModels({ orgId: ORG, since: SINCE });
    const open = lastQuery();
    expect(open.query).not.toContain("{until");
    expect(open.query_params).not.toHaveProperty("until");
  });

  it("fences both stores on the workspace when one is named", async () => {
    answerBoth([
      {
        model: "m",
        provider: "",
        calls: "1",
        tokens: "1",
        first_seen: SINCE.toISOString(),
        last_seen: SINCE.toISOString(),
      },
    ]);
    await readObservedModels({ orgId: ORG, workspaceId: WS, since: SINCE });
    const summaryCall = queryMock.mock.calls[0]![0];
    const classCall = queryMock.mock.calls[1]![0];
    // Once per store: a fence on only one of them would leak the other's
    // rows into a workspace-scoped list.
    expect(
      summaryCall.query.match(/workspace_id = \{workspaceId:UUID\}/g),
    ).toHaveLength(2);
    expect(summaryCall.query_params).toMatchObject({ workspaceId: WS });
    expect(classCall.query_params).toMatchObject({ workspaceId: WS });
  });

  // The summary ranking total leaves thinking inside `output` on purpose
  // (see the module docblock), so its own query carries no transcript join.
  it("ranks on the row it counts, without a transcript join in the summary query", async () => {
    answer([]);
    await readObservedModels({ orgId: ORG, since: SINCE });
    const { query } = lastQuery();
    expect(query).toContain("attrs[{duplicateAttr:String}] = ''");
    expect(query).not.toContain("LEFT JOIN");
    expect(query).not.toContain("call_key");
    expect(query).not.toContain("thinking_tokens");
  });

  it("lets a degraded store throw on the summary read", async () => {
    queryMock.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(
      readObservedModels({ orgId: ORG, since: SINCE }),
    ).rejects.toThrow();
  });

  it("lets a degraded store throw on the class-bucket read", async () => {
    answer([
      {
        model: "m",
        provider: "",
        calls: "1",
        tokens: "1",
        first_seen: SINCE.toISOString(),
        last_seen: SINCE.toISOString(),
      },
    ]);
    queryMock.mockRejectedValueOnce(new Error("clickhouse down"));
    await expect(
      readObservedModels({ orgId: ORG, since: SINCE }),
    ).rejects.toThrow();
  });
});
