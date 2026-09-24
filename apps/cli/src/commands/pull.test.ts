/**
 * `oxagen pull`: the three-way plan (pure), the path checks that keep every
 * write inside `.oxagen/`, and the command against a temp directory. The API
 * client and the working-copy report are mocked, so nothing leaves the
 * process.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { CommandWriter } from "../lib/capture-writer.js";

const hoisted = vi.hoisted(() => ({
  apiPostOrThrow: vi.fn(),
  reportWorkingCopy: vi.fn(),
}));
vi.mock("../lib/api.js", () => ({ apiPostOrThrow: hoisted.apiPostOrThrow }));
vi.mock("../lib/working-copy.js", () => ({
  reportWorkingCopy: hoisted.reportWorkingCopy,
}));

import {
  checkSteeringPath,
  findLinkedRoot,
  planPull,
  pull,
  sha256,
  type PublishedSteering,
} from "./pull.js";
import { readWorkspaceLink, writeWorkspaceLink } from "./workspace-link.js";

const mockPost = hoisted.apiPostOrThrow as Mock;
const mockReport = hoisted.reportWorkingCopy as Mock;

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function reader(files: Record<string, string>) {
  return (path: string) => (path in files ? files[path]! : null);
}

// ── planPull ─────────────────────────────────────────────────────────────────

describe("planPull", () => {
  it("creates what is absent and leaves what matches", () => {
    const plan = planPull({
      published: [
        { path: ".oxagen/rules/a.md", content: "A" },
        { path: ".oxagen/rules/b.md", content: "B" },
      ],
      readLocal: reader({ ".oxagen/rules/b.md": "B" }),
    });
    expect(plan.entries).toEqual([
      { path: ".oxagen/rules/a.md", action: "create" },
      { path: ".oxagen/rules/b.md", action: "unchanged" },
    ]);
    expect(plan.writes).toEqual([{ path: ".oxagen/rules/a.md", content: "A" }]);
    expect(plan.manifest).toEqual({
      ".oxagen/rules/a.md": sha256("A"),
      ".oxagen/rules/b.md": sha256("B"),
    });
    expect(plan.conflicts).toEqual([]);
  });

  it("updates a file nobody edited since the last pull", () => {
    const plan = planPull({
      published: [{ path: ".oxagen/rules/a.md", content: "A2" }],
      readLocal: reader({ ".oxagen/rules/a.md": "A1" }),
      base: { ".oxagen/rules/a.md": sha256("A1") },
    });
    expect(plan.entries).toEqual([
      { path: ".oxagen/rules/a.md", action: "update" },
    ]);
    expect(plan.writes).toHaveLength(1);
  });

  it("calls a local edit a conflict, and --force overwrites it", () => {
    const input = {
      published: [{ path: ".oxagen/rules/a.md", content: "A2" }],
      readLocal: reader({ ".oxagen/rules/a.md": "mine" }),
      base: { ".oxagen/rules/a.md": sha256("A1") },
    };
    const plan = planPull(input);
    expect(plan.conflicts).toEqual([".oxagen/rules/a.md"]);
    expect(plan.entries[0]).toEqual({
      path: ".oxagen/rules/a.md",
      action: "conflict",
      wants: "update",
    });
    expect(plan.writes).toEqual([]);

    const forced = planPull({ ...input, force: true });
    expect(forced.conflicts).toEqual([]);
    expect(forced.writes).toEqual([
      { path: ".oxagen/rules/a.md", content: "A2" },
    ]);
  });

  it("calls a file present before any pull a conflict when it differs", () => {
    const plan = planPull({
      published: [{ path: ".oxagen/rules/a.md", content: "A" }],
      readLocal: reader({ ".oxagen/rules/a.md": "hand-written" }),
    });
    expect(plan.conflicts).toEqual([".oxagen/rules/a.md"]);
  });

  it("deletes an unpublished file it wrote, and conflicts on an edited one", () => {
    const plan = planPull({
      published: [],
      readLocal: reader({
        ".oxagen/rules/old.md": "old",
        ".oxagen/rules/kept.md": "edited",
      }),
      base: {
        ".oxagen/rules/old.md": sha256("old"),
        ".oxagen/rules/kept.md": sha256("original"),
        ".oxagen/rules/gone.md": sha256("gone"),
      },
    });
    expect(plan.deletes).toEqual([".oxagen/rules/old.md"]);
    expect(plan.conflicts).toEqual([".oxagen/rules/kept.md"]);
    expect(plan.entries).toContainEqual({
      path: ".oxagen/rules/kept.md",
      action: "conflict",
      wants: "delete",
    });
    // Already gone here: nothing to do and nothing to report.
    expect(plan.entries.map((e) => e.path)).not.toContain(
      ".oxagen/rules/gone.md",
    );
    expect(plan.manifest).toEqual({});

    const forced = planPull({
      published: [],
      readLocal: reader({ ".oxagen/rules/kept.md": "edited" }),
      base: { ".oxagen/rules/kept.md": sha256("original") },
      force: true,
    });
    expect(forced.deletes).toEqual([".oxagen/rules/kept.md"]);
  });

  it("rejects paths outside .oxagen/ and never writes them", () => {
    const plan = planPull({
      published: [
        { path: ".oxagen/../etc/passwd", content: "x" },
        { path: "../outside.md", content: "x" },
        { path: "/etc/passwd", content: "x" },
        { path: "README.md", content: "x" },
        { path: ".oxagen/workspace.json", content: "{}" },
        { path: ".oxagen/rules/ok.md", content: "ok" },
      ],
      readLocal: reader({}),
    });
    expect(plan.rejected.map((r) => r.path)).toEqual([
      ".oxagen/../etc/passwd",
      "../outside.md",
      "/etc/passwd",
      "README.md",
      ".oxagen/workspace.json",
    ]);
    expect(plan.writes.map((w) => w.path)).toEqual([".oxagen/rules/ok.md"]);
  });

  it("ignores base entries that name unsafe paths", () => {
    const plan = planPull({
      published: [],
      readLocal: () => "x",
      base: { "../escape.md": sha256("x") },
    });
    expect(plan.deletes).toEqual([]);
  });

  it("rejects a path published twice", () => {
    const plan = planPull({
      published: [
        { path: ".oxagen/a.md", content: "1" },
        { path: ".oxagen/a.md", content: "2" },
      ],
      readLocal: reader({}),
    });
    expect(plan.rejected).toEqual([
      { path: ".oxagen/a.md", reason: "published twice" },
    ]);
  });
});

describe("checkSteeringPath", () => {
  it.each([
    ["", "empty path"],
    [".oxagen/a\0b", "contains a NUL byte"],
    [".oxagen\\rules\\a.md", "contains a backslash"],
    ["/abs/.oxagen/a", "absolute path"],
    ["C:/x/.oxagen/a", "absolute path"],
    [".oxagen/./a.md", "not a canonical path"],
    [".oxagen//a.md", "not a canonical path"],
    [".oxagen/rules/../../x", "not a canonical path"],
    [".oxagenx/a.md", "outside .oxagen/"],
    [".oxagen", "outside .oxagen/"],
  ])("refuses %j (%s)", (path, reason) => {
    expect(checkSteeringPath(path)).toEqual({ ok: false, reason });
  });

  it("accepts a path inside .oxagen/", () => {
    expect(checkSteeringPath(".oxagen/rules/a.md")).toEqual({
      ok: true,
      path: ".oxagen/rules/a.md",
    });
  });
});

// ── The command ──────────────────────────────────────────────────────────────

let dir: string;
let out: string[];
let err: string[];
let writer: CommandWriter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-pull-test-"));
  out = [];
  err = [];
  writer = {
    write: (l) => {
      out.push(l);
    },
    writeErr: (l) => {
      err.push(l);
    },
  };
  mockPost.mockReset();
  mockReport.mockReset();
  mockReport.mockResolvedValue({
    workingCopyId: "wcp_1",
    lastSeenAt: "2026-09-24T00:00:00.000Z",
  });
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

function link(): void {
  writeWorkspaceLink(dir, {
    orgSlug: "acme",
    orgId: "org_1",
    orgName: "Acme",
    workspaceSlug: "payments",
    workspaceId: "wrk_1",
    workspaceName: "Payments",
    linkedAt: "2026-09-24T00:00:00.000Z",
  });
}

function published(
  files: Array<{ path: string; content: string }>,
  head: string | null = HEAD,
): PublishedSteering {
  return {
    bindingId: "rpb_abc",
    role: "main",
    fullName: "acme/steering",
    productionBranch: "main",
    head,
    files,
    readAt: "2026-09-24T00:00:00.000Z",
  };
}

function read(path: string): string {
  return readFileSync(join(dir, path), "utf8");
}

describe("pull", () => {
  it("refuses an unlinked directory with the init command to run", async () => {
    await pull({}, writer, dir);
    expect(err.join("\n")).toContain(
      "Run `oxagen init --org <org> --workspace <workspace>` first.",
    );
    expect(process.exitCode).toBe(1);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("exits 2 on a malformed --binding before any request", async () => {
    link();
    await pull({ binding: "main" }, writer, dir);
    expect(process.exitCode).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("writes the published files, stores the base and reports the directory", async () => {
    link();
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    mockPost.mockResolvedValue(
      published([
        { path: ".oxagen/rules/a.md", content: "A" },
        { path: ".oxagen/agents/b.toml", content: "B" },
      ]),
    );

    // From a subdirectory: pull walks up to the link.
    await pull({}, writer, join(dir, "src", "deep"));

    expect(process.exitCode).toBeUndefined();
    const [path, body, scope] = mockPost.mock.calls[0] ?? [];
    expect(path).toBe("context/steering/published");
    expect(body).toEqual({});
    expect(scope).toEqual({ org: "acme", ws: "payments" });
    expect(read(".oxagen/rules/a.md")).toBe("A");
    expect(read(".oxagen/agents/b.toml")).toBe("B");
    expect(out).toEqual([
      "created .oxagen/agents/b.toml",
      "created .oxagen/rules/a.md",
      "Pulled 2 files from acme/steering@0123456 (main).",
    ]);
    const stored = readWorkspaceLink(dir);
    expect(stored?.pull).toMatchObject({
      commit: HEAD,
      bindingId: "rpb_abc",
      fullName: "acme/steering",
      files: {
        ".oxagen/rules/a.md": sha256("A"),
        ".oxagen/agents/b.toml": sha256("B"),
      },
    });
    // The link keeps what it had.
    expect(stored?.orgSlug).toBe("acme");
    expect(mockReport).toHaveBeenCalledWith({
      root: dir,
      scope: { org: "acme", ws: "payments" },
      event: "pull",
      pulledCommit: HEAD,
    });
  });

  it("passes --binding through and says when nothing changed", async () => {
    link();
    mkdirSync(join(dir, ".oxagen", "rules"), { recursive: true });
    writeFileSync(join(dir, ".oxagen", "rules", "a.md"), "A");
    mockPost.mockResolvedValue(
      published([{ path: ".oxagen/rules/a.md", content: "A" }]),
    );
    await pull({ binding: "rpb_abc" }, writer, dir);
    expect(mockPost.mock.calls[0]?.[1]).toEqual({ bindingId: "rpb_abc" });
    expect(out).toEqual([
      "Already up to date with acme/steering@0123456 (main).",
    ]);
    expect(process.exitCode).toBeUndefined();
  });

  it("refuses the whole pull on a conflict and writes nothing", async () => {
    link();
    mkdirSync(join(dir, ".oxagen", "rules"), { recursive: true });
    writeFileSync(join(dir, ".oxagen", "rules", "a.md"), "mine");
    mockPost.mockResolvedValue(
      published([
        { path: ".oxagen/rules/a.md", content: "theirs" },
        { path: ".oxagen/rules/new.md", content: "new" },
      ]),
    );
    await pull({}, writer, dir);
    expect(process.exitCode).toBe(1);
    expect(out).toEqual(["conflict .oxagen/rules/a.md"]);
    expect(err.join("\n")).toContain("oxagen pull --force");
    expect(read(".oxagen/rules/a.md")).toBe("mine");
    expect(existsSync(join(dir, ".oxagen", "rules", "new.md"))).toBe(false);
    expect(readWorkspaceLink(dir)?.pull).toBeUndefined();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("overwrites a conflict with --force", async () => {
    link();
    mkdirSync(join(dir, ".oxagen", "rules"), { recursive: true });
    writeFileSync(join(dir, ".oxagen", "rules", "a.md"), "mine");
    mockPost.mockResolvedValue(
      published([{ path: ".oxagen/rules/a.md", content: "theirs" }]),
    );
    await pull({ force: true }, writer, dir);
    expect(process.exitCode).toBeUndefined();
    expect(read(".oxagen/rules/a.md")).toBe("theirs");
    expect(out[0]).toBe("updated .oxagen/rules/a.md");
  });

  it("deletes a file it wrote that is no longer published, and prunes its directory", async () => {
    link();
    mockPost.mockResolvedValue(
      published([
        { path: ".oxagen/rules/a.md", content: "A" },
        { path: ".oxagen/old/b.md", content: "B" },
      ]),
    );
    await pull({}, writer, dir);
    out.length = 0;
    mockPost.mockResolvedValue(
      published([{ path: ".oxagen/rules/a.md", content: "A" }]),
    );
    await pull({}, writer, dir);
    expect(existsSync(join(dir, ".oxagen", "old"))).toBe(false);
    expect(out).toEqual([
      "deleted .oxagen/old/b.md",
      "Pulled 0 files from acme/steering@0123456 (main), deleted 1.",
    ]);
    expect(Object.keys(readWorkspaceLink(dir)?.pull?.files ?? {})).toEqual([
      ".oxagen/rules/a.md",
    ]);
  });

  it("prints the plan on --dry-run and writes nothing", async () => {
    link();
    mockPost.mockResolvedValue(
      published([{ path: ".oxagen/rules/a.md", content: "A" }]),
    );
    await pull({ dryRun: true }, writer, dir);
    expect(out).toEqual([
      "would create .oxagen/rules/a.md",
      "Dry run: would pull 1 file and delete 0 from acme/steering@0123456 (main). Nothing was written.",
    ]);
    expect(existsSync(join(dir, ".oxagen", "rules"))).toBe(false);
    expect(readWorkspaceLink(dir)?.pull).toBeUndefined();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("prints one JSON line with --json", async () => {
    link();
    mockPost.mockResolvedValue(
      published([{ path: ".oxagen/rules/a.md", content: "A" }]),
    );
    await pull({ json: true }, writer, dir);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      status: "pulled",
      repository: "acme/steering",
      head: HEAD,
      created: [".oxagen/rules/a.md"],
      updated: [],
      deleted: [],
      conflicts: [],
      workingCopy: { workingCopyId: "wcp_1" },
    });
  });

  it("prints the dry-run plan as JSON", async () => {
    link();
    mockPost.mockResolvedValue(
      published([{ path: ".oxagen/rules/a.md", content: "A" }]),
    );
    await pull({ json: true, dryRun: true }, writer, dir);
    expect(JSON.parse(out[0]!)).toMatchObject({
      status: "dry_run",
      created: [".oxagen/rules/a.md"],
    });
  });

  it("refuses unsafe paths, even with --force, and writes nothing", async () => {
    link();
    mockPost.mockResolvedValue(
      published([
        { path: ".oxagen/rules/a.md", content: "A" },
        { path: ".oxagen/../escape.md", content: "x" },
      ]),
    );
    await pull({ force: true, json: true }, writer, dir);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({
      status: "refused",
      refusal: "unsafe_paths",
    });
    expect(existsSync(join(dir, ".oxagen", "rules"))).toBe(false);
    expect(existsSync(join(dir, "escape.md"))).toBe(false);
  });

  it("refuses to write through a symlink that leaves .oxagen/", async () => {
    link();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(dir, ".oxagen", "rules"));
    mockPost.mockResolvedValue(
      published([{ path: ".oxagen/rules/a.md", content: "A" }]),
    );
    await pull({}, writer, dir);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("resolves outside .oxagen/");
    expect(existsSync(join(outside, "a.md"))).toBe(false);
  });

  it("refuses when the production branch is gone", async () => {
    link();
    mockPost.mockResolvedValue(published([], null));
    await pull({}, writer, dir);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("production branch main");
  });

  it("exits 1 on an API failure", async () => {
    link();
    mockPost.mockRejectedValue(
      new Error("Error 409 from x: main_repo_unbound"),
    );
    await pull({}, writer, dir);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("main_repo_unbound");
  });

  it("warns and still succeeds when the report fails", async () => {
    link();
    mockReport.mockResolvedValue({ error: "Error 404 from working-copies" });
    mockPost.mockResolvedValue(
      published([{ path: ".oxagen/rules/a.md", content: "A" }]),
    );
    await pull({}, writer, dir);
    expect(process.exitCode).toBeUndefined();
    expect(err).toEqual([
      "Warning: could not report this directory to Oxagen: Error 404 from working-copies",
    ]);
  });
});

describe("findLinkedRoot", () => {
  it("returns null when no link is above", () => {
    expect(findLinkedRoot(dir)).toBeNull();
  });
});
