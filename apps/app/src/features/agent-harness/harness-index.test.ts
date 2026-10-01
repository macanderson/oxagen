// The agent harness index (#4871): every page of `list_agents`, retired
// agents included, by key and by slug, and what a failed read leaves.
import { describe, expect, it, vi } from "vitest";
import type { AgentPage } from "@/data/contracts/agents";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { agentPage as pageOf, enrolledAgent } from "@/test/steering-views";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  EMPTY_HARNESS_INDEX,
  harnessOfKey,
  harnessOfSlug,
  readAgentHarnessIndex,
} = await import("./harness-index");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

/** One page of agents, with the cursor of the next page or none. */
function agentPage(
  agents: AgentPage["agents"],
  nextCursor: string | null = null,
): Read<AgentPage> {
  return readOk({ ...pageOf(agents), nextCursor });
}

/** A source whose agents port answers each cursor with the page given. */
function sourceOf(
  pages: Record<string, Read<AgentPage>>,
): { source: DataSource; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const list: DataSource["agents"]["list"] = (...args) => {
    calls.push(args);
    const cursor = args[1].cursor ?? "first";
    return Promise.resolve(
      pages[cursor] ?? readError("agent_index_unavailable", 503),
    );
  };
  // Only the agents port is read; the cast keeps the fake to that one port.
  const source = { agents: { list } } as unknown as DataSource;
  return { source, calls };
}

describe("readAgentHarnessIndex", () => {
  it("walks every page with retired agents included, by key and by slug", async () => {
    const { source, calls } = sourceOf({
      first: agentPage(
        [
          enrolledAgent({
            slug: "release-bot",
            agentKey: "acme.core.release-bot",
            harness: "codex",
          }),
        ],
        "c2",
      ),
      c2: agentPage([
        enrolledAgent({
          id: "agt_retired",
          slug: "old-bot",
          agentKey: "acme.core.old-bot",
          harness: "stella",
          status: "retired",
        }),
      ]),
    });
    const index = await readAgentHarnessIndex(ctx, source);
    expect(calls).toEqual([
      [ctx, { cursor: null, includeRetired: true }],
      [ctx, { cursor: "c2", includeRetired: true }],
    ]);
    expect(harnessOfKey(index, "acme.core.release-bot")).toBe("codex");
    expect(harnessOfKey(index, "acme.core.old-bot")).toBe("stella");
    expect(harnessOfSlug(index, "release-bot")).toBe("codex");
    expect(harnessOfSlug(index, "old-bot")).toBe("stella");
  });

  it("keeps what the earlier pages returned when a later page fails (negative)", async () => {
    const { source } = sourceOf({
      first: agentPage(
        [enrolledAgent({ slug: "docs", agentKey: "acme.core.docs" })],
        "c2",
      ),
    });
    const index = await readAgentHarnessIndex(ctx, source);
    expect(harnessOfSlug(index, "docs")).toBe(enrolledAgent().harness);
  });

  it("is empty when the first page fails, and names no harness it does not hold (negative)", async () => {
    const { source } = sourceOf({
      first: readError("agent_index_unavailable", 503),
    });
    const index = await readAgentHarnessIndex(ctx, source);
    expect(index).toEqual(EMPTY_HARNESS_INDEX);
    expect(harnessOfKey(index, "acme.core.docs")).toBeNull();
    expect(harnessOfKey(index, null)).toBeNull();
    expect(harnessOfSlug(index, "constructor")).toBeNull();
  });

  it("reads an agent with no key by its slug alone", async () => {
    const { source } = sourceOf({
      first: agentPage([
        enrolledAgent({ slug: "pending", agentKey: null, harness: "cursor" }),
      ]),
    });
    const index = await readAgentHarnessIndex(ctx, source);
    expect(harnessOfSlug(index, "pending")).toBe("cursor");
    expect(Object.keys(index.byKey)).toEqual([]);
  });
});
