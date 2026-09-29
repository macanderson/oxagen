import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { CODE_WORKFLOWS_DIR, loadWorkflows, STEERING_WORKFLOWS_DIR, selectWorkflowFiles } from "./source";

const FIXTURES = fileURLToPath(new URL("../../fixtures/workflows/", import.meta.url));

describe("selectWorkflowFiles", () => {
  it("reads the steering repo once it holds a file under work/workflows/", () => {
    const selection = selectWorkflowFiles({
      steering: ["work/workflows/fix-test-verify-review.toml", "README.md"],
      code: [".oxagen/workflows/fix-validate-document-review.toml"],
    });
    expect(selection).toEqual({
      source: "steering",
      files: [{ path: "work/workflows/fix-test-verify-review.toml", slug: "fix-test-verify-review" }],
      skipped: [],
    });
  });

  it("reads the code repository's .oxagen/workflows/ until then", () => {
    const selection = selectWorkflowFiles({
      steering: ["work/rules/tests.md"],
      code: [".oxagen/workflows/fix-validate-document-review.toml", "src/index.ts"],
    });
    expect(selection).toEqual({
      source: "code",
      files: [{ path: ".oxagen/workflows/fix-validate-document-review.toml", slug: "fix-validate-document-review" }],
      skipped: [],
    });
  });

  it("reads nothing when neither repository holds a workflow directory", () => {
    const empty = { source: "none", files: [], skipped: [] };
    expect(selectWorkflowFiles({ steering: [], code: ["src/index.ts"] })).toEqual(empty);
    expect(selectWorkflowFiles({ steering: ["work/rules/tests.md"], code: null })).toEqual(empty);
  });

  it("chooses the steering repo on any path under its directory, even one it then skips", () => {
    const selection = selectWorkflowFiles({
      steering: ["work/workflows/README.md"],
      code: [".oxagen/workflows/fix.toml"],
    });
    expect(selection).toEqual({ source: "steering", files: [], skipped: [] });
  });

  it("sorts the files, drops repeats, ignores subdirectories and other file types, and skips names that are not slugs", () => {
    const selection = selectWorkflowFiles({
      steering: [
        `${STEERING_WORKFLOWS_DIR}triage.toml`,
        `${STEERING_WORKFLOWS_DIR}Fix Bugs.toml`,
        `${STEERING_WORKFLOWS_DIR}archive/old.toml`,
        `${STEERING_WORKFLOWS_DIR}notes.md`,
        `${STEERING_WORKFLOWS_DIR}fix.toml`,
        `${STEERING_WORKFLOWS_DIR}triage.toml`,
        `${STEERING_WORKFLOWS_DIR}.toml`,
      ],
      code: null,
    });
    expect(selection).toEqual({
      source: "steering",
      files: [
        { path: "work/workflows/fix.toml", slug: "fix" },
        { path: "work/workflows/triage.toml", slug: "triage" },
      ],
      skipped: ["work/workflows/.toml", "work/workflows/Fix Bugs.toml"],
    });
  });

  it("names the two directories the spec gives", () => {
    expect(STEERING_WORKFLOWS_DIR).toBe("work/workflows/");
    expect(CODE_WORKFLOWS_DIR).toBe(".oxagen/workflows/");
  });
});

describe("loadWorkflows", () => {
  const fixture = (file: string): string => readFileSync(join(FIXTURES, file), "utf8");

  it("loads each good file and keeps each bad file's problems, in order", () => {
    const loaded = loadWorkflows(
      [
        {
          path: ".oxagen/workflows/fix-test-verify-review.toml",
          slug: "fix-test-verify-review",
          text: fixture("fix-test-verify-review.toml"),
        },
        { path: ".oxagen/workflows/broken.toml", slug: "broken", text: 'schema = "oxagen-workflow/v0.1"\nname = [' },
        { path: ".oxagen/workflows/empty.toml", slug: "empty", text: 'schema = "oxagen-workflow/v0.2"\nname = "Empty"\n' },
        {
          path: ".oxagen/workflows/fix-validate-document-review.toml",
          slug: "fix-validate-document-review",
          text: fixture("fix-validate-document-review.v0.1.toml"),
        },
      ],
      parseToml,
    );
    expect(loaded.workflows.map((workflow) => [workflow.slug, workflow.schema])).toEqual([
      ["fix-test-verify-review", "oxagen-workflow/v0.3"],
      ["fix-validate-document-review", "oxagen-workflow/v0.1"],
    ]);
    expect(loaded.failed).toHaveLength(2);
    const [broken, empty] = loaded.failed;
    expect(broken?.path).toBe(".oxagen/workflows/broken.toml");
    expect(broken?.problems).toHaveLength(1);
    expect(broken?.problems[0]?.code).toBe("not_toml");
    expect(broken?.problems[0]?.path).toBe("");
    expect(broken?.problems[0]?.message.startsWith("The file is not TOML: ")).toBe(true);
    expect(empty).toEqual({
      path: ".oxagen/workflows/empty.toml",
      problems: [{ code: "missing_key", path: "stage", message: "stage is required." }],
    });
  });

  it("quotes the parser's error message, or the thrown value when it is not an Error", () => {
    const files = [{ path: "work/workflows/fix.toml", slug: "fix", text: "" }];
    const byError = loadWorkflows(files, () => {
      throw new Error("Unexpected end of input at line 3");
    });
    expect(byError).toEqual({
      workflows: [],
      failed: [
        {
          path: "work/workflows/fix.toml",
          problems: [{ code: "not_toml", path: "", message: "The file is not TOML: Unexpected end of input at line 3" }],
        },
      ],
    });
    const byValue = loadWorkflows(files, () => {
      throw "bad key";
    });
    expect(byValue.failed[0]?.problems[0]?.message).toBe("The file is not TOML: bad key");
  });

  it("returns empty lists for no files", () => {
    expect(loadWorkflows([], parseToml)).toEqual({ workflows: [], failed: [] });
  });
});
