// cost-frames-audit-fix.test.ts — a wrapped run's frames are read in the
// run's own workspace. The producer names `root_session_uuid`, so a host in
// another workspace of the organization could stamp its frames with this
// run's root and have them priced into it.
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

import { readModelCallFrames, readTachoToolCallFrames } from "./cost-frames";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-0000000000aa";

function lastQuery(): QueryCall {
  return queryMock.mock.calls.at(-1)![0];
}

/** Each `FROM tacho_events` read in the statement, cut at the next read. */
function reads(sql: string): string[] {
  return sql.split("FROM tacho_events FINAL").slice(1);
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ json: async () => [] });
});

describe("readModelCallFrames", () => {
  it("reads a wrapped run's calls, and the transcript rows joined to them, in the run's workspace", async () => {
    await readModelCallFrames({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "tacho", rootSessionUuid: RUN },
    });
    const { query, query_params } = lastQuery();
    // The priced rows and both transcript joins: a joined row from another
    // workspace would move tokens between this run's classes.
    const each = reads(query);
    expect(each).toHaveLength(3);
    for (const read of each) {
      expect(read).toMatch(
        /WHERE org_id = \{orgId:UUID\}\s+AND workspace_id = \{workspaceId:UUID\}\s+AND root_session_uuid = \{rootSessionUuid:UUID\}/,
      );
    }
    expect(query_params).toMatchObject({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: RUN,
    });
  });
});

describe("readTachoToolCallFrames", () => {
  it("reads a wrapped run's tool calls in the run's workspace", async () => {
    await readTachoToolCallFrames({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: RUN,
    });
    const { query, query_params } = lastQuery();
    expect(query).toMatch(
      /WHERE org_id = \{orgId:UUID\}\s+AND workspace_id = \{workspaceId:UUID\}\s+AND root_session_uuid = \{rootSessionUuid:UUID\}/,
    );
    expect(query_params).toEqual({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: RUN,
    });
  });
});
