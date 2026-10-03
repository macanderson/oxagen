// Each work order's pull requests from the forge store (ADR-292): the link
// table, then the pr_linked facts matched by provider, repository, and number.
// The fake answers every row a table holds whatever the query's filter, so
// these tests prove the matching the read does in code.
import { schema } from "@oxagen/database";
import { describe, expect, it } from "vitest";
import { readOrderPullRequests } from "./orders";

const scope = { orgId: "org", workspaceId: "ws" };
const O1 = "00000000-0000-4000-8000-0000000000c1";
const O2 = "00000000-0000-4000-8000-0000000000c2";
const SHA = "a".repeat(40);

type PullRow = {
  id: string;
  publicId: string;
  provider: string;
  repository: string;
  number: number;
  url: string;
  title: string | null;
  state: string;
  draft: boolean;
  headSha: string;
  stateSeenAt: Date;
};

function pull(over: Partial<PullRow> & Pick<PullRow, "id" | "number">): PullRow {
  return {
    publicId: `fpr_${over.id}`,
    provider: "github",
    repository: "acme/api",
    url: `https://github.com/acme/api/pull/${over.number}`,
    title: `Change ${over.number}`,
    state: "open",
    draft: false,
    headSha: SHA,
    stateSeenAt: new Date("2026-10-03T10:00:00.000Z"),
    ...over,
  };
}

function fakeDb(rows: { links: { orderId: string; pullRequestId: string }[]; pulls: PullRow[] }) {
  const reads: string[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.forgePullRequestWorkOrders) {
            reads.push("links");
            return Promise.resolve(rows.links);
          }
          if (table === schema.forgePullRequests) {
            reads.push("pulls");
            return Promise.resolve(rows.pulls);
          }
          throw new Error("the read asked a table the test does not hold");
        },
      }),
    }),
  };
  return { db: db as unknown as Parameters<typeof readOrderPullRequests>[0], reads };
}

describe("readOrderPullRequests", () => {
  it("lists every pull request an order is linked to, newest state first", async () => {
    const { db, reads } = fakeDb({
      links: [
        { orderId: O1, pullRequestId: "p1" },
        { orderId: O1, pullRequestId: "p2" },
      ],
      pulls: [
        pull({ id: "p1", number: 1, state: "merged" }),
        pull({ id: "p2", number: 2, draft: true, stateSeenAt: new Date("2026-10-03T11:00:00.000Z") }),
      ],
    });
    const out = await readOrderPullRequests(db, scope, [O1], []);
    expect(out.get(O1)).toEqual([
      {
        id: "fpr_p2",
        provider: "github",
        repository: "acme/api",
        number: 2,
        url: "https://github.com/acme/api/pull/2",
        title: "Change 2",
        state: "draft",
        headSha: SHA,
        stateSeenAt: "2026-10-03T11:00:00.000Z",
      },
      {
        id: "fpr_p1",
        provider: "github",
        repository: "acme/api",
        number: 1,
        url: "https://github.com/acme/api/pull/1",
        title: "Change 1",
        state: "merged",
        headSha: SHA,
        stateSeenAt: "2026-10-03T10:00:00.000Z",
      },
    ]);
    expect(reads).toEqual(["links", "pulls"]);
  });

  it("matches a pr_linked fact to a GitHub row by repository and number, in any case", async () => {
    const { db } = fakeDb({ links: [], pulls: [pull({ id: "p5", number: 5 })] });
    const out = await readOrderPullRequests(db, scope, [O2], [{ orderId: O2, repository: "Acme/API", number: 5 }]);
    expect(out.get(O2)?.map((entry) => entry.id)).toEqual(["fpr_p5"]);
  });

  it("names a pull request once when the link and a fact both name it", async () => {
    const { db } = fakeDb({ links: [{ orderId: O1, pullRequestId: "p5" }], pulls: [pull({ id: "p5", number: 5 })] });
    const out = await readOrderPullRequests(db, scope, [O1], [{ orderId: O1, repository: "acme/api", number: 5 }]);
    expect(out.get(O1)?.map((entry) => entry.id)).toEqual(["fpr_p5"]);
  });

  it("reads nothing for a key the forge store holds no row for (negative)", async () => {
    const { db } = fakeDb({
      links: [],
      pulls: [
        pull({ id: "p5", number: 5 }),
        // The same repository and number on GitLab is another pull request.
        pull({ id: "g9", number: 9, provider: "gitlab" }),
        pull({ id: "w9", number: 9, repository: "acme/web" }),
      ],
    });
    const out = await readOrderPullRequests(db, scope, [O2], [{ orderId: O2, repository: "acme/api", number: 9 }]);
    expect(out.has(O2)).toBe(false);
  });

  it("leaves out a link whose row is gone and a fact for an order not asked for (negative)", async () => {
    const { db } = fakeDb({ links: [{ orderId: O1, pullRequestId: "gone" }], pulls: [pull({ id: "p5", number: 5 })] });
    const out = await readOrderPullRequests(db, scope, [O1], [{ orderId: O2, repository: "acme/api", number: 5 }]);
    expect(out.size).toBe(0);
  });

  it("asks no query for a page with no orders, and only the link table when nothing is named", async () => {
    const none = fakeDb({ links: [], pulls: [] });
    expect((await readOrderPullRequests(none.db, scope, [], [])).size).toBe(0);
    expect(none.reads).toEqual([]);
    const unlinked = fakeDb({ links: [], pulls: [pull({ id: "p5", number: 5 })] });
    expect((await readOrderPullRequests(unlinked.db, scope, [O1], [])).size).toBe(0);
    expect(unlinked.reads).toEqual(["links"]);
  });
});
