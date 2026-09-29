// first-version.test.ts: what bind_repository does with each answer of the
// first publish (#4732). context.pr.test.ts runs the step and a merge after
// it; this file covers each answer on its own.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncPublished } from "../context.steering.sync";

const mocks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("../logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger")>()),
  logger: { info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

import { publishFirstVersion } from "./first-version";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const REPOSITORY = "a-intel/oxagen-core-platform";

function port(answer: SyncPublished | null) {
  return vi.fn(async (_scope: { orgId: string; workspaceId: string }) => answer);
}

beforeEach(() => {
  mocks.info.mockReset();
  mocks.warn.mockReset();
});

describe("publishFirstVersion", () => {
  it("publishes nothing without a port", async () => {
    await expect(
      publishFirstVersion(undefined, SCOPE, REPOSITORY),
    ).resolves.toBeNull();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("calls the port with the workspace's scope and logs the version it published", async () => {
    const publish = port({ status: "published", version: 1 });
    await expect(
      publishFirstVersion(publish, SCOPE, REPOSITORY),
    ).resolves.toEqual({ status: "published", version: 1 });
    expect(publish).toHaveBeenCalledWith(SCOPE);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: REPOSITORY,
        status: "published",
        version: 1,
      }),
      expect.stringMatching(/first steering version/),
    );
  });

  it("accepts a head already published, so a rerun of the step passes", async () => {
    await expect(
      publishFirstVersion(
        port({ status: "current", version: 1 }),
        SCOPE,
        REPOSITORY,
      ),
    ).resolves.toEqual({ status: "current", version: 1 });
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: "current", version: 1 }),
      expect.any(String),
    );
  });

  it("throws on a stale head, so the step fails and the job retries it", async () => {
    await expect(
      publishFirstVersion(
        port({ status: "stale", version: null }),
        SCOPE,
        REPOSITORY,
      ),
    ).rejects.toThrow(/a-intel\/oxagen-core-platform moved/);
  });

  it("warns and finishes on a refused publish, because a retry cannot pass until the repo is repaired", async () => {
    await expect(
      publishFirstVersion(
        port({ status: "refused", version: null }),
        SCOPE,
        REPOSITORY,
      ),
    ).resolves.toEqual({ status: "refused", version: null });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repository: REPOSITORY, status: "refused" }),
      expect.stringMatching(/not healthy/),
    );
  });

  it("warns and finishes when the repository does not read as a steering repo", async () => {
    await expect(
      publishFirstVersion(port(null), SCOPE, REPOSITORY),
    ).resolves.toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ repository: REPOSITORY }),
      expect.stringMatching(/does not read as a steering repo/),
    );
  });

  it("lets an error from the port through, so the step fails and retries", async () => {
    const publish = vi.fn(async () => {
      throw new Error("publish_in_progress");
    });
    await expect(
      publishFirstVersion(publish, SCOPE, REPOSITORY),
    ).rejects.toThrow("publish_in_progress");
  });
});
