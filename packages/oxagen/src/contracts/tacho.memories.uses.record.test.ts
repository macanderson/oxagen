import { describe, expect, it } from "vitest";
import {
  MEMORY_COUNTS_PER_REPORT,
  MEMORY_SCAN_PATHS_MAX,
  MEMORY_SCANS_PER_REPORT,
  MEMORY_USES_PER_REPORT,
  tachoMemoryUsesRecord as contract,
} from "./tacho.memories.uses.record";

const ROOT = "/home/dev/.claude/projects/";
const FILE = `${ROOT}-proj/memory/use-pnpm.md`;
const use = {
  harness: "claude-code",
  path: FILE,
  session_uuid: "6f1c2b9e-1d2a-4c3b-8e4f-5a6b7c8d9e0f",
  count: 2,
  used_at: "2026-10-01T12:00:00.000Z",
};
const scan = { harness: "claude-code", root: ROOT, paths: [FILE] };
const count = {
  harness: "codex",
  path: "thread/01a0e198-36ea-7e52-aedf-4b346877c10d",
  count: 3,
  used_at: "2026-10-01T12:00:00.000Z",
};
const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  uses: [use],
  scans: [scan],
  counts: [count],
};

describe("host memory use contract", () => {
  it("takes uses, scans, and harness counts from a named host", () => {
    expect(contract.input.safeParse(input).success).toBe(true);
  });

  it("takes a report with no uses, no scans, and no counts", () => {
    expect(
      contract.input.parse({ host_enrollment_id: input.host_enrollment_id }),
    ).toEqual({
      host_enrollment_id: input.host_enrollment_id,
      uses: [],
      scans: [],
      counts: [],
    });
  });

  it("takes a Codex store's root and paths in a scan", () => {
    expect(
      contract.input.safeParse({
        ...input,
        scans: [{ harness: "codex", root: "thread/", paths: [count.path] }],
      }).success,
    ).toBe(true);
  });

  it("refuses a malformed harness count", () => {
    for (const patch of [
      { harness: "vim" },
      { path: "" },
      { path: "p".repeat(1025) },
      { count: 0 },
      { count: 10_001 },
      { count: 2.5 },
      { used_at: "yesterday" },
      { session_uuid: use.session_uuid },
    ]) {
      expect(
        contract.input.safeParse({ ...input, counts: [{ ...count, ...patch }] })
          .success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("takes a Windows root and an offset timestamp", () => {
    const root = "C:\\Users\\dev\\.claude\\projects\\";
    expect(
      contract.input.safeParse({
        ...input,
        uses: [{ ...use, used_at: "2026-10-01T08:00:00-04:00" }],
        scans: [
          { harness: "claude-code", root, paths: [`${root}p\\memory\\a.md`] },
        ],
      }).success,
    ).toBe(true);
  });

  it("refuses a malformed use", () => {
    for (const patch of [
      { harness: "vim" },
      { path: "" },
      { path: "p".repeat(1025) },
      { session_uuid: "tse_1" },
      { count: 0 },
      { count: 1.5 },
      { used_at: "yesterday" },
      { run: "tse_1" },
    ]) {
      expect(
        contract.input.safeParse({ ...input, uses: [{ ...use, ...patch }] })
          .success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("refuses a scan whose paths leave its root", () => {
    for (const patch of [
      { root: "/home/dev/.claude/projects" },
      { paths: ["/home/dev/.claude/projects-old/p/memory/a.md"] },
      { paths: [ROOT] },
    ]) {
      expect(
        contract.input.safeParse({ ...input, scans: [{ ...scan, ...patch }] })
          .success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("bounds the uses, the counts, the scans, and the paths of one report", () => {
    expect(MEMORY_USES_PER_REPORT).toBe(200);
    expect(MEMORY_SCANS_PER_REPORT).toBe(8);
    expect(MEMORY_SCAN_PATHS_MAX).toBe(4_000);
    expect(MEMORY_COUNTS_PER_REPORT).toBe(200);
    const uses = Array.from({ length: MEMORY_USES_PER_REPORT + 1 }, () => use);
    expect(contract.input.safeParse({ ...input, uses }).success).toBe(false);
    const counts = Array.from(
      { length: MEMORY_COUNTS_PER_REPORT + 1 },
      () => count,
    );
    expect(contract.input.safeParse({ ...input, counts }).success).toBe(false);
    const scans = Array.from(
      { length: MEMORY_SCANS_PER_REPORT + 1 },
      () => scan,
    );
    expect(contract.input.safeParse({ ...input, scans }).success).toBe(false);
    const paths = Array.from(
      { length: MEMORY_SCAN_PATHS_MAX + 1 },
      (_, i) => `${ROOT}p/memory/${i}.md`,
    );
    expect(
      contract.input.safeParse({ ...input, scans: [{ ...scan, paths }] })
        .success,
    ).toBe(false);
  });

  it("stays off the agent and MCP surfaces and needs an admin's key", () => {
    expect(contract.name).toBe("record_tacho_memory_uses");
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.sensitivity).toBe("high");
    expect(contract.defaultEffect).toBe("deny");
    expect(contract.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
    const answer = { recorded: 1, unknown: 0, pending: [0], retired: 2 };
    expect(contract.output.safeParse(answer).success).toBe(true);
    expect(contract.output.safeParse({ ...answer, extra: 1 }).success).toBe(
      false,
    );
  });
});
