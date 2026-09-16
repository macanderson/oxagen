import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  rows: [] as unknown[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

import { onboardingStateGetHandler } from "./onboarding.state.get";

function wire(rows: unknown[]): void {
  mocks.rows = rows;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            leftJoin: () => ({
              where: () => ({ limit: async () => mocks.rows }),
            }),
          }),
        }),
      }),
  );
}

const ROW = {
  step: "run",
  workspaceId: "ws-uuid",
  firstFrameAt: null,
  firstRunId: null,
  provisionalUntil: new Date("2026-09-29T12:00:00.000Z"),
  mainRepoBoundAt: null,
  detectedRepository: { provider: "github", owner: "acme", name: "widgets" },
  workspacePublicId: "wrk_0123456789",
  workspaceSlug: "core",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("get_onboarding_state", () => {
  it("answers `organization` for a caller with no organization, reading nothing", async () => {
    wire([]);
    const out = await onboardingStateGetHandler({}, makeCTX({ orgId: "" }));
    expect(out).toEqual({
      step: "organization",
      workspace: null,
      firstFrameAt: null,
      firstRunId: null,
      provisional: null,
    });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("reads the gate row: the step, the gate's workspace, and the open provisional window", async () => {
    wire([ROW]);
    const out = await onboardingStateGetHandler({}, makeCTX());
    expect(out).toEqual({
      step: "run",
      workspace: { id: "wrk_0123456789", slug: "core" },
      firstFrameAt: null,
      firstRunId: null,
      provisional: {
        until: "2026-09-29T12:00:00.000Z",
        mainRepoBoundAt: null,
        detectedRepository: {
          provider: "github",
          owner: "acme",
          name: "widgets",
        },
      },
    });
  });

  it("reports the first frame and the bound repository once recorded, and drops a malformed detected repository", async () => {
    wire([
      {
        ...ROW,
        step: "unlocked",
        firstFrameAt: new Date("2026-09-15T12:05:00.000Z"),
        firstRunId: "tse_0123456789",
        mainRepoBoundAt: new Date("2026-09-15T12:06:00.000Z"),
        detectedRepository: { provider: "gitlab", owner: "acme" },
      },
    ]);
    const out = await onboardingStateGetHandler({}, makeCTX());
    expect(out.step).toBe("unlocked");
    expect(out.firstFrameAt).toBe("2026-09-15T12:05:00.000Z");
    expect(out.firstRunId).toBe("tse_0123456789");
    expect(out.provisional).toEqual({
      until: "2026-09-29T12:00:00.000Z",
      mainRepoBoundAt: "2026-09-15T12:06:00.000Z",
      detectedRepository: null,
    });
  });

  it("reads an organization with no gate row as unlocked with nothing recorded", async () => {
    wire([]);
    const out = await onboardingStateGetHandler({}, makeCTX());
    expect(out).toEqual({
      step: "unlocked",
      workspace: null,
      firstFrameAt: null,
      firstRunId: null,
      provisional: null,
    });
  });
});
