import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — factory must not reference variables declared after it.
vi.mock("../tenant", () => ({
  scopedSession: vi.fn().mockReturnValue({
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { scopedSession } from "../tenant";
import { projectFileLockToGraph } from "./project-file-lock";

const mockScopedSession = vi.mocked(scopedSession);

describe("projectFileLockToGraph", () => {
  let run: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    run = vi.fn().mockResolvedValue({ records: [] });
    close = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run, close });
  });

  const BASE = {
    resourceKey: "github:oxageninc/oxagen-platform:src/a.ts",
    holder: "task-1",
    executionId: "exec-1",
    action: "write",
    now: 1000,
  };

  it("MERGEs a LOCKED edge from the Agent to the SourceFile (never HOLDS_LOCK — that is deprecated)", async () => {
    await projectFileLockToGraph({ ...BASE, event: "acquired", fencingToken: 3, expiresAt: 2000 });
    const cypher = run.mock.calls[0]![0] as string;
    expect(cypher).toContain("MERGE (f:SourceFile {naturalKey: $resourceKey, orgId: $orgId})");
    expect(cypher).toContain("[r:LOCKED]");
    expect(cypher).not.toContain("HOLDS_LOCK");
  });

  it("stamps acquiredAt + fencingToken on an acquire", async () => {
    await projectFileLockToGraph({ ...BASE, event: "acquired", fencingToken: 3, expiresAt: 2000 });
    const params = run.mock.calls[0]![1] as Record<string, unknown>;
    expect(params).toMatchObject({ event: "acquired", fencingToken: 3, expiresAt: 2000, now: 1000 });
  });

  it("passes event=released so the Cypher stamps releasedAt", async () => {
    await projectFileLockToGraph({ ...BASE, event: "released" });
    const params = run.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.event).toBe("released");
    // Missing fencing/expiry default to null (never undefined → Neo4j rejects undefined).
    expect(params.fencingToken).toBeNull();
    expect(params.expiresAt).toBeNull();
  });

  it("always closes the session", async () => {
    await projectFileLockToGraph({ ...BASE, event: "acquired" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns projected:true", async () => {
    const result = await projectFileLockToGraph({ ...BASE, event: "acquired" });
    expect(result).toEqual({ projected: true });
  });
});
