// The governance mode a send's duty check reads (ADR-251). It fails closed: a
// workspace with no steering repository has no mode, and a repository that is
// bound but cannot be read refuses the send, because the mode might be
// regulated.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { isWorkRecordError } from "@oxagen/work/records";
import type { SteeringHost, SteeringRepository } from "../../context.steering.github";
import { readWorkGovernanceMode } from "./governance";

const mocks = vi.hoisted(() => ({
  readSteeringLayout: vi.fn(),
  defaultHost: { current: null as SteeringHost | null },
}));

vi.mock("../../steering-repo/merge-queue", () => ({
  readSteeringLayout: mocks.readSteeringLayout,
}));

// The real steering deps build a GitHub client. The cases below pass their own
// host, and one case checks that a call without one reads this host.
vi.mock("../../context.steering.deps", () => ({
  steeringDeps: () => ({ github: mocks.defaultHost.current }),
}));

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

const REPO: SteeringRepository = {
  provider: "github",
  owner: "a-intel",
  repo: "oxagen-core-platform",
  fullName: "a-intel/oxagen-core-platform",
  currentFullName: "a-intel/oxagen-core-platform",
  defaultBranch: "main",
};

/** A host whose repository lookup answers `resolve`. */
function host(resolve: () => Promise<SteeringRepository>): SteeringHost {
  return { resolveRepository: vi.fn(resolve) } as unknown as SteeringHost;
}

/** The work record code the call refused with. Fails the case when it succeeds or throws anything else. */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isWorkRecordError(error)) return error.code;
    throw error;
  }
  throw new Error("The call was not refused.");
}

beforeEach(() => {
  mocks.readSteeringLayout.mockReset();
  mocks.defaultHost.current = null;
});

describe("readWorkGovernanceMode", () => {
  it("answers null when the workspace has no steering repository", async () => {
    const missing = host(async () => {
      throw new HandlerError({ code: "not_found", reason: "workspace_repository_missing" });
    });
    await expect(readWorkGovernanceMode(SCOPE, missing)).resolves.toBeNull();
    expect(missing.resolveRepository).toHaveBeenCalledWith(SCOPE);
    expect(mocks.readSteeringLayout).not.toHaveBeenCalled();
  });

  it("refuses not_allowed when the repository cannot be resolved", async () => {
    const failures = [
      new Error("GitHub answered 502"),
      new HandlerError({ code: "forbidden", reason: "steering_token_revoked" }),
      // The right words on a plain error do not count as a missing repository.
      new Error("workspace_repository_missing"),
    ];
    for (const failure of failures) {
      const broken = host(async () => {
        throw failure;
      });
      expect(await refusal(readWorkGovernanceMode(SCOPE, broken)), failure.message).toBe("not_allowed");
    }
    expect(mocks.readSteeringLayout).not.toHaveBeenCalled();
  });

  it("refuses not_allowed when governance.toml cannot be read", async () => {
    mocks.readSteeringLayout.mockRejectedValue(
      new HandlerError({ code: "conflict", reason: "governance_unreadable", message: "steering/governance.toml line 3: mode is not a mode" }),
    );
    const bound = host(async () => REPO);
    const error = await readWorkGovernanceMode(SCOPE, bound).catch((caught: unknown) => caught);
    expect(isWorkRecordError(error, "not_allowed")).toBe(true);
    expect((error as Error).message).toContain("steering/governance.toml");
    expect(mocks.readSteeringLayout).toHaveBeenCalledWith(bound, REPO);
  });

  it("answers regulated from the layout", async () => {
    mocks.readSteeringLayout.mockResolvedValue({ layout: "legacy", mode: "regulated" });
    await expect(readWorkGovernanceMode(SCOPE, host(async () => REPO))).resolves.toBe("regulated");
  });

  it("reads through the workspace's steering host when the caller passes none", async () => {
    const bound = host(async () => REPO);
    mocks.defaultHost.current = bound;
    mocks.readSteeringLayout.mockResolvedValue({ layout: "legacy", mode: "team" });
    await expect(readWorkGovernanceMode(SCOPE)).resolves.toBe("team");
    expect(bound.resolveRepository).toHaveBeenCalledWith(SCOPE);
    expect(mocks.readSteeringLayout).toHaveBeenCalledWith(bound, REPO);
  });
});
