// The skills port: one kernel read of list_skills on the Skills page's failure
// row, mapped into the view model, with a refusal passed through and an
// unmappable record reported once.
import { skillConfigGet } from "@oxagen/oxagen/contracts/skill.config.get";
import { skillList } from "@oxagen/oxagen/contracts/skill.list";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { skills } = await import("./skills");

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

const output = skillList.output.parse({
  window: {
    from: "2026-08-16T12:00:00.000Z",
    to: "2026-09-15T12:00:00.000Z",
  },
  sessions: 3,
  reportedSessions: 2,
  notReportedSessions: 1,
  skills: [
    {
      name: "triage",
      sessions: 2,
      harnesses: ["claude-code"],
      harnessCount: 1,
      firstSeenAt: "2026-09-01T09:00:00.000Z",
      lastSeenAt: "2026-09-14T09:00:00.000Z",
    },
  ],
  nextCursor: null,
});

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("skills.inventory", () => {
  it("reads the first page of list_skills on the skills failure row and maps it", async () => {
    kernelRead.mockResolvedValue(readOk(output));
    const read = await skills.inventory(ctx, { cursor: null });
    expect(kernelRead).toHaveBeenCalledExactlyOnceWith(ctx, {
      contract: skillList,
      input: {},
      page: "skills",
    });
    expect(read).toEqual(
      readOk({
        window: output.window,
        sessions: 3,
        reportedSessions: 2,
        notReportedSessions: 1,
        skills: [
          {
            name: "triage",
            sessions: 2,
            harnesses: ["claude-code"],
            harnessCount: 1,
            lastSeenAt: "2026-09-14T09:00:00.000Z",
          },
        ],
        nextCursor: null,
      }),
    );
  });

  it("asks for the page a cursor names", async () => {
    kernelRead.mockResolvedValue(readOk(output));
    await skills.inventory(ctx, { cursor: "c2" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: skillList,
      input: { cursor: "c2" },
      page: "skills",
    });
  });

  it.each([
    { ok: false, reason: "denied", permission: "skills.read" },
    { ok: false, reason: "pending_approval", accessRequestId: "acr_1" },
    readError("session_store_unavailable", 503),
  ] as const)(
    "passes a $reason read through untouched (negative)",
    async (refusal) => {
      kernelRead.mockResolvedValue(refusal);
      expect(await skills.inventory(ctx, { cursor: null })).toEqual(refusal);
      expect(captureError).not.toHaveBeenCalled();
    },
  );

  it("reports an answer the view model refuses once, as record_unmappable (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        ...output,
        skills: [{ ...output.skills[0], harnesses: [] }],
      }),
    );
    expect(await skills.inventory(ctx, { cursor: null })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("skills.configuration", () => {
  it("preserves version provenance and maps only the display contract", async () => {
    const value = {
      config: {
        enabled: false,
        search: { budget: 6000, cutoff: 0, limit: 10 },
        sources: [],
      },
      draftText: "enabled = false\n",
      current: null,
      versions: [],
    };
    kernelRead.mockResolvedValue(readOk(value));
    expect(await skills.configuration(ctx)).toEqual(
      readOk({
        ...value,
        config: { enabled: false, search: value.config.search },
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: skillConfigGet,
      input: {},
      page: "skills",
    });
  });
  it("preserves denial and reports malformed configuration without fabricating an off value", async () => {
    const denied = { ok: false, reason: "denied", permission: "skills.read" };
    kernelRead.mockResolvedValueOnce(denied);
    expect(await skills.configuration(ctx)).toEqual(denied);
    kernelRead.mockResolvedValueOnce(
      readOk({ config: { enabled: true }, current: null, versions: [] }),
    );
    expect(await skills.configuration(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});
