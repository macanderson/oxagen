/**
 * The git-aware half of the Atlas migration lint (#3387).
 *
 * `checkAtlasBaseline()` compares the CURRENT working-tree file set against
 * two historical snapshots read through `atlasFilesAtRef()`, so every test
 * here supplies a fake `GitRunner` rather than touching the real git object
 * store: `mergeBaseOf` and `atlasFilesAtRef` are exercised only through the
 * function they are injected into, which is what a caller actually sees.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  atlasVersionOf,
  checkAtlasBaseline,
  maxAtlasVersion,
  mergeBaseOf,
  atlasFilesAtRef,
  type GitRunner,
} from "./db-lint-migrations";

const MERGE_BASE_SHA = "c3e8dc704eaf843b24d59274cb63954d85fe1107";

/**
 * A fake `GitRunner` driven by a lookup table keyed on the joined argv, plus
 * `merge-base` handled directly from a fixed SHA. Any call outside the table
 * throws, the same shape a real `execFileSync` failure takes, so the "no
 * history" tests exercise the same code path a shallow clone would hit.
 */
function fakeGit(opts: {
  mergeBase?: string | null;
  atRef?: Record<string, readonly string[]>;
}): GitRunner {
  return (args: string[]): string => {
    if (args[0] === "merge-base") {
      if (opts.mergeBase === null || opts.mergeBase === undefined) {
        throw new Error("fatal: no merge base");
      }
      return `${opts.mergeBase}\n`;
    }
    if (args[0] === "ls-tree") {
      const spec = args[2]!; // "ls-tree", "--name-only", "<ref>:<path>"
      const ref = spec.split(":")[0]!;
      const files = opts.atRef?.[ref];
      if (files === undefined) throw new Error(`fatal: unknown ref ${ref}`);
      return files.join("\n");
    }
    throw new Error(`unmocked git command: ${args.join(" ")}`);
  };
}

describe("atlasVersionOf and maxAtlasVersion", () => {
  it("reads the 14-digit prefix from a well-formed name", () => {
    expect(atlasVersionOf("20260918200000_repository_binding_heads.sql")).toBe(
      "20260918200000",
    );
  });

  it("rejects a name with no valid prefix", () => {
    expect(atlasVersionOf("atlas.sum")).toBeNull();
    expect(atlasVersionOf("not_a_migration.sql")).toBeNull();
  });

  it("finds the highest version in a set, ignoring malformed names", () => {
    expect(
      maxAtlasVersion([
        "20260918040000_a.sql",
        "20260918200000_b.sql",
        "20260918090000_c.sql",
        "atlas.sum",
      ]),
    ).toBe("20260918200000");
  });

  it("returns null for an empty or all-malformed set", () => {
    expect(maxAtlasVersion([])).toBeNull();
    expect(maxAtlasVersion(["atlas.sum"])).toBeNull();
  });
});

describe("checkAtlasBaseline: (a) a correctly stamped new migration", () => {
  it("passes with no errors or warnings", () => {
    const run = fakeGit({
      mergeBase: "base-sha",
      atRef: {
        "base-sha": ["20260918200000_earlier.sql"],
        "origin/main": ["20260918200000_earlier.sql"],
      },
    });
    const currentFiles = [
      "20260918200000_earlier.sql",
      "20260919120000_new_migration.sql",
    ];
    const result = checkAtlasBaseline(currentFiles, { run });
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("checkAtlasBaseline: (b) stamped behind the merge base", () => {
  it("fails, naming the file, its stamp, and the baseline maximum", () => {
    const run = fakeGit({
      mergeBase: "base-sha",
      atRef: {
        "base-sha": ["20260918040000_a.sql", "20260918200000_b.sql"],
        "origin/main": [
          "20260918040000_a.sql",
          "20260918200000_b.sql",
          "20260918210100_c.sql",
        ],
      },
    });
    const currentFiles = [
      "20260918040000_a.sql",
      "20260918200000_b.sql",
      "20260918161000_stale.sql",
    ];
    const result = checkAtlasBaseline(currentFiles, { run });
    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([]);
    expect(result.errors).toHaveLength(1);
    const message = result.errors[0]!;
    expect(message).toContain("20260918161000_stale.sql");
    expect(message).toContain("20260918161000"); // its own stamp
    expect(message).toContain("20260918200000"); // the baseline maximum
    expect(message).toContain("atlas migrate hash");
  });

  it("also fails when the stamp exactly equals the baseline maximum", () => {
    // "at or before", not only "before": two files claiming the same version
    // is the collision lintAtlas() already rejects, and this check must not
    // read an exact tie as clear.
    const run = fakeGit({
      mergeBase: "base-sha",
      atRef: {
        "base-sha": ["20260918200000_b.sql"],
        "origin/main": ["20260918200000_b.sql"],
      },
    });
    const result = checkAtlasBaseline(
      ["20260918200000_b.sql", "20260918200000_tie.sql"],
      { run },
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("20260918200000_tie.sql");
  });
});

describe("checkAtlasBaseline: (c) stamped between the merge base and the current head", () => {
  it("warns, and does not fail", () => {
    // The long-lived-branch case: correct against the merge base, but
    // origin/main has moved past it by the time the check runs.
    const run = fakeGit({
      mergeBase: "base-sha",
      atRef: {
        "base-sha": ["20260918040000_a.sql"],
        "origin/main": [
          "20260918040000_a.sql",
          "20260919000000_landed_after_branch_cut.sql",
        ],
      },
    });
    const currentFiles = [
      "20260918040000_a.sql",
      "20260918230000_new_but_now_behind_main.sql",
    ];
    const result = checkAtlasBaseline(currentFiles, { run });
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(
      "20260918230000_new_but_now_behind_main.sql",
    );
    expect(result.warnings[0]).toContain("cleared its merge base");
  });
});

describe("checkAtlasBaseline: (d) a rebase or merge carrying a file forward", () => {
  it("does not flag a migration already present at the merge base as new", () => {
    // "Added" is a file-SET diff against the merge base, not a line diff, so
    // a file the merge base already has is never reported, no matter how the
    // branch's own commit history got there.
    const run = fakeGit({
      mergeBase: "base-sha",
      atRef: {
        "base-sha": ["20260918040000_inherited.sql", "20260918200000_b.sql"],
        "origin/main": ["20260918040000_inherited.sql", "20260918200000_b.sql"],
      },
    });
    // The working tree lists the inherited file too (a rebase replays it, it
    // does not delete and recreate it), plus one genuinely new migration.
    const currentFiles = [
      "20260918040000_inherited.sql",
      "20260918200000_b.sql",
      "20260919120000_genuinely_new.sql",
    ];
    const result = checkAtlasBaseline(currentFiles, { run });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("checkAtlasBaseline: (e) no usable git history", () => {
  it("degrades honestly on a shallow clone: no throw, no silent pass", () => {
    const run = fakeGit({ mergeBase: null });
    const result = checkAtlasBaseline(["20260919120000_x.sql"], { run });
    expect(result.status).toBe("degraded");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.note).toBeTruthy();
    expect(result.note).toContain("merge-base");
    expect(result.note).toContain("shallow clone");
  });

  it("degrades honestly when the merge base resolves but its tree does not", () => {
    // A merge base whose commit exists but whose tree lookup fails (an
    // unusual repack state, or a `baseRef` fetched with `--filter=blob:none`
    // that dropped the tree) is the same "cannot answer" shape as no merge
    // base at all, and gets the same non-silent treatment.
    const run = fakeGit({ mergeBase: "unreadable-sha", atRef: {} });
    const result = checkAtlasBaseline(["20260919120000_x.sql"], { run });
    expect(result.status).toBe("degraded");
    expect(result.note).toContain("unreadable-sha");
  });

  it("never throws, whatever git does", () => {
    const throwing: GitRunner = () => {
      throw new Error("git: command not found");
    };
    expect(() =>
      checkAtlasBaseline(["20260919120000_x.sql"], { run: throwing }),
    ).not.toThrow();
  });
});

describe("mergeBaseOf and atlasFilesAtRef directly", () => {
  it("mergeBaseOf trims the runner's output", () => {
    const run: GitRunner = () => "abc123\n";
    expect(mergeBaseOf("HEAD", "origin/main", run)).toBe("abc123");
  });

  it("mergeBaseOf returns null rather than throwing on a failing runner", () => {
    const run: GitRunner = () => {
      throw new Error("fatal");
    };
    expect(mergeBaseOf("HEAD", "origin/main", run)).toBeNull();
  });

  it("atlasFilesAtRef filters to .sql and drops blank lines", () => {
    const run: GitRunner = () =>
      "20260918200000_b.sql\natlas.sum\n\n20260918040000_a.sql\n";
    const files = atlasFilesAtRef("some-ref", run);
    expect(files).toEqual(["20260918200000_b.sql", "20260918040000_a.sql"]);
  });

  it("atlasFilesAtRef returns null rather than throwing on a failing runner", () => {
    const run: GitRunner = () => {
      throw new Error("fatal: not a tree");
    };
    expect(atlasFilesAtRef("some-ref", run)).toBeNull();
  });
});

describe("the real #3337 incident, reproduced from its actual merge base", () => {
  // #3387's DoD asks for this verified against the real case rather than only
  // an invented one. The commit history for PR #3337 (macanderson/oxagen) is
  // not fetched by CI's shallow, main-only checkout for this PR, so this test
  // does not run live git commands against that history; it reproduces the
  // exact fixture this check would have read had it existed then, taken from
  // inspecting that history directly in this session:
  //
  //   git merge-base e779efa49 08b8996ee
  //     -> c3e8dc704eaf843b24d59274cb63954d85fe1107
  //   git ls-tree --name-only c3e8dc704:packages/database/atlas/migrations
  //     -> highest stamp 20260918200000
  //     (20260918210000 and 20260918210100 landed on origin/main AFTER this
  //     branch's merge base, which is why the issue names 20260918210100 as
  //     the head main carried by the time the PR was reviewed, while this
  //     test asserts the stronger, earlier-firing merge-base failure)
  //   git diff --name-only (file-set) between the merge base and the branch
  //   commit that carried the migration
  //     -> adds exactly one file: 20260918161000_user_preferences_timezone_pacific.sql
  //
  // 20260918161000 sorts before 20260918200000, so the merge-base comparison
  // alone would have failed this PR, days before the review that actually
  // caught it.
  it("fails the migration PR #3337 actually shipped, at its real merge base", () => {
    const mergeBaseFiles = [
      "20260918040000_repository_main_binding_is_exclusive.sql",
      "20260918090000_model_credentials_any_openai_compatible.sql",
      "20260918120000_meter_carry_per_billing_reason.sql",
      "20260918140000_data_planes_graph_database.sql",
      "20260918160000_context_record_versions_classification.sql",
      "20260918170000_run_replay_chain_and_run_scoped_approvals.sql",
      "20260918200000_repository_binding_heads_exclusive_across_roles.sql",
    ];
    const run = fakeGit({
      mergeBase: MERGE_BASE_SHA,
      atRef: {
        [MERGE_BASE_SHA]: mergeBaseFiles,
        "origin/main": [
          ...mergeBaseFiles,
          "20260918201000_price_entries_override_is_platform_owned.sql",
          "20260918203000_price_entries_catalog_provenance.sql",
          "20260918210000_tacho_sessions_runtime_cursor.sql",
          "20260918210100_agents_harness_codex_cursor.sql",
        ],
      },
    });
    const currentFiles = [
      ...mergeBaseFiles,
      "20260918161000_user_preferences_timezone_pacific.sql",
    ];

    const result = checkAtlasBaseline(currentFiles, {
      headRef: "e779efa49",
      baseRef: "origin/main",
      run,
    });

    expect(result.status).toBe("ok");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(
      "20260918161000_user_preferences_timezone_pacific.sql",
    );
    expect(result.errors[0]).toContain("20260918161000");
    expect(result.errors[0]).toContain("20260918200000");
  });
});

describe("headRef, and CI's synthetic pull_request merge commit", () => {
  // A Codex P2 review finding on the PR that added this check: actions/checkout
  // on a pull_request event checks out GitHub's synthetic merge ref
  // (refs/pull/N/merge) by default, so plain "HEAD" in CI is a merge commit
  // descended from origin/main's CURRENT tip, not the PR branch's own tip.
  // `git merge-base HEAD origin/main` then degenerates to origin/main's tip
  // (an ancestor of the merge commit is its own merge-base with anything it is
  // already an ancestor of), collapsing the fail/warn distinction into one
  // tier: every added migration is judged only against the moving target the
  // WARN case exists to protect against.

  /**
   * A `GitRunner` where `merge-base`'s answer depends on which head ref is
   * passed, the way real `git merge-base` does: the synthetic merge commit
   * ("HEAD") is already a descendant of origin/main's current tip, so a
   * merge-base against it returns that tip; the actual PR head ("pr-head")
   * returns the branch's real, earlier divergence point.
   */
  function ciShapedGit(): GitRunner {
    const atRef: Record<string, readonly string[]> = {
      "divergence-sha": ["20260918040000_a.sql", "20260918200000_b.sql"],
      "main-tip-sha": [
        "20260918040000_a.sql",
        "20260918200000_b.sql",
        "20260918230000_landed_after_branch_cut.sql",
      ],
      "origin/main": [
        "20260918040000_a.sql",
        "20260918200000_b.sql",
        "20260918230000_landed_after_branch_cut.sql",
      ],
    };
    return (args: string[]): string => {
      if (args[0] === "merge-base") {
        const headRef = args[1];
        return headRef === "HEAD" ? "main-tip-sha\n" : "divergence-sha\n";
      }
      if (args[0] === "ls-tree") {
        const spec = args[2]!;
        const ref = spec.split(":")[0]!;
        const files = atRef[ref];
        if (files === undefined) throw new Error(`fatal: unknown ref ${ref}`);
        return files.join("\n");
      }
      throw new Error(`unmocked git command: ${args.join(" ")}`);
    };
  }

  // A migration that cleared the branch's real merge base (200000) but has
  // since fallen behind origin/main's moved tip (230000): the WARN case.
  const currentFiles = [
    "20260918040000_a.sql",
    "20260918200000_b.sql",
    "20260918210000_correctly_stamped_when_written.sql",
  ];

  it('documents the bug: left at the default "HEAD", the merge-base check misfires FAIL', () => {
    const result = checkAtlasBaseline(currentFiles, { run: ciShapedGit() });
    expect(result.status).toBe("ok");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(
      "20260918210000_correctly_stamped_when_written.sql",
    );
    expect(result.warnings).toEqual([]);
  });

  it("is fixed by passing the real PR head as headRef: WARN, not FAIL", () => {
    const result = checkAtlasBaseline(currentFiles, {
      headRef: "pr-head",
      run: ciShapedGit(),
    });
    expect(result.status).toBe("ok");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(
      "20260918210000_correctly_stamped_when_written.sql",
    );
    expect(result.warnings[0]).toContain("cleared its merge base");
  });

  describe("DB_LINT_HEAD_REF, the env var CI sets to the real PR head", () => {
    const ORIGINAL = process.env.DB_LINT_HEAD_REF;

    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.DB_LINT_HEAD_REF;
      else process.env.DB_LINT_HEAD_REF = ORIGINAL;
    });

    it("is used when opts.headRef is not supplied", () => {
      process.env.DB_LINT_HEAD_REF = "pr-head";
      const result = checkAtlasBaseline(currentFiles, { run: ciShapedGit() });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it("an empty string falls back to HEAD rather than being read as a ref", () => {
      // GitHub Actions expands github.event.pull_request.head.sha to an
      // empty string on a push event, where the workflow step still sets
      // DB_LINT_HEAD_REF: an empty ref is not a request for a different one.
      process.env.DB_LINT_HEAD_REF = "";
      const result = checkAtlasBaseline(currentFiles, { run: ciShapedGit() });
      expect(result.errors).toHaveLength(1); // the "HEAD" (buggy) path
    });

    it("opts.headRef wins over the env var", () => {
      process.env.DB_LINT_HEAD_REF = "HEAD";
      const result = checkAtlasBaseline(currentFiles, {
        headRef: "pr-head",
        run: ciShapedGit(),
      });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });
  });
});

describe("exact historical migration restoration", () => {
  const restored = "20260920170000_workspace_nullable_writes.sql";
  const newer = "20260920200000_approval_resume.sql";
  const path = `packages/database/atlas/migrations/${restored}`;
  const original = "a".repeat(40);
  const deleted = "d".repeat(40);
  const blob = "b".repeat(40);

  function historicalGit(
    mode: "exact" | "modified" | "new" | "branch-only" | "unavailable",
  ): GitRunner {
    const baseline = fakeGit({
      mergeBase: MERGE_BASE_SHA,
      atRef: {
        [MERGE_BASE_SHA]: [newer],
        "origin/main": [newer],
      },
    });
    return (args) => {
      if (args[0] === "hash-object") {
        expect(args).toEqual(["hash-object", "--no-filters", "--", path]);
        return mode === "modified" ? "c".repeat(40) : blob;
      }
      if (args[0] === "log") {
        expect(args).toEqual([
          "log",
          "--format=%H",
          "--full-history",
          MERGE_BASE_SHA,
          "--",
          path,
        ]);
        if (mode === "unavailable") throw new Error("Missing history");
        // A matching branch-only blob cannot appear in merge-base ancestry.
        return mode === "new" || mode === "branch-only"
          ? ""
          : `${deleted}\n${original}\n`;
      }
      if (args[0] === "rev-parse") {
        if (args[3] === `${deleted}:${path}`) throw new Error("Deleted path");
        expect(args).toEqual([
          "rev-parse",
          "--verify",
          "--quiet",
          `${original}:${path}`,
        ]);
        return blob;
      }
      return baseline(args);
    };
  }

  it("accepts identical bytes at the same path in merge-base ancestry", () => {
    const result = checkAtlasBaseline([restored, newer], {
      run: historicalGit("exact"),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("does not prove");
  });

  it.each(["modified", "new", "branch-only", "unavailable"] as const)(
    "still refuses %s backdated SQL",
    (mode) => {
      const result = checkAtlasBaseline([restored, newer], {
        run: historicalGit(mode),
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(restored);
    },
  );
});
