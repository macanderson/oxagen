import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRunWorkGetHandler, type RunWorkDeps } from "./run.work.get";
import {
  ctx,
  memoryStores,
  tachoSession,
  OTHER_WORKSPACE,
  roleTx,
} from "./run.test-support";
const role = vi.hoisted(() => ({ current: "Owner" as string | null }));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withOrgDb: (fn: (tx: ReturnType<typeof roleTx>) => unknown) =>
    fn(roleTx(role.current)),
  withTenantDb: (fn: (tx: ReturnType<typeof roleTx>) => unknown) =>
    fn(roleTx(role.current)),
}));
beforeEach(() => {
  role.current = "Owner";
});
const RUN_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
function setup() {
  const stores = memoryStores([], [tachoSession({ publicId: RUN_ID })]);
  const deps: RunWorkDeps = {
    queries: stores.queries,
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    store: {
      getRunByPublicId: async () => null,
      readAttemptEventsSince: async () => [],
    },
    tachoFrames: async () => [],
    contexts: vi.fn().mockResolvedValue([
      {
        path: "/repo",
        branch: "main",
        head: "abc",
        remote: "",
        repository: "",
        first_seq: 0,
        last_seq: 7,
      },
    ]),
    diffs: vi.fn().mockResolvedValue([]),
    subagents: vi.fn().mockResolvedValue([
      { id: "a0182b6cd3a21d284", type: "Explore", first_seq: 3, last_seq: 9, stopped: 1 },
      { id: "a079426c9a96dd3cb", type: "", first_seq: 12, last_seq: 12, stopped: 0 },
    ]),
    repositories: vi.fn().mockResolvedValue([]),
    pullRequests: vi.fn().mockResolvedValue({
      pullRequests: [],
      complete: false,
      warnings: ["repository_not_connected"],
    }),
  };
  return { deps, handler: createRunWorkGetHandler(deps) };
}
describe("get_run_work", () => {
  it("denies viewers before reading checkout or provider evidence", async () => {
    role.current = "Viewer";
    const { handler, deps } = setup();
    await expect(handler({ runId: RUN_ID }, ctx())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(deps.contexts).not.toHaveBeenCalled();
    expect(deps.repositories).not.toHaveBeenCalled();
    expect(deps.pullRequests).not.toHaveBeenCalled();
  });
  it("resolves workspace access before reading any checkout or provider evidence", async () => {
    const { handler, deps } = setup();
    await expect(
      handler({ runId: RUN_ID }, ctx(OTHER_WORKSPACE)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(deps.contexts).not.toHaveBeenCalled();
    expect(deps.repositories).not.toHaveBeenCalled();
    expect(deps.pullRequests).not.toHaveBeenCalled();
  });
  it("keeps recorded locations when provider evidence is unavailable", async () => {
    const { handler } = setup();
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result).toMatchObject({
      runId: RUN_ID,
      complete: false,
      checkouts: [{ path: "/repo", branch: "main" }],
      warnings: ["repository_not_connected"],
    });
  });
  it("lists the subagents the session started from their hook frames", async () => {
    const { handler } = setup();
    const result = await handler({ runId: RUN_ID }, ctx());
    expect(result.subagents).toEqual([
      {
        id: "a0182b6cd3a21d284",
        type: "Explore",
        firstSeq: "3",
        lastSeq: "9",
        stopped: true,
      },
      {
        id: "a079426c9a96dd3cb",
        type: null,
        firstSeq: "12",
        lastSeq: "12",
        stopped: false,
      },
    ]);
  });
});
