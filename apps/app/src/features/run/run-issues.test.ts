// The issues read the page starts once and two places draw (#3970): a read
// that answers is handed through as it is, and one that throws becomes the
// Run page's read error, so the tab strip's count and the Issues table say the
// read failed rather than the page throwing or drawing no issues.
import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "@/data/ports";
import { PAGE_FAILURES, readError, readOk } from "@/data/read";
import { runIssue, runIssues } from "./issues.builders";
import { runSource } from "./run.builders";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readRunIssues } = await import("./run-issues");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

function sourceWith(issues: DataSource["runs"]["issues"]): DataSource {
  const { source } = runSource({
    detail: readError("frame_store_unreachable", 502),
  });
  source.runs.issues = issues;
  return source;
}

describe("readRunIssues", () => {
  it("hands an answered read through, for the run it names", async () => {
    const answer = readOk(
      runIssues({
        issues: [runIssue(), runIssue({ ref: "#7", number: 7 })],
      }),
    );
    const issues = vi.fn(() => Promise.resolve(answer));
    const read = await readRunIssues(ctx, sourceWith(issues), "tse_7k2m9q");
    expect(issues).toHaveBeenCalledWith(ctx, "tse_7k2m9q");
    expect(read).toBe(answer);
  });

  it("hands a refused read through as the refusal, never as no issues (negative)", async () => {
    const read = await readRunIssues(
      ctx,
      sourceWith(() =>
        Promise.resolve({
          ok: false,
          reason: "denied",
          permission: "run.read",
        }),
      ),
      "tse_7k2m9q",
    );
    expect(read).toEqual({
      ok: false,
      reason: "denied",
      permission: "run.read",
    });
  });

  it("turns a read that throws into the Run page's read error (negative)", async () => {
    const read = await readRunIssues(
      ctx,
      sourceWith(() => Promise.reject(new Error("GitHub timed out"))),
      "tse_7k2m9q",
    );
    expect(read).toEqual(
      readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
    );
  });
});
