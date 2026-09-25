/**
 * The guard for #2978: a third-party action referenced by a moving tag runs
 * whatever code its owner points that tag at, with this repository's secrets.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findUnpinned,
  pinProblem,
  workflowFiles,
} from "./check-action-pins.mjs";

const SHA = "b906affcce14559ad1aafd4ab0e942779e9f58b1";

describe("pinProblem", () => {
  it("accepts a third-party action pinned to a commit SHA", () => {
    expect(pinProblem(`pnpm/action-setup@${SHA}`)).toBeNull();
  });

  it("rejects a moving tag, a branch and a short SHA", () => {
    expect(pinProblem("pnpm/action-setup@v4")).toMatch(/not a 40-character/);
    expect(pinProblem("dtolnay/rust-toolchain@stable")).toMatch(
      /not a 40-character/,
    );
    expect(pinProblem("docker/login-action@c94ce9f")).toMatch(
      /not a 40-character/,
    );
  });

  it("rejects a reference with no version", () => {
    expect(pinProblem("someone/action")).toMatch(/default branch/);
  });

  it("exempts first-party actions, local paths and our reusable workflows", () => {
    expect(pinProblem("actions/checkout@v4")).toBeNull();
    expect(pinProblem("github/codeql-action/init@v3")).toBeNull();
    expect(pinProblem("./.github/actions/pnpm-install")).toBeNull();
    expect(
      pinProblem("macanderson/oxagen/.github/workflows/dod-check.yml@main"),
    ).toBeNull();
  });

  it("requires a digest on a docker image", () => {
    expect(pinProblem("docker://alpine:3.20")).toMatch(/sha256/);
    expect(pinProblem(`docker://alpine@sha256:${"a".repeat(64)}`)).toBeNull();
  });
});

describe("findUnpinned", () => {
  it("reports each unpinned step with its line, and skips comments and scripts", () => {
    const yaml = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      `      - uses: pnpm/action-setup@${SHA} # v4`,
      "      - name: Atlas",
      "        uses: ariga/setup-atlas@v0",
      "      # - uses: docker/login-action@v3",
      "      - run: echo 'the step uses: nothing'",
      "      - uses: 'swatinem/rust-cache@v2'",
    ].join("\n");
    expect(findUnpinned(yaml)).toEqual([
      {
        line: 7,
        ref: "ariga/setup-atlas@v0",
        problem: 'version "v0" is not a 40-character commit SHA',
      },
      {
        line: 10,
        ref: "swatinem/rust-cache@v2",
        problem: 'version "v2" is not a 40-character commit SHA',
      },
    ]);
  });
});

describe("workflowFiles", () => {
  it("finds workflows and nested composite actions", () => {
    const root = mkdtempSync(join(tmpdir(), "action-pins-"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, ".github", "actions", "setup", "inner"), {
      recursive: true,
    });
    writeFileSync(join(root, ".github", "workflows", "ci.yml"), "");
    writeFileSync(join(root, ".github", "workflows", "notes.md"), "");
    writeFileSync(
      join(root, ".github", "actions", "setup", "inner", "action.yml"),
      "",
    );
    const found = workflowFiles(root).map((path) => path.slice(root.length));
    expect(found).toEqual([
      "/.github/actions/setup/inner/action.yml",
      "/.github/workflows/ci.yml",
    ]);
  });
});

describe("this repository", () => {
  it("pins every third-party action it runs", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const unpinned = workflowFiles(repoRoot).flatMap((file) =>
      findUnpinned(readFileSync(file, "utf8")).map(
        (hit) => `${file.slice(repoRoot.length + 1)}:${hit.line} ${hit.ref}`,
      ),
    );
    expect(unpinned).toEqual([]);
  });
});
