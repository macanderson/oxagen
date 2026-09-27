import { describe, expect, it } from "vitest";
import { CONTEXT_RECORD_LINEAGE } from "@oxagen/oxagen/context-record-label";
import {
  classifySteeringRepoPath,
  recordLineageFromPath,
} from "@oxagen/oxagen/steering-repo/paths";
import {
  MEMORY_LINEAGE_MAX,
  memoryArea,
  memoryDescription,
  memoryLabel,
  memoryLineage,
  memoryRecordPath,
  memoryShard,
} from "./naming";

describe("memoryLineage", () => {
  it("slugs the statement's words, leaving out grammar", () => {
    expect(memoryLineage("Run the migration generator after a schema edit.", new Set())).toBe(
      "run-migration-generator-after-schema-edit",
    );
  });

  it("stays within 64 characters and ends on a whole word", () => {
    const lineage = memoryLineage(
      "Regenerate the checksum with atlas migrate hash from packages database after editing any migration file whatsoever",
      new Set(),
    );
    expect(lineage.length).toBeLessThanOrEqual(MEMORY_LINEAGE_MAX);
    expect(lineage).toMatch(CONTEXT_RECORD_LINEAGE);
    expect(lineage.endsWith("-")).toBe(false);
  });

  it("takes the first free numbered lineage on a clash", () => {
    const taken = new Set(["push-main", "push-main-2"]);
    expect(memoryLineage("Push to main", taken)).toBe("push-main-3");
  });

  it("keeps a numbered lineage within 64 characters", () => {
    const statement = "word ".repeat(40);
    const first = memoryLineage(statement, new Set());
    const second = memoryLineage(statement, new Set([first]));
    expect(second.length).toBeLessThanOrEqual(MEMORY_LINEAGE_MAX);
    expect(second.endsWith("-2")).toBe(true);
    expect(second).toMatch(CONTEXT_RECORD_LINEAGE);
  });

  it("names a statement with no file-safe words memory", () => {
    expect(memoryLineage("日本語", new Set())).toBe("memory");
    expect(memoryLineage("the a", new Set())).toBe("memory");
    expect(memoryLineage("x", new Set())).toBe("memory-x");
  });
});

describe("memoryLabel", () => {
  it("cuts the first sentence to 36 characters at a word", () => {
    const label = memoryLabel("Regenerate the Atlas checksum after every migration edit. It fails CI otherwise.");
    expect(label.length).toBeLessThanOrEqual(36);
    expect(label).toBe("Regenerate the Atlas checksum after");
  });

  it("keeps a short sentence whole, without its full stop", () => {
    expect(memoryLabel("Use pnpm.")).toBe("Use pnpm");
  });

  it("falls back to Memory for a statement with nothing to label", () => {
    expect(memoryLabel("...")).toBe("Memory");
  });
});

describe("memoryDescription", () => {
  it("keeps a statement of 200 characters or fewer", () => {
    expect(memoryDescription("  Use pnpm,\n not npm. ")).toBe("Use pnpm, not npm.");
  });

  it("cuts a longer statement at a word and marks the cut", () => {
    const description = memoryDescription(`${"lesson ".repeat(40)}end`);
    expect(description.length).toBeLessThanOrEqual(200);
    expect(description.endsWith("lesson...")).toBe(true);
  });
});

describe("memoryArea", () => {
  it("takes the deepest fixed folder of the first applies_to glob", () => {
    expect(memoryArea(["src/billing/**", "docs/**"], null)).toBe("billing");
    expect(memoryArea(["apps/app/src/features/shell/*.tsx"], null)).toBe("shell");
    expect(memoryArea(["packages/database/atlas/migrations"], null)).toBe("migrations");
  });

  it("does not take a file name for a folder", () => {
    expect(memoryArea(["packages/database/atlas.sum"], null)).toBe("database");
  });

  it("falls to the first tool's server when the glob fixes no folder", () => {
    expect(memoryArea(["**/*.ts"], ["billing__create_refund"])).toBe("billing");
    expect(memoryArea(null, ["github_mcp__*"])).toBe("github-mcp");
  });

  it("falls to general when nothing names an area", () => {
    expect(memoryArea(["README.md"], null)).toBe("general");
    expect(memoryArea(null, null)).toBe("general");
    expect(memoryArea([], [])).toBe("general");
  });
});

describe("memoryRecordPath", () => {
  it("files a repository memory under the repository and its area", () => {
    const path = memoryRecordPath(["github.com/acme/api"], ["src/billing/**"], null, "run-tests");
    expect(path).toBe("steering/memory/github.com/acme/api/billing/run-tests.md");
    expect(classifySteeringRepoPath(path)).toBe("record");
    expect(recordLineageFromPath(path)).toBe("run-tests");
  });

  it("files a memory with no repository under workspace", () => {
    expect(memoryRecordPath(null, null, null, "run-tests")).toBe(
      "steering/memory/workspace/general/run-tests.md",
    );
  });
});

describe("memoryShard", () => {
  it("is the first repository, or workspace", () => {
    expect(memoryShard(["github.com/acme/api", "github.com/acme/web"])).toBe("github.com/acme/api");
    expect(memoryShard(null)).toBe("workspace");
  });
});
