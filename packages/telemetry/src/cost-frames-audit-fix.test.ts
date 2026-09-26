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
const CHILD = "00000000-0000-4000-8000-0000000000ab";

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
      run: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [RUN] },
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

  // #4103. `tacho_events` sorts by (org_id, workspace_id, session_uuid, seq)
  // and has no index on root_session_uuid, so a read that names the root
  // alone scans every chain the workspace holds. Each read now names the
  // run's own sessions, and still keeps the workspace and root predicates.
  it("reads only the run's own sessions, root first, in all three reads", async () => {
    await readModelCallFrames({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [RUN, CHILD] },
    });
    const { query, query_params } = lastQuery();
    const each = reads(query);
    expect(each).toHaveLength(3);
    for (const read of each) {
      expect(read).toMatch(
        /WHERE org_id = \{orgId:UUID\}\s+AND workspace_id = \{workspaceId:UUID\}\s+AND root_session_uuid = \{rootSessionUuid:UUID\}\s+AND session_uuid IN \{sessionUuids:Array\(UUID\)\}/,
      );
    }
    expect(query_params.sessionUuids).toEqual([RUN, CHILD]);
    // A parent and its subagent can reuse a request or message id, so both
    // transcript joins key on the session as well as the id.
    expect(query).toContain(
      "ON t.call_key = c.request_id AND t.session_uuid = c.session_uuid",
    );
    expect(query).toContain(
      "ON m.call_key = c.message_id AND m.session_uuid = c.session_uuid",
    );
    expect(query.match(/GROUP BY call_key, session_uuid/g)).toHaveLength(2);
  });

  it("still reads the root chain when the session list leaves the root out", async () => {
    await readModelCallFrames({
      orgId: ORG,
      workspaceId: WS,
      run: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [CHILD] },
    });
    expect(lastQuery().query_params.sessionUuids).toEqual([RUN, CHILD]);
  });
});

describe("readTachoToolCallFrames", () => {
  it("reads a wrapped run's tool calls in the run's workspace and sessions", async () => {
    await readTachoToolCallFrames({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: RUN,
      sessionUuids: [RUN, CHILD],
    });
    const { query, query_params } = lastQuery();
    expect(query).toMatch(
      /WHERE org_id = \{orgId:UUID\}\s+AND workspace_id = \{workspaceId:UUID\}\s+AND root_session_uuid = \{rootSessionUuid:UUID\}\s+AND session_uuid IN \{sessionUuids:Array\(UUID\)\}/,
    );
    expect(query_params).toEqual({
      orgId: ORG,
      workspaceId: WS,
      rootSessionUuid: RUN,
      sessionUuids: [RUN, CHILD],
    });
  });
});
