// What workspace.ts decides about a memory with no database: its harness,
// whether the harness reports uses, which memories say the same thing, how
// a page of groups is cut, and the force a promoted draft takes.
import { describe, expect, it } from "vitest";
import { statementHash } from "./statement";
import {
  allowedForces,
  defaultForce,
  groupPage,
  groupRankedMemories,
  harnessOf,
  hasUseSignal,
  memoryView,
} from "./workspace";
import type { WorkspaceMemoryRow } from "./workspace-store";

const FILE = "claude-code:/home/dev/.claude/projects/-proj/memory/use-pnpm.md";

let n = 0;
function row(statement: string, over: Partial<WorkspaceMemoryRow> = {}): WorkspaceMemoryRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    publicId: `mem_${n}`,
    agentLineage: "agt.laptop",
    runPublicId: null,
    capture: "local_gateway",
    statement,
    statementHash: statementHash(statement),
    kind: "memory",
    repos: null,
    appliesTo: null,
    tools: null,
    evidence: [],
    source: FILE,
    label: null,
    summary: null,
    memoryType: null,
    state: "waiting",
    useCount: 0,
    lastUsedAt: null,
    promotedLineage: null,
    retiredAt: null,
    retiredReason: null,
    createdAt: new Date("2026-09-30T10:00:00.000Z"),
    memoryPr: null,
    ...over,
  };
}

describe("harnessOf", () => {
  it("reads the harness that starts a harness memory file's source", () => {
    expect(harnessOf("local_gateway", FILE)).toBe("claude-code");
    expect(harnessOf("local_gateway", "codex:thread/019a")).toBe("codex");
    expect(harnessOf("local_gateway", "stella:lin_abc")).toBe("stella");
  });

  it("names no harness for a memory no harness holds", () => {
    expect(harnessOf("remember", null)).toBeNull();
    expect(harnessOf("pull_request", "https://github.com/acme/api/pull/1")).toBeNull();
    expect(harnessOf("import", "CLAUDE.md")).toBeNull();
  });

  it("names no harness for a source whose prefix is not one Tacho supports", () => {
    expect(harnessOf("local_gateway", "gemini:/home/dev/.gemini/tmp/m.md")).toBeNull();
    expect(harnessOf("local_gateway", "no-prefix")).toBeNull();
    expect(harnessOf("local_gateway", null)).toBeNull();
  });
});

describe("hasUseSignal", () => {
  it("is true for the harnesses that report a use, and false for the rest", () => {
    expect(hasUseSignal("claude-code")).toBe(true);
    expect(hasUseSignal("codex")).toBe(true);
    expect(hasUseSignal("stella")).toBe(true);
    expect(hasUseSignal("cursor")).toBe(false);
    expect(hasUseSignal("claude-desktop")).toBe(false);
    expect(hasUseSignal(null)).toBe(false);
  });
});

describe("groupRankedMemories", () => {
  it("joins memories with the same statement hash", () => {
    const a = row("Use pnpm, never npm.");
    const b = row("use pnpm never npm");
    const groups = groupRankedMemories([a, b]);
    expect(groups.map((g) => g.members.map((m) => m.publicId))).toEqual([
      [a.publicId, b.publicId],
    ]);
  });

  it("joins memories whose content words overlap by 80% or more", () => {
    const a = row("Run the migration check before every build of the api.");
    const b = row("Before every build of the api, run the migration check.");
    const c = row("Deploy the web app from the main branch only.");
    const groups = groupRankedMemories([a, c, b]);
    expect(groups.map((g) => g.representative.publicId)).toEqual([a.publicId, c.publicId]);
    expect(groups[0]?.members.map((m) => m.publicId)).toEqual([a.publicId, b.publicId]);
  });

  it("keeps a statement apart from its negation", () => {
    const a = row("Squash merge the steering PRs.");
    const b = row("Never squash merge the steering PRs.");
    expect(groupRankedMemories([a, b])).toHaveLength(2);
  });

  it("keeps the same statement apart in two repositories", () => {
    const a = row("Use pnpm.", { repos: ["github.com/acme/api"] });
    const b = row("Use pnpm.", { repos: ["github.com/acme/web"] });
    const c = row("Use pnpm.");
    expect(groupRankedMemories([a, b, c])).toHaveLength(3);
  });

  it("returns the groups in ranking order, the highest ranked memory first in each", () => {
    const top = row("Use pnpm.", { useCount: 9 });
    const other = row("Pin the toolchain.", { useCount: 4 });
    const twin = row("use pnpm", { useCount: 1 });
    const groups = groupRankedMemories([top, other, twin]);
    expect(groups.map((g) => g.representative.publicId)).toEqual([top.publicId, other.publicId]);
    expect(groups[0]?.members.map((m) => m.publicId)).toEqual([top.publicId, twin.publicId]);
  });
});

describe("groupPage", () => {
  it("adds a group's uses and takes its newest use", () => {
    const a = row("Use pnpm.", { useCount: 3, lastUsedAt: new Date("2026-10-01T09:00:00.000Z") });
    const b = row("use pnpm", { useCount: 2, lastUsedAt: new Date("2026-10-01T11:00:00.000Z") });
    const page = groupPage([a, b], 0, 50);
    expect(page.total).toBe(1);
    expect(page.groups[0]).toMatchObject({
      memory: { id: a.publicId },
      use_count: 5,
      last_used_at: "2026-10-01T11:00:00.000Z",
    });
    expect(page.groups[0]?.members.map((m) => m.id)).toEqual([a.publicId, b.publicId]);
  });

  it("cuts the page from the groups, not the memories", () => {
    const rows = [
      row("Use pnpm."),
      row("use pnpm"),
      row("Pin the toolchain."),
      row("Deploy from main only."),
    ];
    const page = groupPage(rows, 1, 1);
    expect(page.total).toBe(3);
    expect(page.groups.map((g) => g.memory.statement)).toEqual(["Pin the toolchain."]);
  });

  it("answers a group no run used with no last use", () => {
    const page = groupPage([row("Use pnpm.")], 0, 50);
    expect(page.groups[0]?.last_used_at).toBeNull();
  });
});

describe("memoryView", () => {
  it("shapes a row as the contracts answer it", () => {
    const view = memoryView(
      row("Use pnpm.", {
        publicId: "mem_view",
        label: "Use pnpm",
        memoryType: "feedback",
        useCount: 2,
        lastUsedAt: new Date("2026-10-01T09:00:00.000Z"),
        state: "in_pr",
        memoryPr: {
          id: "00000000-0000-4000-8000-0000000000aa",
          publicId: "mpr_1",
          number: 7,
          url: "https://github.com/acme/steering/pull/7",
          status: "open",
        },
      }),
    );
    expect(view).toEqual({
      id: "mem_view",
      label: "Use pnpm",
      summary: null,
      statement: "Use pnpm.",
      state: "in_pr",
      capture: "local_gateway",
      harness: "claude-code",
      agent: "agt.laptop",
      source: FILE,
      repos: null,
      memory_type: "feedback",
      kind: "memory",
      use_count: 2,
      use_signal: true,
      last_used_at: "2026-10-01T09:00:00.000Z",
      created_at: "2026-09-30T10:00:00.000Z",
      promoted_lineage: null,
      memory_pr: {
        number: 7,
        url: "https://github.com/acme/steering/pull/7",
        status: "open",
      },
    });
  });
});

describe("forces", () => {
  it("lets a rule kind carry any force and defaults it to should", () => {
    for (const kind of ["business-rule", "code-rule", "constraint", "procedure"] as const) {
      expect(allowedForces(kind)).toEqual(["must", "should", "may", "info"]);
      expect(defaultForce(kind)).toBe("should");
    }
  });

  it("keeps a preference soft and a fact or a memory at info", () => {
    expect(allowedForces("preference")).toEqual(["may", "info"]);
    expect(defaultForce("preference")).toBe("may");
    expect(allowedForces("fact")).toEqual(["info"]);
    expect(defaultForce("fact")).toBe("info");
    expect(allowedForces("memory")).toEqual(["info"]);
    expect(defaultForce("memory")).toBe("info");
  });
});
