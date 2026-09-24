// The work read the page starts once and three places draw: a read that
// answers is handed through as it is, and one that throws becomes the Run
// page's read error, so the header, the Changes panel and Linked work say the
// read failed rather than the page throwing or drawing zero work.
import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "@/data/ports";
import { PAGE_FAILURES, readError, readOk } from "@/data/read";
import { runSource } from "./run.builders";
import { runWork } from "./sections.builders";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readRunWork } = await import("./work-ci");

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

function sourceWith(work: DataSource["runs"]["work"]): DataSource {
  const { source } = runSource({
    detail: readError("frame_store_unreachable", 502),
  });
  source.runs.work = work;
  return source;
}

describe("readRunWork", () => {
  it("hands an answered read through, for the run it names", async () => {
    const work = vi.fn(() => Promise.resolve(readOk(runWork())));
    const read = await readRunWork(ctx, sourceWith(work), "tse_7k2m9q");
    expect(work).toHaveBeenCalledWith(ctx, "tse_7k2m9q");
    expect(read.ok && read.value.pullRequests[0]?.number).toBe(511);
  });

  it("hands a refused read through as the refusal, never as empty work (negative)", async () => {
    const read = await readRunWork(
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
    const read = await readRunWork(
      ctx,
      sourceWith(() => Promise.reject(new Error("GitHub timed out"))),
      "tse_7k2m9q",
    );
    expect(read).toEqual(
      readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
    );
  });
});
