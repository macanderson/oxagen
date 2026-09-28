/**
 * Tests for the capability schema docs renderer and its `--check`.
 *
 * Two issues are proved here rather than asserted:
 *
 * - #3148: the negative proof. Change one contract's `describe()` text without
 *   regenerating, and the check fails naming that file and both values. Then
 *   regenerate, and it passes.
 * - #3691: two branches that each add a capability merge to `main` with no
 *   conflict in `_index.json` or `README.md`, shown with `git merge` in a real
 *   temporary repository. A control case keeps the old shape, with its count
 *   lines, and shows the same two branches conflicting, so the test cannot
 *   pass for a reason other than the change it guards.
 *
 * The capabilities are synthetic. Their schemas are hand-built Zod v3 `_def`
 * trees, because Zod's `.describe("text")` does exactly one thing to a schema:
 * it sets `_def.description`. That is the field the converter reads, so
 * editing it here is the same edit as editing a contract's `describe()`.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REGENERATE_COMMAND,
  diffSchemaDocs,
  firstDifference,
  formatCheckReport,
  renderSchemaDocs,
  writeSchemaDocs,
  type CapabilityDocSource,
} from "./capability-schema-docs";
import type { ZodLike } from "./zod-json-schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A Zod v3 object schema with one string field carrying `describe(text)`. */
function objectWithDescribedField(field: string, text: string): ZodLike {
  return {
    _def: {
      typeName: "ZodObject",
      shape: () => ({
        [field]: { _def: { typeName: "ZodString", description: text } },
      }),
    },
  };
}

const EMPTY_OBJECT: ZodLike = {
  _def: { typeName: "ZodObject", shape: () => ({}) },
};

function cap(
  name: string,
  domain: string,
  input: ZodLike = EMPTY_OBJECT,
): CapabilityDocSource {
  return {
    name,
    domain,
    description: `The ${name} capability.`,
    mode: "sync",
    sensitivity: "low",
    input,
    output: EMPTY_OBJECT,
    chain: { produces: [], consumes: [], chainHints: [] },
    render: null,
  };
}

/** A registry with three domains, several capabilities in `agent`. */
function baseRegistry(): CapabilityDocSource[] {
  return [
    cap("assign_agent_role", "agent"),
    cap("get_agent", "agent"),
    cap("list_agents", "agent"),
    cap("pause_agent", "agent"),
    cap("update_agent", "agent"),
    cap("create_api_key", "api_key"),
    cap("revoke_api_key", "api_key"),
    cap("get_run", "run"),
    cap("list_runs", "run"),
  ];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("renderSchemaDocs", () => {
  it("is byte-stable across runs and input orders", () => {
    const a = renderSchemaDocs(baseRegistry());
    const b = renderSchemaDocs([...baseRegistry()].reverse());
    expect([...b.entries()]).toEqual([...a.entries()]);
  });

  it("writes one JSON file per capability plus the index and README", () => {
    const files = renderSchemaDocs(baseRegistry());
    expect([...files.keys()].sort()).toEqual(
      [
        ...baseRegistry().map((c) => `${c.name}.json`),
        "README.md",
        "_index.json",
      ].sort(),
    );
  });

  it("keeps no whole-set count in _index.json (ADR-214)", () => {
    const index = JSON.parse(
      renderSchemaDocs(baseRegistry()).get("_index.json") ?? "",
    ) as Record<string, unknown>;
    expect(Object.keys(index)).toEqual(["capabilities"]);
    expect(index).not.toHaveProperty("generatedCount");
    expect((index.capabilities as unknown[]).length).toBe(
      baseRegistry().length,
    );
  });

  it("keeps no count and no joined name list in README.md (ADR-214)", () => {
    const readme = renderSchemaDocs(baseRegistry()).get("README.md") ?? "";
    // No total, no per-domain count, and each capability on its own line.
    expect(readme).not.toMatch(/\*\*\d+ capabilities\*\*/);
    expect(readme).not.toMatch(/\(\d+\)/);
    expect(readme).toContain("## agent\n\n- assign_agent_role\n- get_agent\n");
    for (const c of baseRegistry()) {
      expect(readme.split("\n")).toContain(`- ${c.name}`);
    }
  });

  it("publishes a field's describe() text in the capability's schema", () => {
    const files = renderSchemaDocs([
      cap("get_run", "run", objectWithDescribedField("runId", "The run.")),
    ]);
    const doc = JSON.parse(files.get("get_run.json") ?? "") as {
      input: { properties: { runId: { description: string } } };
    };
    expect(doc.input.properties.runId.description).toBe("The run.");
  });
});

describe("firstDifference", () => {
  it("returns null for equal texts", () => {
    expect(firstDifference("a\nb\n", "a\nb\n")).toBeNull();
  });

  it("names the line and both values", () => {
    expect(firstDifference("a\nb\nc\n", "a\nB\nc\n")).toEqual({
      line: 2,
      committed: "b",
      regenerated: "B",
    });
  });

  it("reports the end of a shorter file as null", () => {
    expect(firstDifference("a\n", "a\nb\n")).toEqual({
      line: 2,
      committed: "",
      regenerated: "b",
    });
    expect(firstDifference("a", "a\nb")).toEqual({
      line: 2,
      committed: null,
      regenerated: "b",
    });
  });
});

// ---------------------------------------------------------------------------
// --check against a directory: the negative proof for #3148
// ---------------------------------------------------------------------------

describe("--check against a directory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "capability-schema-docs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function registry(describeText: string): CapabilityDocSource[] {
    return [
      ...baseRegistry().filter((c) => c.name !== "get_run"),
      cap("get_run", "run", objectWithDescribedField("runId", describeText)),
    ];
  }

  it("fails on an edited describe(), naming the file and both values, then passes once regenerated", () => {
    // The committed directory, generated from the contract as it was.
    const committed = renderSchemaDocs(registry("The run to read."));
    writeSchemaDocs(committed, dir);
    expect(formatCheckReport(diffSchemaDocs(committed, dir))).toBeNull();

    // A contract's describe() changes and nobody regenerates.
    const edited = renderSchemaDocs(registry("The id of the run to read."));
    const diff = diffSchemaDocs(edited, dir);
    expect(diff.stale.map((s) => s.file)).toEqual(["get_run.json"]);
    expect(diff.orphans).toEqual([]);

    const [stale] = diff.stale;
    expect(stale?.difference.committed).toContain(
      '"description": "The run to read."',
    );
    expect(stale?.difference.regenerated).toContain(
      '"description": "The id of the run to read."',
    );
    const report = formatCheckReport(diff) ?? "";
    expect(report).toContain("get_run.json, first difference at line");
    expect(report).toContain("The run to read.");
    expect(report).toContain("The id of the run to read.");
    expect(report).toContain(REGENERATE_COMMAND);
    expect(REGENERATE_COMMAND).toBe("pnpm docs:schemas");

    // Regenerate, and the check passes.
    writeSchemaDocs(edited, dir);
    expect(diffSchemaDocs(edited, dir)).toEqual({ stale: [], orphans: [] });
    expect(formatCheckReport(diffSchemaDocs(edited, dir))).toBeNull();
  });

  it("names a hand-edited count in _index.json with both values", () => {
    // The wrong merge resolution #3691 describes: one side's copy kept.
    const files = renderSchemaDocs(baseRegistry());
    writeSchemaDocs(files, dir);
    writeFileSync(
      join(dir, "_index.json"),
      (files.get("_index.json") ?? "").replace(
        "{\n",
        '{\n  "generatedCount": 338,\n',
      ),
    );
    const report = formatCheckReport(diffSchemaDocs(files, dir)) ?? "";
    expect(report).toContain("_index.json, first difference at line 2");
    expect(report).toContain('committed:   "  \\"generatedCount\\": 338,"');
    expect(report).toContain('regenerated: "  \\"capabilities\\": ["');
  });

  it("reports a missing file", () => {
    const files = renderSchemaDocs(baseRegistry());
    writeSchemaDocs(files, dir);
    rmSync(join(dir, "get_run.json"));
    const diff = diffSchemaDocs(files, dir);
    expect(diff.stale).toEqual([
      expect.objectContaining({ file: "get_run.json", exists: false }),
    ]);
    expect(formatCheckReport(diff)).toContain("get_run.json, missing");
  });

  it("reports an orphan in check mode without deleting it, and a plain run deletes it", () => {
    const files = renderSchemaDocs(baseRegistry());
    writeSchemaDocs(files, dir);
    writeFileSync(join(dir, "list_workspace_members.json"), "{}\n");

    const diff = diffSchemaDocs(files, dir);
    expect(diff).toEqual({
      stale: [],
      orphans: ["list_workspace_members.json"],
    });
    expect(formatCheckReport(diff)).toContain("list_workspace_members.json");
    expect(readdirSync(dir)).toContain("list_workspace_members.json");

    expect(writeSchemaDocs(files, dir)).toEqual([
      "list_workspace_members.json",
    ]);
    expect(readdirSync(dir)).not.toContain("list_workspace_members.json");
  });

  it("treats a missing directory as every file missing, not a crash", () => {
    const diff = diffSchemaDocs(
      renderSchemaDocs(baseRegistry()),
      join(dir, "absent"),
    );
    expect(diff.orphans).toEqual([]);
    expect(diff.stale.every((s) => !s.exists)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Two branches, one merge: #3691
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** `git merge` that reports success instead of throwing on a conflict. */
function tryMerge(cwd: string, branch: string): boolean {
  try {
    git(cwd, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "merge",
      "--no-edit",
      "-q",
      branch,
    ]);
    return true;
  } catch {
    return false;
  }
}

function commitFiles(
  cwd: string,
  files: ReadonlyMap<string, string>,
  message: string,
): void {
  for (const [file, contents] of files)
    writeFileSync(join(cwd, file), contents);
  git(cwd, ["add", "-A"]);
  git(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

/**
 * The old output shape, before ADR-214: `generatedCount` in the index and the
 * count and joined-list lines in the README. Rebuilt from the new output so
 * the control differs from the real case only in those lines.
 */
function withLegacyCounts(
  files: Map<string, string>,
  caps: readonly CapabilityDocSource[],
): Map<string, string> {
  const out = new Map(files);
  const index = JSON.parse(files.get("_index.json") ?? "") as {
    capabilities: unknown[];
  };
  out.set(
    "_index.json",
    JSON.stringify(
      { generatedCount: caps.length, capabilities: index.capabilities },
      null,
      2,
    ) + "\n",
  );
  const byDomain = new Map<string, string[]>();
  for (const c of [...caps].sort((a, b) => a.name.localeCompare(b.name))) {
    byDomain.set(c.domain, [...(byDomain.get(c.domain) ?? []), c.name]);
  }
  out.set(
    "README.md",
    [
      `# Capability JSON Schemas`,
      ``,
      `**${caps.length} capabilities** across ${byDomain.size} domains.`,
      ``,
      ...[...byDomain.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(
          ([d, names]) => `- **${d}** (${names.length}): ${names.join(", ")}`,
        ),
      ``,
    ].join("\n"),
  );
  return out;
}

describe("two branches that each add a capability", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "capability-schema-merge-"));
    git(repo, ["init", "-q", "-b", "main"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  // Branch A adds a capability early in the `agent` domain and branch B one
  // late in the same domain, the case that shares the most lines: same
  // domain, same README section, same index array. B also adds one to
  // `api_key`, so the two branches add different numbers of capabilities, as
  // #3622 and `main` did (338 against 340). Two branches that each add one
  // would write the same count, and git takes an identical change on both
  // sides silently, leaving a count one short: wrong, but not a conflict.
  const branchA = [cap("delete_agent", "agent")];
  const branchB = [
    cap("resume_agent", "agent"),
    cap("rotate_api_key", "api_key"),
  ];

  function runMerge(
    render: (caps: CapabilityDocSource[]) => Map<string, string>,
  ): boolean {
    const base = baseRegistry();
    commitFiles(repo, render(base), "base");
    git(repo, ["checkout", "-q", "-b", "a"]);
    commitFiles(repo, render([...base, ...branchA]), "a: add delete_agent");
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["checkout", "-q", "-b", "b"]);
    commitFiles(repo, render([...base, ...branchB]), "b: add two");
    git(repo, ["checkout", "-q", "main"]);
    // A merges first, then B merges into the main that already holds A.
    expect(tryMerge(repo, "a")).toBe(true);
    return tryMerge(repo, "b");
  }

  it("merge cleanly, and the merged tree is what regenerating the merged registry writes", () => {
    expect(runMerge(renderSchemaDocs)).toBe(true);

    const expected = renderSchemaDocs([
      ...baseRegistry(),
      ...branchA,
      ...branchB,
    ]);
    for (const [file, contents] of expected) {
      const merged = readFileSync(join(repo, file), "utf8");
      expect(merged).not.toContain("<<<<<<<");
      expect(merged, file).toBe(contents);
    }
    // And `--check` agrees the merged directory is current.
    expect(diffSchemaDocs(expected, repo)).toEqual({ stale: [], orphans: [] });
  });

  it("conflicted under the old shape with its count lines (control)", () => {
    expect(
      runMerge((caps) => withLegacyCounts(renderSchemaDocs(caps), caps)),
    ).toBe(false);
    const status = git(repo, ["diff", "--name-only", "--diff-filter=U"]);
    expect(status.split("\n").sort()).toEqual(["README.md", "_index.json"]);
  });
});
