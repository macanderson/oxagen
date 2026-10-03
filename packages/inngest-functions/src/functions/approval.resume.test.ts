import { beforeEach, describe, expect, it, vi } from "vitest";

// The worker that delivers approved calls the deciding request left queued
// (ADR-118, #3127). Each pass reads the shared plane, then each dedicated
// workspace, and hands every due row to `resumeApprovedCall`, whose claim is
// what keeps a call to one run. This suite pins the pass itself.

const mocks = vi.hoisted(() => ({
  listApprovalResumes: vi.fn(),
  listDedicatedApprovalResumeScopes: vi.fn(),
  resumeApprovedCall: vi.fn(),
  createFunction: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@oxagen/agent/runtime/approval-resume", () => ({
  listApprovalResumes: mocks.listApprovalResumes,
  listDedicatedApprovalResumeScopes: mocks.listDedicatedApprovalResumeScopes,
  resumeApprovedCall: mocks.resumeApprovedCall,
}));
vi.mock("pino", () => ({ default: () => ({ error: mocks.error }) }));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Handler = (ctx: {
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<{ outcomes: string[] }>;
let handler: Handler | null = null;
let config: { id?: string; retries?: number; concurrency?: { limit: number } } | null =
  null;
let trigger: { cron?: string } | null = null;
mocks.createFunction.mockImplementation(
  (opts: typeof config, on: typeof trigger, fn: Handler) => {
    config = opts;
    trigger = on;
    handler = fn;
    return [{}];
  },
);

await import("./approval.resume");

const steps: string[] = [];
const step = {
  run: (name: string, fn: () => Promise<unknown>) => {
    steps.push(name);
    return fn();
  },
};

const SHARED = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  orgId: "0192d4a8-7c1e-7a00-8000-0000000000a2",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000a3",
};
const DEDICATED = {
  orgId: "0192d4a8-7c1e-7a00-8000-0000000000d1",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000d2",
};
const DEDICATED_ROW = {
  id: "0192d4a8-7c1e-7a00-8000-0000000000d3",
  ...DEDICATED,
};
const BROKEN = {
  orgId: "0192d4a8-7c1e-7a00-8000-0000000000e1",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000e2",
};

describe("approval/resume", () => {
  beforeEach(() => {
    mocks.listApprovalResumes.mockReset();
    mocks.listDedicatedApprovalResumeScopes.mockReset();
    mocks.resumeApprovedCall.mockReset();
    mocks.error.mockReset();
    steps.length = 0;
  });

  it("runs every minute, one pass at a time", () => {
    expect(config?.id).toBe("approval/resume");
    expect(trigger).toEqual({ cron: "* * * * *" });
    expect(config?.concurrency).toEqual({ limit: 1 });
  });

  it("hands each due row on both planes to the resume once, in its own step", async () => {
    mocks.listApprovalResumes.mockImplementation(async (scope?: unknown) =>
      scope === undefined ? [SHARED] : [DEDICATED_ROW],
    );
    mocks.listDedicatedApprovalResumeScopes.mockResolvedValue([DEDICATED]);
    mocks.resumeApprovedCall.mockResolvedValue("succeeded");

    const out = await handler!({ step });

    expect(mocks.listApprovalResumes).toHaveBeenCalledWith(DEDICATED);
    expect(mocks.resumeApprovedCall).toHaveBeenCalledTimes(2);
    expect(mocks.resumeApprovedCall).toHaveBeenCalledWith(SHARED);
    expect(mocks.resumeApprovedCall).toHaveBeenCalledWith(DEDICATED_ROW);
    expect(steps).toEqual([
      "find-shared-approved-calls",
      "find-dedicated-workspaces",
      `resume-${SHARED.id}`,
      `find-${DEDICATED.workspaceId}`,
      `resume-${DEDICATED_ROW.id}`,
    ]);
    expect(out).toEqual({ outcomes: ["succeeded", "succeeded"] });
  });

  it("reports a claim another delivery already holds as not claimed, and runs nothing else", async () => {
    mocks.listApprovalResumes.mockImplementation(async (scope?: unknown) =>
      scope === undefined ? [SHARED] : [],
    );
    mocks.listDedicatedApprovalResumeScopes.mockResolvedValue([]);
    mocks.resumeApprovedCall.mockResolvedValue("not_claimed");

    const out = await handler!({ step });

    expect(mocks.resumeApprovedCall).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ outcomes: ["not_claimed"] });
  });

  it("logs a dedicated plane it cannot read and still delivers the others (negative)", async () => {
    mocks.listApprovalResumes.mockImplementation(
      async (scope?: { workspaceId: string }) => {
        if (scope === undefined) return [];
        if (scope.workspaceId === BROKEN.workspaceId)
          throw new Error("plane unreachable");
        return [DEDICATED_ROW];
      },
    );
    mocks.listDedicatedApprovalResumeScopes.mockResolvedValue([
      BROKEN,
      DEDICATED,
    ]);
    mocks.resumeApprovedCall.mockResolvedValue("succeeded");

    const out = await handler!({ step });

    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: BROKEN.workspaceId }),
      expect.any(String),
    );
    expect(mocks.resumeApprovedCall).toHaveBeenCalledTimes(1);
    expect(mocks.resumeApprovedCall).toHaveBeenCalledWith(DEDICATED_ROW);
    expect(out).toEqual({ outcomes: ["succeeded"] });
  });
});
