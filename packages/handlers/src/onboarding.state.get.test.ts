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
    });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("reads the gate row: the step and the gate's workspace", async () => {
    wire([ROW]);
    const out = await onboardingStateGetHandler({}, makeCTX());
    expect(out).toEqual({
      step: "run",
      workspace: { id: "wrk_0123456789", slug: "core" },
      firstFrameAt: null,
      firstRunId: null,
    });
  });

  it("reports the first frame once recorded", async () => {
    wire([
      {
        ...ROW,
        step: "unlocked",
        firstFrameAt: new Date("2026-09-15T12:05:00.000Z"),
        firstRunId: "tse_0123456789",
      },
    ]);
    const out = await onboardingStateGetHandler({}, makeCTX());
    expect(out).toEqual({
      step: "unlocked",
      workspace: { id: "wrk_0123456789", slug: "core" },
      firstFrameAt: "2026-09-15T12:05:00.000Z",
      firstRunId: "tse_0123456789",
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
    });
  });
});
