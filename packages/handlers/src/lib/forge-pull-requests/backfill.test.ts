// The forge backfill's batch selection (ADR-292), with every read a fake:
// which older links get an event, what each event names, and which reads a
// page makes.
import { describe, expect, it, vi } from "vitest";
import {
  type FactLinkRow,
  factBackfillEvents,
  type ForgeBackfillDeps,
  readBackfillPage,
  sessionRefOf,
  type TachoLinkRow,
  tachoBackfillEvents,
} from "./backfill";
import { pullKeyOf } from "./facts";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const OTHER_WS = "0192d4a8-7c1e-7a00-8000-0000000c0e02";
const SESSION = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const RUN = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const ORDER = "0192d4a8-7c1e-7a00-8000-0000000000f1";

const tachoRow = (over: Partial<TachoLinkRow> = {}): TachoLinkRow => ({
  id: "0192d4a8-7c1e-7a00-8000-000000000101",
  orgId: ORG,
  workspaceId: WS,
  provider: "github",
  repository: "acme/api",
  number: 42,
  session: { uuid: SESSION, runId: RUN },
  ...over,
});

const factRow = (over: Partial<FactLinkRow> = {}): FactLinkRow => ({
  id: "0192d4a8-7c1e-7a00-8000-000000000201",
  orgId: ORG,
  workspaceId: WS,
  repository: "acme/api",
  number: 42,
  orderId: ORDER,
  runId: RUN,
  ...over,
});

describe("tachoBackfillEvents", () => {
  it("asks the sync for a run link whose pull request has no forge row, naming the run", () => {
    expect(tachoBackfillEvents([tachoRow()], new Set())).toEqual([
      {
        id: `forge-backfill:${WS}:github:acme/api#42:${RUN}`,
        data: {
          orgId: ORG,
          workspaceId: WS,
          provider: "github",
          repository: "acme/api",
          number: 42,
          pullKey: pullKeyOf(WS, "github", "acme/api", 42),
          link: { rootSessionUuid: SESSION, opened: false },
        },
      },
    ]);
  });

  it("skips a link whose pull request the forge store holds in the same workspace", () => {
    const held = new Set([pullKeyOf(WS, "github", "acme/api", 42)]);
    expect(tachoBackfillEvents([tachoRow()], held)).toEqual([]);
  });

  it("still asks for a link when only another workspace holds the pull request (negative)", () => {
    const held = new Set([pullKeyOf(OTHER_WS, "github", "acme/api", 42)]);
    expect(tachoBackfillEvents([tachoRow()], held)).toHaveLength(1);
  });

  it("asks once for two rows that name the same run and pull request", () => {
    const rows = [
      tachoRow(),
      tachoRow({ id: "0192d4a8-7c1e-7a00-8000-000000000102", repository: "Acme/API" }),
    ];
    const events = tachoBackfillEvents(rows, new Set());
    expect(events.map((event) => event.id)).toEqual([
      `forge-backfill:${WS}:github:acme/api#42:${RUN}`,
    ]);
  });

  it("keeps a GitLab merge request's provider", () => {
    const [event] = tachoBackfillEvents(
      [tachoRow({ provider: "gitlab", repository: "group/sub/app", number: 7 })],
      new Set(),
    );
    expect(event?.id).toBe(`forge-backfill:${WS}:gitlab:group/sub/app#7:${RUN}`);
    expect(event?.data.provider).toBe("gitlab");
  });

  it("asks nothing for a row whose root session is gone or whose provider is unknown (negative)", () => {
    expect(
      tachoBackfillEvents(
        [tachoRow({ session: null }), tachoRow({ provider: "bitbucket" })],
        new Set(),
      ),
    ).toEqual([]);
  });
});

describe("factBackfillEvents", () => {
  const sessions = new Map([[sessionRefOf({ workspaceId: WS, runId: RUN }), SESSION]]);

  it("names the fact's work order, and its run when the root session resolves", () => {
    expect(factBackfillEvents([factRow()], new Set(), sessions)).toEqual([
      {
        id: `forge-backfill:${WS}:github:acme/api#42:${ORDER}`,
        data: {
          orgId: ORG,
          workspaceId: WS,
          provider: "github",
          repository: "acme/api",
          number: 42,
          pullKey: pullKeyOf(WS, "github", "acme/api", 42),
          link: { rootSessionUuid: SESSION, opened: false },
          workOrderId: ORDER,
        },
      },
    ]);
  });

  it("names the work order alone for a ledger run, which has no root session", () => {
    const [event] = factBackfillEvents(
      [factRow({ runId: "arun_9x8w7v6u5t4s3r2q1p0n" })],
      new Set(),
      sessions,
    );
    expect(event?.data.workOrderId).toBe(ORDER);
    expect(event?.data.link).toBeUndefined();
  });

  it("skips a fact whose pull request the forge store holds", () => {
    const held = new Set([pullKeyOf(WS, "github", "acme/api", 42)]);
    expect(factBackfillEvents([factRow()], held, sessions)).toEqual([]);
  });

  it("asks once per order and pull request, and once more for another order", () => {
    const other = "0192d4a8-7c1e-7a00-8000-0000000000f2";
    const events = factBackfillEvents(
      [factRow(), factRow({ id: "0192d4a8-7c1e-7a00-8000-000000000202" }), factRow({ orderId: other })],
      new Set(),
      sessions,
    );
    expect(events.map((event) => event.id)).toEqual([
      `forge-backfill:${WS}:github:acme/api#42:${ORDER}`,
      `forge-backfill:${WS}:github:acme/api#42:${other}`,
    ]);
  });

  it("asks nothing for a fact that names no repository or number (negative)", () => {
    expect(
      factBackfillEvents(
        [factRow({ repository: null }), factRow({ number: null })],
        new Set(),
        sessions,
      ),
    ).toEqual([]);
  });
});

function deps(over: Partial<ForgeBackfillDeps> = {}): ForgeBackfillDeps {
  return {
    tachoPage: vi.fn(async () => [
      tachoRow(),
      tachoRow({ id: "0192d4a8-7c1e-7a00-8000-000000000109", number: 43 }),
    ]),
    factPage: vi.fn(async () => [
      factRow(),
      factRow({ id: "0192d4a8-7c1e-7a00-8000-000000000209", number: 43 }),
    ]),
    heldKeys: vi.fn(async () => new Set([pullKeyOf(WS, "github", "acme/api", 43)])),
    rootSessions: vi.fn(
      async () => new Map([[sessionRefOf({ workspaceId: WS, runId: RUN }), SESSION]]),
    ),
    ...over,
  };
}

describe("readBackfillPage", () => {
  it("reads a page of run links, looks their pull requests up, and answers the cursor", async () => {
    const d = deps();
    const page = await readBackfillPage(d, {
      source: "run_pull_requests",
      after: "0192d4a8-7c1e-7a00-8000-000000000100",
      limit: 2,
    });
    expect(d.tachoPage).toHaveBeenCalledWith("0192d4a8-7c1e-7a00-8000-000000000100", 2);
    expect(d.heldKeys).toHaveBeenCalledWith([
      { workspaceId: WS, provider: "github", repository: "acme/api", number: 42 },
      { workspaceId: WS, provider: "github", repository: "acme/api", number: 43 },
    ]);
    expect(d.rootSessions).not.toHaveBeenCalled();
    expect(page.read).toBe(2);
    expect(page.last).toBe("0192d4a8-7c1e-7a00-8000-000000000109");
    expect(page.events.map((event) => event.data.number)).toEqual([42]);
  });

  it("resolves root sessions only for the facts whose pull request has no forge row", async () => {
    const d = deps();
    const page = await readBackfillPage(d, { source: "pr_linked", after: null, limit: 2 });
    expect(d.factPage).toHaveBeenCalledWith(null, 2);
    expect(d.rootSessions).toHaveBeenCalledWith([{ workspaceId: WS, runId: RUN }]);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.data).toMatchObject({
      number: 42,
      workOrderId: ORDER,
      link: { rootSessionUuid: SESSION, opened: false },
    });
  });

  it("answers no cursor for an empty page (negative)", async () => {
    const d = deps({ factPage: vi.fn(async () => []) });
    await expect(
      readBackfillPage(d, { source: "pr_linked", after: "x", limit: 2 }),
    ).resolves.toEqual({ events: [], read: 0, last: null });
    expect(d.heldKeys).toHaveBeenCalledWith([]);
    expect(d.rootSessions).toHaveBeenCalledWith([]);
  });
});
